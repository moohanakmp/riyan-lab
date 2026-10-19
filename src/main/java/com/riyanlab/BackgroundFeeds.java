package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.stereotype.Component;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;

@Component
public class BackgroundFeeds {
    private final MarketDataController market;
    private final ObjectMapper json;
    private final HttpClient client;
    private final MetalHistory metals;
    private JsonNode calendar;
    private long calendarAt=0,nextCalendar=0;
    private String calendarError="Not checked yet";
    @org.springframework.beans.factory.annotation.Autowired
    public BackgroundFeeds(MarketDataController market,ObjectMapper json){this(market,json,HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build());}
    BackgroundFeeds(MarketDataController market,ObjectMapper json,HttpClient client){this.market=market;this.json=json;this.client=client;this.metals=new MetalHistory(null,market,json);}
    private JsonNode get(String url)throws Exception{
        var response=market.publicData(url);
        if(!response.getStatusCode().is2xxSuccessful())throw new IllegalStateException("Provider unavailable: "+response.getBody());
        return json.readTree(response.getBody());
    }
    public synchronized Map<String,Object> calendar(){
        long now=System.currentTimeMillis();
        if(now>=nextCalendar){
            nextCalendar=now+300000;
            // Same fixed calendar sources as the app; stop on explicit rate limits.
            for(String url:List.of("https://nfs.faireconomy.media/ff_calendar_thisweek.json",
                    "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
                    "https://r.jina.ai/https://nfs.faireconomy.media/ff_calendar_thisweek.json")){
                try{
                    var request=HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(8))
                        .header("User-Agent","RiyanLabCalendar/1.0").GET().build();
                    var response=client.send(request,HttpResponse.BodyHandlers.ofString());
                    if(response.statusCode()==429){nextCalendar=now+900000;calendarError="Calendar rate limited (HTTP 429)";break;}
                    if(response.statusCode()!=200){calendarError="Calendar unavailable (HTTP "+response.statusCode()+")";continue;}
                    String body=response.body();
                    if(body.length()>1_000_000)throw new IllegalArgumentException("Calendar response too large");
                    int first=body.indexOf('['),last=body.lastIndexOf(']');
                    if(first<0||last<first)throw new IllegalArgumentException("Invalid calendar JSON");
                    JsonNode data=json.readTree(body.substring(first,last+1));
                    if(!data.isArray()||data.isEmpty())throw new IllegalArgumentException("Empty calendar");
                    boolean recent=false;
                    for(var ev:data){
                        long at=OffsetDateTime.parse(ev.path("date").asText()).toInstant().toEpochMilli();
                        if(at>=now-86400000L&&at<=now+8*86400000L)recent=true;
                    }
                    if(!recent)throw new IllegalArgumentException("Calendar belongs to an older week");
                    calendar=data;calendarAt=now;calendarError="";break;
                }catch(Exception e){calendarError="Calendar unavailable: "+e.getClass().getSimpleName();}
            }
        }
        if(calendar==null||now-calendarAt>=1800000)return Map.of("calendarAt",0,"calendarError",calendarError);
        return Map.of("calendar",calendar,"calendarAt",calendarAt,"calendarError",calendarError);
    }
    public ObjectNode snapshot(){
        ObjectNode out=json.createObjectNode();
        try(var pool=Executors.newFixedThreadPool(3)){
            var jobs=new LinkedHashMap<String,Future<ObjectNode>>();
            for(String sym:List.of("XAUUSD","XAGUSD","BTCUSD"))jobs.put(sym,pool.submit(()->instrument(sym)));
            jobs.forEach((sym,f)->{try{out.set(sym,f.get(65,TimeUnit.SECONDS));}catch(Exception e){f.cancel(true);out.set(sym,json.createObjectNode().put("error","Market snapshot timed out"));}});
        }
        return out;
    }
    private ObjectNode instrument(String sym){
        var out=json.createObjectNode();var bars=out.putObject("bars");
        boolean btc=sym.equals("BTCUSD");
        out.put("source",btc?"Coinbase BTC/USD":"OKX "+(sym.equals("XAUUSD")?"XAU":"XAG")+"/USDT perp");
        try{
            for(String tf:List.of("5m","15m","1h","4h")){
                if(btc&&tf.equals("4h")){bars.set(tf,aggregate(bars.path("1h"),4));continue;}
                int minutes=Map.of("5m",5,"15m",15,"1h",60,"4h",240).get(tf);
                int count=tf.equals("15m")?700:tf.equals("1h")?(btc?400:300):300;
                ArrayNode normalized;
                if(btc){
                    long until=Math.floorDiv(System.currentTimeMillis(),minutes*60000L)*minutes*60000L;
                    var raw=json.createArrayNode();long cursor=until;
                    for(int remaining=count;remaining>0;remaining-=300){
                        long from=cursor-Math.min(remaining,300)*minutes*60000L;
                        var response=get("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity="+(minutes*60)+"&start="+Instant.ofEpochMilli(from)+"&end="+Instant.ofEpochMilli(cursor-1000));
                        if(!response.isArray())throw new IllegalStateException("Invalid Coinbase history");
                        response.forEach(raw::add);cursor=from;
                    }
                    normalized=normalize(raw,minutes*60000L,System.currentTimeMillis(),true,json);
                }else{
                    normalized=metals.candles(sym,tf,count);
                }
                if(tf.equals("5m"))out.set("five",normalized);else bars.set(tf,normalized);
            }
        }catch(Exception e){out.put("error",safeError(e));}
        // Quote is fetched last, so history loading cannot silently make it stale.
        try{
            var q=get(btc?"https://api.exchange.coinbase.com/products/BTC-USD/ticker":"https://api.gold-api.com/price/"+(sym.equals("XAUUSD")?"XAU":"XAG"));
            double price=q.path("price").asDouble(Double.NaN);long now=System.currentTimeMillis();
            long at=btc?Instant.parse(q.path("time").asText()).toEpochMilli():now;
            if(!Double.isFinite(price)||price<=0||now-at>=30000||at>now+5000)throw new IllegalStateException("Quote stale or invalid");
            out.put("price",price).put("quoteAt",at);
            if(!btc){
                // Same spot scaling used by the existing browser Low Profit feed.
                var five=out.path("five");if(!five.isEmpty()){
                    double ratio=price/five.path(five.size()-1).path("c").asDouble();
                    if(ratio<=.9||ratio>=1.1){out.remove("five");out.put("error","Quote / candle mismatch exceeds 10%");}
                    else for(var k:five)for(String key:List.of("o","h","l","c"))((ObjectNode)k).put(key,k.path(key).asDouble()*ratio);
                }
            }
        }catch(Exception e){out.put("error",safeError(e));}
        return out;
    }
    private String safeError(Exception e){return e.getMessage()==null?"Market data unavailable":e.getMessage().substring(0,Math.min(240,e.getMessage().length()));}
    static ArrayNode normalize(JsonNode raw,long ms,long now,boolean coinbase,ObjectMapper json){
        var sorted=new TreeMap<Long,ObjectNode>();
        if(!raw.isArray())throw new IllegalArgumentException("Invalid candle response");
        for(var r:raw){
            if(!r.isArray()||r.size()<6)throw new IllegalArgumentException("Malformed candle");
            long t=r.path(0).asLong(-1)*(coinbase?1000:1);double o=r.path(coinbase?3:1).asDouble(Double.NaN),h=r.path(coinbase?2:2).asDouble(Double.NaN),l=r.path(coinbase?1:3).asDouble(Double.NaN),c=r.path(4).asDouble(Double.NaN),v=r.path(5).asDouble(Double.NaN);
            if(t<=0||t%ms!=0||!Double.isFinite(o+h+l+c+v)||Math.min(Math.min(o,h),Math.min(l,c))<=0||v<0||h<Math.max(o,Math.max(c,l))||l>Math.min(o,Math.min(c,h)))throw new IllegalArgumentException("Invalid OHLC");
            if(t+ms>now)continue;
            var k=json.createObjectNode().put("t",t).put("ms",ms).put("o",o).put("h",h).put("l",l).put("c",c).put("v",v).put("complete",true);
            if(sorted.containsKey(t)&&!sorted.get(t).equals(k))throw new IllegalArgumentException("Conflicting candle");
            sorted.put(t,k);
        }
        var out=json.createArrayNode();sorted.values().forEach(out::add);return out;
    }
    ArrayNode aggregate(JsonNode bars,int hours){
        var out=json.createArrayNode();long ms=hours*3600000L;var groups=new TreeMap<Long,List<JsonNode>>();
        for(var k:bars)groups.computeIfAbsent(Math.floorDiv(k.path("t").asLong(),ms)*ms,x->new ArrayList<>()).add(k);
        groups.forEach((t,ks)->{
            if(ks.size()!=hours)return;
            for(int i=0;i<hours;i++)if(ks.get(i).path("t").asLong()!=t+i*3600000L)return;
            var k=json.createObjectNode().put("t",t).put("ms",ms).put("o",ks.getFirst().path("o").asDouble()).put("c",ks.getLast().path("c").asDouble()).put("complete",true);
            k.put("h",ks.stream().mapToDouble(x->x.path("h").asDouble()).max().orElseThrow());k.put("l",ks.stream().mapToDouble(x->x.path("l").asDouble()).min().orElseThrow());k.put("v",ks.stream().mapToDouble(x->x.path("v").asDouble()).sum());out.add(k);
        });return out;
    }
}
