package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Server-side order flow collector (display only, never used for paper entries).
 * Streams every gold, silver and bitcoin trade with its real taker side, builds one-minute
 * footprint buckets and stores them in PostgreSQL, so the footprint keeps filling whether or
 * not a browser has the Volume Trap tab (or that symbol) open.
 *
 * Gaps: when the stream drops or the service was asleep, missed minutes are rebuilt from the
 * exchange's own trade history (OKX history-trades, Coinbase trades), paged by trade id so no
 * trade is counted twice. Minutes that could not be rebuilt stay marked partial.
 */
@Service
public class OrderFlowCollector {
    static final long MIN=60_000L;
    static final List<String> SYMBOLS=List.of("XAUUSD","XAGUSD","BTCUSD");
    static final Map<String,String> OKX_INST=Map.of("XAUUSD","XAU-USDT-SWAP","XAGUSD","XAG-USDT-SWAP");
    static final Map<String,Double> TICK=Map.of("XAUUSD",0.01,"XAGUSD",0.001,"BTCUSD",1.0);
    static final long VIEW_MS=90*MIN;
    interface Http{String get(String url)throws Exception;}
    interface Handler{void accept(String text)throws Exception;}

    static final class Minute{
        final long t;double o,h,l,c,buy,sell;long first=Long.MAX_VALUE,last=Long.MIN_VALUE,firstOrd,lastOrd;int n;boolean partial,dirty,closeSent;long rev;
        final TreeMap<Double,double[]> cells=new TreeMap<>();
        Minute(long t,boolean partial){this.t=t;this.partial=partial;}
        void add(long ts,long ord,double px,double sz,boolean takerBuy,double tick){
            if(n==0){o=h=l=c=px;}
            if(ts<first||(ts==first&&ord<firstOrd)){first=ts;firstOrd=ord;o=px;}
            if(ts>last||(ts==last&&ord>=lastOrd)){last=ts;lastOrd=ord;c=px;}
            h=Math.max(h,px);l=Math.min(l,px);n++;
            double k=Math.round(Math.floor(px/tick+1e-9)*tick*1e6)/1e6;
            double[] cell=cells.computeIfAbsent(k,x->new double[2]);
            if(takerBuy){cell[0]+=sz;buy+=sz;}else{cell[1]+=sz;sell+=sz;}
        }
    }
    static final class Book{
        final String sym;final double tick;final TreeMap<Long,Minute> mins=new TreeMap<>();
        double ctVal;boolean live;long connectedAt,lastTradeAt;
        long firstId=-1,firstMinute=-1;      // first stream trade of the current connection
        long verifiedFrom,verifiedUpTo;      // minutes in [from, upTo) are covered: absent = no trades
        boolean needBackfill=true;long backfillRetryAt;String backfill="waiting for stream";long backfillAt,backfillFrom;
        Book(String sym){this.sym=sym;this.tick=TICK.get(sym);this.ctVal=sym.equals("BTCUSD")?1:0;}
    }
    record Trade(long id,long ts,double px,double sz,boolean buy){}

    private final JdbcTemplate jdbc;private final ObjectMapper json;private final Http http;
    final Map<String,Book> books=new LinkedHashMap<>();
    private final AtomicLong rev=new AtomicLong();
    final String boot=UUID.randomUUID().toString().substring(0,8);
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    private volatile long ctRetryAt;
    private ScheduledExecutorService ticker;private ExecutorService filler;
    private final Map<String,Conn> conns=new LinkedHashMap<>();
    java.util.function.LongSupplier clock=System::currentTimeMillis; // injectable for tests
    long backfillMs=6*3600_000L,memoryMs=6*3600_000L+VIEW_MS,pageDelayMs=150;
    @Value("${app.orderflow.enabled:true}") boolean enabled=true;
    @Value("${app.orderflow.backfill-hours:6}") void backfillHours(int h){backfillMs=Math.max(1,Math.min(12,h))*3600_000L;memoryMs=backfillMs+VIEW_MS;}

    @org.springframework.beans.factory.annotation.Autowired
    public OrderFlowCollector(JdbcTemplate jdbc,ObjectMapper json){this(jdbc,json,null);}
    OrderFlowCollector(JdbcTemplate jdbc,ObjectMapper json,Http http){
        this.jdbc=jdbc;this.json=json;
        this.http=http!=null?http:url->{
            var r=client.send(HttpRequest.newBuilder(URI.create(url)).header("User-Agent","RiyanLab/1.0 order-flow").header("Accept","application/json").timeout(Duration.ofSeconds(10)).GET().build(),HttpResponse.BodyHandlers.ofString());
            if(r.statusCode()!=200)throw new IllegalStateException("HTTP "+r.statusCode());
            return r.body();
        };
        for(String s:SYMBOLS)books.put(s,new Book(s));
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────
    @EventListener(ApplicationReadyEvent.class)
    public void start(){
        if(!enabled||ticker!=null)return;
        try{load();}catch(Exception e){log("Order flow history load failed: "+e.getMessage());}
        ticker=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"order-flow");t.setDaemon(true);return t;});
        filler=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"order-flow-backfill");t.setDaemon(true);return t;});
        conns.put("okx",new Conn("okx","wss://ws.okx.com:8443/ws/v5/public",List.of("XAUUSD","XAGUSD")));
        conns.put("coinbase",new Conn("coinbase","wss://ws-feed.exchange.coinbase.com",List.of("BTCUSD")));
        ticker.scheduleWithFixedDelay(this::tick,1,5,TimeUnit.SECONDS);
        ticker.scheduleWithFixedDelay(this::flushSafe,15,10,TimeUnit.SECONDS);
        ticker.scheduleWithFixedDelay(this::prune,5,60,TimeUnit.MINUTES);
        log("Order flow collector started (backfill "+backfillMs/3600_000L+"h)");
    }
    @PreDestroy public void stop(){
        if(ticker==null)return;
        for(Conn c:conns.values()){var ws=c.ws;c.ws=null;if(ws!=null)ws.abort();}
        ticker.shutdownNow();filler.shutdownNow();
        for(Book b:books.values())synchronized(b){disconnected(b,clock.getAsLong());}
        flushSafe();
    }
    void tick(){
        long now=clock.getAsLong();
        try{
            // A minute that closes without a later trade must still reach browsers as final.
            for(Book b:books.values())synchronized(b){for(Minute m:b.mins.tailMap(Math.floorDiv(now-VIEW_MS,MIN)*MIN).values())
                if(!m.closeSent&&m.t+MIN<=now){m.closeSent=true;m.rev=rev.incrementAndGet();}}
            for(Conn c:conns.values())c.check(now);
            if(filler!=null&&now>=ctRetryAt&&books.values().stream().anyMatch(x->x.ctVal<=0)){ctRetryAt=now+60_000;filler.execute(()->books.values().forEach(this::loadContractSize));}
            for(Book b:books.values()){
                boolean due;synchronized(b){due=b.needBackfill&&b.firstId>=0&&now>=b.backfillRetryAt;if(due)b.backfillRetryAt=Long.MAX_VALUE;}
                if(due&&filler!=null)filler.execute(()->backfill(b));
            }
        }catch(Exception e){log("Order flow tick failed: "+e);}
    }

    // ── Live stream ──────────────────────────────────────────────────────────
    final class Conn{
        final String name,url;final List<String> syms;volatile WebSocket ws;volatile boolean connecting;volatile long lastMsg,retryAt,lastPing;int failures;
        Conn(String name,String url,List<String> syms){this.name=name;this.url=url;this.syms=syms;}
        void check(long now){
            var w=ws;
            if(w==null){if(!connecting&&now>=retryAt)connect();return;}
            if(now-lastMsg>60_000){log("Order flow "+name+" stream silent for 60s; reconnecting");w.abort();closed(w);return;}
            if(name.equals("okx")&&now-lastPing>=20_000){lastPing=now;try{w.sendText("ping",true);}catch(Exception ignored){}}
        }
        void connect(){
            connecting=true;
            client.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(10)).buildAsync(URI.create(url),listener(this,name.equals("okx")?OrderFlowCollector.this::onOkx:OrderFlowCollector.this::onCoinbase))
                .whenComplete((w,e)->{
                    connecting=false;
                    if(e!=null){failures++;retryAt=clock.getAsLong()+Math.min(60_000,2_000L<<Math.min(5,failures));log("Order flow "+name+" connect failed: "+e.getMessage());return;}
                    ws=w;failures=0;lastMsg=clock.getAsLong();log("Order flow "+name+" stream connected");
                    String sub=name.equals("okx")
                        ?"{\"op\":\"subscribe\",\"args\":[{\"channel\":\"trades\",\"instId\":\"XAU-USDT-SWAP\"},{\"channel\":\"trades\",\"instId\":\"XAG-USDT-SWAP\"}]}"
                        :"{\"type\":\"subscribe\",\"product_ids\":[\"BTC-USD\"],\"channels\":[\"matches\"]}";
                    w.sendText(sub,true);
                });
        }
        void closed(WebSocket w){
            if(ws!=w)return;
            ws=null;failures++;retryAt=clock.getAsLong()+Math.min(60_000,1_000L<<Math.min(5,failures));
            long now=clock.getAsLong();
            for(String s:syms){Book b=books.get(s);synchronized(b){disconnected(b,now);}}
        }
    }
    private WebSocket.Listener listener(Conn c,Handler handler){
        return new WebSocket.Listener(){
            final StringBuilder buf=new StringBuilder();
            @Override public void onOpen(WebSocket w){w.request(1);}
            @Override public CompletionStage<?> onText(WebSocket w,CharSequence data,boolean last){
                buf.append(data);
                if(last){String s=buf.toString();buf.setLength(0);c.lastMsg=clock.getAsLong();
                    try{handler.accept(s);}catch(Exception e){log("Order flow "+c.name+" message skipped: "+e.getMessage());}}
                w.request(1);return null;
            }
            @Override public CompletionStage<?> onClose(WebSocket w,int code,String reason){c.closed(w);return null;}
            @Override public void onError(WebSocket w,Throwable e){log("Order flow "+c.name+" stream error: "+e.getMessage());c.closed(w);}
        };
    }
    void onOkx(String text)throws Exception{
        if("pong".equals(text))return;
        JsonNode m=json.readTree(text);
        String inst=m.path("arg").path("instId").asText();
        String sym=OKX_INST.entrySet().stream().filter(e->e.getValue().equals(inst)).map(Map.Entry::getKey).findFirst().orElse(null);
        if(sym==null)return;
        Book b=books.get(sym);
        if("subscribe".equals(m.path("event").asText())){synchronized(b){connected(b,clock.getAsLong());}return;}
        if(!"trades".equals(m.path("arg").path("channel").asText()))return;
        for(JsonNode x:m.path("data")){
            long id=x.path("tradeId").asLong(-1),count=Math.max(1,x.path("count").asLong(1));
            onTrade(b,id-count+1,id,x.path("ts").asLong(),x.path("px").asDouble(),x.path("sz").asDouble(),"buy".equals(x.path("side").asText()));
        }
    }
    void onCoinbase(String text)throws Exception{
        JsonNode m=json.readTree(text);Book b=books.get("BTCUSD");
        switch(m.path("type").asText()){
            case "subscriptions"->{synchronized(b){connected(b,clock.getAsLong());}}
            case "match"->{
                if(!"BTC-USD".equals(m.path("product_id").asText()))return;
                long id=m.path("trade_id").asLong(-1);
                // Coinbase "side" is the maker side: a sell maker means the taker bought.
                onTrade(b,id,id,java.time.Instant.parse(m.path("time").asText()).toEpochMilli(),m.path("price").asDouble(),m.path("size").asDouble(),"sell".equals(m.path("side").asText()));
            }
            case "error"->log("Order flow coinbase error: "+m.path("message").asText());
            default->{}
        }
    }
    void connected(Book b,long now){b.live=true;b.connectedAt=now;b.firstId=-1;b.firstMinute=-1;}
    void disconnected(Book b,long now){
        if(!b.live&&b.firstId<0)return;
        // Once history was filled for this connection, every minute before this one was fully
        // streamed; this one is missing its later trades.
        long cur=Math.floorDiv(now,MIN)*MIN;
        if(!b.needBackfill&&b.firstId>=0)b.verifiedUpTo=Math.max(b.verifiedUpTo,cur);
        b.live=false;b.firstId=-1;b.firstMinute=-1;b.needBackfill=true;b.backfillRetryAt=0;
        Minute m=b.mins.get(cur);if(m!=null&&!m.partial){m.partial=true;touch(m);}
    }
    void onTrade(Book b,long idLow,long id,long ts,double px,double sz,boolean takerBuy){
        if(id<0||ts<=0||!(px>0)||!(sz>0)||!Double.isFinite(px)||!Double.isFinite(sz))return;
        long t=Math.floorDiv(ts,MIN)*MIN;
        synchronized(b){
            if(b.firstId<0){
                // First trade after (re)connecting: this minute missed earlier trades. Start it
                // clean (it is rebuilt from trade history below), so nothing is counted twice.
                b.live=true;b.firstId=idLow;b.firstMinute=t;
                if(b.connectedAt==0)b.connectedAt=clock.getAsLong();
                if(b.mins.containsKey(t))b.mins.put(t,new Minute(t,true));
            }
            if(t<b.firstMinute)return;
            Minute m=b.mins.computeIfAbsent(t,k->new Minute(k,k==b.firstMinute&&b.needBackfill));
            m.add(ts,id,px,sz,takerBuy,b.tick);touch(m);
            b.lastTradeAt=Math.max(b.lastTradeAt,ts);
        }
    }
    private void touch(Minute m){m.rev=rev.incrementAndGet();m.dirty=true;}

    // ── Gap fill from exchange trade history ─────────────────────────────────
    void backfill(Book b){
        long stopId,connectMin,from,now=clock.getAsLong();
        synchronized(b){
            if(!b.needBackfill||b.firstId<0){b.backfillRetryAt=0;return;}
            stopId=b.firstId;connectMin=b.firstMinute;
            long windowStart=Math.floorDiv(now-backfillMs,MIN)*MIN;from=connectMin;
            for(long t=connectMin-MIN;t>=windowStart;t-=MIN){Minute m=b.mins.get(t);if(m==null?t<b.verifiedFrom||t>=b.verifiedUpTo:m.partial)from=t;}
            b.backfill="filling";b.backfillFrom=from;
        }
        boolean btc=b.sym.equals("BTCUSD");
        var built=new HashMap<Long,Minute>();var connectTrades=new ArrayList<Trade>();
        long cursor=stopId,oldest=Long.MAX_VALUE,appliedDownTo=connectMin;boolean reached=false,merged=false;
        try{
            for(int page=0;page<3000&&!reached;page++){
                var batch=btc?coinbasePage(cursor):okxPage(OKX_INST.get(b.sym),cursor);
                if(batch.isEmpty())reached=true; // reached the start of the exchange's history
                else{
                    long minId=cursor;
                    for(Trade x:batch){
                        if(x.id()>=cursor)continue;
                        minId=Math.min(minId,x.id());oldest=Math.min(oldest,x.ts());
                        if(x.ts()<from)continue;
                        long t=Math.floorDiv(x.ts(),MIN)*MIN;
                        if(t==connectMin)connectTrades.add(x);
                        else if(t<connectMin)built.computeIfAbsent(t,k->new Minute(k,false)).add(x.ts(),x.id(),x.px(),x.sz(),x.buy(),b.tick);
                    }
                    if(minId>=cursor)throw new IllegalStateException("trade history did not advance");
                    cursor=minId;if(oldest<from)reached=true;
                }
                // Apply what is already complete (newest first) so the chart fills while paging.
                long coveredFrom=reached?from:Math.floorDiv(oldest,MIN)*MIN+MIN;
                if(reached||page%10==9){
                    var r=apply(b,stopId,connectMin,coveredFrom,appliedDownTo,built,merged?List.of():connectTrades);
                    if(r==null){synchronized(b){b.backfillRetryAt=0;}return;} // reconnected meanwhile
                    if(coveredFrom<=connectMin)merged=true;appliedDownTo=Math.min(appliedDownTo,coveredFrom);
                }
                if(!reached)Thread.sleep(pageDelayMs);
            }
            synchronized(b){
                if(b.firstId!=stopId){b.backfillRetryAt=0;return;}
                b.needBackfill=false;
                b.verifiedFrom=appliedDownTo<=b.verifiedUpTo&&b.verifiedUpTo>b.verifiedFrom?Math.min(b.verifiedFrom,appliedDownTo):appliedDownTo;b.verifiedUpTo=connectMin+MIN;
                b.backfill=reached?"complete":"partly filled";b.backfillAt=clock.getAsLong();b.backfillFrom=appliedDownTo;
            }
            log("Order flow "+b.sym+" gap fill "+(reached?"complete":"partial")+" from "+java.time.Instant.ofEpochMilli(appliedDownTo)+" ("+built.size()+" minutes rebuilt)");
        }catch(InterruptedException e){Thread.currentThread().interrupt();}
        catch(Exception e){
            synchronized(b){b.backfill="retrying: "+Objects.toString(e.getMessage(),"history unavailable");b.backfillRetryAt=clock.getAsLong()+60_000;}
            log("Order flow "+b.sym+" gap fill failed: "+e.getMessage());
        }
    }
    /** Replaces minutes in [coveredFrom, appliedDownTo) with rebuilt ones; merges the connect minute once. */
    private Object apply(Book b,long stopId,long connectMin,long coveredFrom,long appliedDownTo,Map<Long,Minute> built,List<Trade> connectTrades){
        synchronized(b){
            if(b.firstId!=stopId)return null;
            for(long t=appliedDownTo-MIN;t>=coveredFrom;t-=MIN){
                Minute m=built.get(t);
                if(m!=null){b.mins.put(t,m);touch(m);}
                else{Minute old=b.mins.get(t);if(old!=null&&old.partial){old.partial=false;touch(old);}}
            }
            if(coveredFrom<=connectMin){
                Minute m=b.mins.computeIfAbsent(connectMin,k->new Minute(k,false));
                for(Trade x:connectTrades)m.add(x.ts(),x.id(),x.px(),x.sz(),x.buy(),b.tick);
                m.partial=false;touch(m);
            }
            return Boolean.TRUE;
        }
    }
    List<Trade> okxPage(String inst,long before)throws Exception{
        JsonNode r=json.readTree(http.get("https://www.okx.com/api/v5/market/history-trades?instId="+inst+"&type=1&limit=100&after="+before));
        if(!"0".equals(r.path("code").asText())||!r.path("data").isArray())throw new IllegalStateException("OKX trade history rejected");
        var out=new ArrayList<Trade>();
        for(JsonNode x:r.path("data"))out.add(new Trade(x.path("tradeId").asLong(),x.path("ts").asLong(),x.path("px").asDouble(),x.path("sz").asDouble(),"buy".equals(x.path("side").asText())));
        return valid(out);
    }
    List<Trade> coinbasePage(long before)throws Exception{
        JsonNode r=json.readTree(http.get("https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000&after="+before));
        if(!r.isArray())throw new IllegalStateException("Coinbase trade history rejected");
        var out=new ArrayList<Trade>();
        for(JsonNode x:r)out.add(new Trade(x.path("trade_id").asLong(),java.time.Instant.parse(x.path("time").asText()).toEpochMilli(),x.path("price").asDouble(),x.path("size").asDouble(),"sell".equals(x.path("side").asText())));
        return valid(out);
    }
    private static List<Trade> valid(List<Trade> in){
        for(Trade x:in)if(x.id()<=0||x.ts()<=0||!(x.px()>0)||!(x.sz()>0))throw new IllegalStateException("Invalid trade in history");
        return in;
    }
    private void loadContractSize(Book b){
        String inst=OKX_INST.get(b.sym);if(inst==null||b.ctVal>0)return;
        try{
            double v=json.readTree(http.get("https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId="+inst)).path("data").path(0).path("ctVal").asDouble(0);
            if(v>0)synchronized(b){b.ctVal=v;}
        }catch(Exception e){log("Order flow "+b.sym+" contract size unavailable: "+e.getMessage());}
    }

    // ── Storage ──────────────────────────────────────────────────────────────
    void load(){
        if(jdbc==null)return;
        long now=clock.getAsLong(),since=Math.floorDiv(now-memoryMs,MIN)*MIN;
        for(Book b:books.values()){
            var rows=jdbc.queryForList("SELECT t,o,h,l,c,buy,sell,trades,partial,cells::text AS cells FROM order_flow_minutes WHERE symbol=? AND t>=? ORDER BY t",b.sym,since);
            synchronized(b){
                for(var r:rows){
                    Minute m=new Minute(((Number)r.get("t")).longValue(),(Boolean)r.get("partial"));
                    m.o=num(r.get("o"));m.h=num(r.get("h"));m.l=num(r.get("l"));m.c=num(r.get("c"));m.buy=num(r.get("buy"));m.sell=num(r.get("sell"));m.n=((Number)r.get("trades")).intValue();
                    m.first=m.t;m.last=m.t+MIN-1;
                    try{for(JsonNode x:json.readTree((String)r.get("cells")))m.cells.put(x.path(0).asDouble(),new double[]{x.path(1).asDouble(),x.path(2).asDouble()});}catch(Exception ignored){m.partial=true;}
                    m.rev=rev.incrementAndGet();b.mins.put(m.t,m);
                }
                // Stored minutes prove coverage only for the unbroken run ending at the newest
                // complete one (up to 3 quiet minutes allowed); anything older is re-checked.
                Long top=null;for(Minute m:b.mins.descendingMap().values())if(!m.partial){top=m.t;break;}
                if(top!=null){
                    long lo=top;for(Minute m:b.mins.headMap(top,false).descendingMap().values()){if(m.partial||lo-m.t>4*MIN)break;lo=m.t;}
                    b.verifiedFrom=lo;b.verifiedUpTo=top+MIN;
                }
            }
        }
    }
    private static double num(Object o){return ((Number)o).doubleValue();}
    private void flushSafe(){try{flush(clock.getAsLong());}catch(Exception e){log("Order flow save failed: "+e.getMessage());}}
    /** Saves closed minutes that changed. Forming minutes are rebuilt from history after a restart. */
    int flush(long now){
        if(jdbc==null)return 0;
        var args=new ArrayList<Object[]>();var saved=new ArrayList<Minute>();
        for(Book b:books.values())synchronized(b){
            for(Minute m:b.mins.values()){
                if(!m.dirty||m.t+MIN>now)continue;
                var cells=new StringBuilder("[");
                for(var e:m.cells.entrySet()){if(cells.length()>1)cells.append(',');cells.append('[').append(e.getKey()).append(',').append(e.getValue()[0]).append(',').append(e.getValue()[1]).append(']');}
                args.add(new Object[]{b.sym,m.t,m.o,m.h,m.l,m.c,m.buy,m.sell,m.n,m.partial,cells.append(']').toString()});
                m.dirty=false;saved.add(m);
            }
            long cut=now-memoryMs;b.mins.headMap(cut).entrySet().removeIf(e->!e.getValue().dirty);
        }
        if(args.isEmpty())return 0;
        try{
            jdbc.batchUpdate("""
                INSERT INTO order_flow_minutes(symbol,t,o,h,l,c,buy,sell,trades,partial,cells) VALUES(?,?,?,?,?,?,?,?,?,?,?::jsonb)
                ON CONFLICT(symbol,t) DO UPDATE SET o=EXCLUDED.o,h=EXCLUDED.h,l=EXCLUDED.l,c=EXCLUDED.c,buy=EXCLUDED.buy,sell=EXCLUDED.sell,
                  trades=EXCLUDED.trades,partial=EXCLUDED.partial,cells=EXCLUDED.cells,updated_at=now()
                """,args);
        }catch(RuntimeException e){for(Minute m:saved)m.dirty=true;throw e;}
        return args.size();
    }
    private void prune(){
        try{if(jdbc!=null)jdbc.update("DELETE FROM order_flow_minutes WHERE t<?",clock.getAsLong()-3*86_400_000L);}
        catch(Exception e){log("Order flow prune failed: "+e.getMessage());}
    }

    // ── Read API ─────────────────────────────────────────────────────────────
    /** Minutes of the last 90 minutes changed after {@code sinceRev} (all of them for a new boot id). */
    public Map<String,Object> view(String sym,String clientBoot,long sinceRev,long now){
        Book b=books.get(sym);if(b==null)throw new IllegalArgumentException("Unsupported symbol");
        boolean full=!boot.equals(clientBoot);
        var out=new LinkedHashMap<String,Object>();var rows=new ArrayList<Map<String,Object>>();
        synchronized(b){
            for(Minute m:b.mins.tailMap(Math.floorDiv(now-VIEW_MS,MIN)*MIN).values()){
                if(!full&&m.rev<=sinceRev)continue;
                var cells=new ArrayList<double[]>();
                for(var e:m.cells.entrySet())cells.add(new double[]{e.getKey(),e.getValue()[0],e.getValue()[1]});
                var r=new LinkedHashMap<String,Object>();
                r.put("t",m.t);r.put("o",m.o);r.put("h",m.h);r.put("l",m.l);r.put("c",m.c);r.put("buy",m.buy);r.put("sell",m.sell);r.put("n",m.n);
                r.put("partial",m.partial);r.put("final",m.t+MIN<=now);r.put("cells",cells);rows.add(r);
            }
            out.put("boot",boot);out.put("rev",rev.get());out.put("symbol",sym);out.put("enabled",enabled);
            out.put("scale",b.ctVal>0?b.ctVal:null);out.put("live",b.live);out.put("connectedAt",b.connectedAt);out.put("lastTradeAt",b.lastTradeAt);
            out.put("backfill",Map.of("state",b.backfill,"at",b.backfillAt,"from",b.backfillFrom));
            out.put("serverTime",now);out.put("minutes",rows);
        }
        return out;
    }
    private static void log(String s){System.out.println(java.time.Instant.now()+" "+s);}
}
