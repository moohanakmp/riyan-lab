package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * ATLAS, the lead agent. Runs on the server every minute, whether or not any app is open
 * (while Render keeps the service awake).
 *
 * Each IST day it writes a market briefing from the real market snapshot (trend, volatility,
 * 24 h move, today's high-impact news) and assigns the day's tasks to the other agents. Every
 * minute it checks each task against real evidence (scanner status, quotes, calendar, order flow,
 * alert queues, paper risk) and marks it DONE, BLOCKED or SKIPPED with the reason.
 *
 * Rule based, not an AI model. Read only: it never places, closes or changes a trade, a setting
 * or a broker order, and it never forecasts profit.
 */
@Service
public class LeadAgent {
    static final ZoneId IST=ZoneId.of("Asia/Kolkata"),NY=ZoneId.of("America/New_York");
    static final List<String> SYMS=List.of("XAUUSD","XAGUSD","BTCUSD");
    static final Map<String,String> NAMES=Map.of("XAUUSD","Gold","XAGUSD","Silver","BTCUSD","Bitcoin");
    @org.springframework.beans.factory.annotation.Value("${APP_ENV:production}") String env="production";
    @org.springframework.beans.factory.annotation.Value("${app.keep-awake.enabled:true}") boolean keepAwakeEnabled=true;
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final BackgroundScanner scanner;private final BackgroundFeeds feeds;
    private volatile ObjectNode ownSnapshot;private volatile long ownSnapshotAt=0;
    private volatile long lastCycleAt=0;private volatile String lastError="";
    public LeadAgent(JdbcTemplate jdbc,ObjectMapper json,BackgroundScanner scanner,BackgroundFeeds feeds){this.jdbc=jdbc;this.json=json;this.scanner=scanner;this.feeds=feeds;}

    record Task(String agent,String key,String title,String priority){}

    @Scheduled(initialDelayString="${app.lead.initial-delay:45000}",fixedDelayString="${app.lead.interval:60000}")
    public void cycle(){
        try{run(Instant.now());lastError="";}
        catch(Exception e){lastError=e.getClass().getSimpleName()+": "+Objects.toString(e.getMessage(),"cycle failed");System.err.println("Lead agent cycle failed: "+lastError);}
        finally{lastCycleAt=System.currentTimeMillis();}
    }

    void run(Instant now)throws Exception{
        LocalDate day=now.atZone(IST).toLocalDate();
        ObjectNode snap=snapshot(now);
        var calendar=feeds.calendarStatus();
        // Briefing: written on the first cycle of the IST day, refreshed every 15 minutes.
        var existing=jdbc.queryForList("SELECT extract(epoch FROM updated_at)*1000 AS at,market::text AS market FROM agent_briefings WHERE day=?",day);
        ObjectNode market=null;
        // A briefing written before market data or the calendar was ready is redone on the next cycle.
        if(existing.isEmpty()||now.toEpochMilli()-((Number)existing.getFirst().get("at")).longValue()>=15*60_000L||incomplete((String)existing.getFirst().get("market"))){
            market=review(snap,calendar,now);
            var notes=notes(market,yesterdayMarket(day));
            jdbc.update("""
                INSERT INTO agent_briefings(day,market,notes) VALUES(?,?::jsonb,?::jsonb)
                ON CONFLICT(day) DO UPDATE SET market=EXCLUDED.market,notes=EXCLUDED.notes,updated_at=now()
                """,day,market.toString(),notes.toString());
        }
        if(market==null){var rows=jdbc.query("SELECT market::text FROM agent_briefings WHERE day=?",(r,n)->r.getString(1),day);market=rows.isEmpty()?review(snap,calendar,now):(ObjectNode)json.readTree(rows.getFirst());}
        for(var t:plan(market))jdbc.update("INSERT INTO agent_tasks(day,agent,task_key,title,priority) VALUES(?,?,?,?,?) ON CONFLICT(day,agent,task_key) DO NOTHING",day,t.agent(),t.key(),t.title(),t.priority());
        var tasks=jdbc.queryForList("SELECT id,agent,task_key,status FROM agent_tasks WHERE day=?",day);
        for(var row:tasks){
            String[] result;
            try{result=check((String)row.get("agent"),(String)row.get("task_key"),snap,calendar,market,now);}
            catch(RuntimeException e){result=new String[]{"BLOCKED","Check failed: "+e.getClass().getSimpleName()};}
            String status=result[0],evidence=clip(result[1],400);
            jdbc.update("UPDATE agent_tasks SET status=?,evidence=?,checked_at=now(),done_at=CASE WHEN ?='DONE' AND done_at IS NULL THEN now() ELSE done_at END WHERE id=?",status,evidence,status,((Number)row.get("id")).longValue());
        }
    }

    private boolean incomplete(String market){
        try{var m=json.readTree(market);if(!m.path("calendarReady").asBoolean())return true;
            for(var r:m.path("instruments"))if(!r.has("trend1h")&&r.path("open").asBoolean())return true;return false;}
        catch(Exception e){return true;}
    }
    /** The scanner's latest snapshot, or ATLAS's own (at most every 15 min) when a browser owns every account. */
    private ObjectNode snapshot(Instant now){
        long t=now.toEpochMilli();
        if(scanner.lastSnapshot()!=null&&t-scanner.lastSnapshotAt()<5*60_000L)return scanner.lastSnapshot();
        if(ownSnapshot==null||t-ownSnapshotAt>=15*60_000L){ownSnapshot=feeds.snapshot();ownSnapshotAt=t;}
        return ownSnapshot;
    }
    private JsonNode yesterdayMarket(LocalDate day){
        var rows=jdbc.query("SELECT market::text FROM agent_briefings WHERE day=?",(r,n)->r.getString(1),day.minusDays(1));
        try{return rows.isEmpty()?null:json.readTree(rows.getFirst());}catch(Exception e){return null;}
    }

    // ── Market review (pure functions, unit tested) ───────────────────────────────────
    static boolean metalsOpen(Instant at){
        var t=at.atZone(NY);int d=t.getDayOfWeek().getValue(),h=t.getHour();
        return d!=6&&!(d==7&&h<18)&&!(d==5&&h>=17)&&h!=17;
    }
    static String session(Instant at){
        int h=at.atZone(ZoneOffset.UTC).getHour();
        return h<7?"Asia":h<12?"London":h<16?"London / New York overlap":h<21?"New York":"Rollover";
    }
    static double ema(JsonNode bars,int n){
        if(bars==null||bars.size()<n)return Double.NaN;
        double k=2.0/(n+1),e=bars.get(0).path("c").asDouble();
        for(int i=1;i<bars.size();i++)e=bars.get(i).path("c").asDouble()*k+e*(1-k);
        return e;
    }
    static String trend(JsonNode bars){
        double fast=ema(bars,20),slow=ema(bars,50);
        if(!Double.isFinite(fast)||!Double.isFinite(slow))return "unknown";
        double last=bars.get(bars.size()-1).path("c").asDouble(),gap=(fast-slow)/slow;
        if(gap>0.0005&&last>fast)return "up";
        if(gap<-0.0005&&last<fast)return "down";
        return "sideways";
    }
    /** Latest 14-bar true range average divided by the average over the bars before it (1.0 = normal). */
    static double volatility(JsonNode bars){
        if(bars==null||bars.size()<60)return Double.NaN;
        int n=bars.size();double[] tr=new double[n];
        for(int i=1;i<n;i++){var b=bars.get(i);double pc=bars.get(i-1).path("c").asDouble();
            tr[i]=Math.max(b.path("h").asDouble()-b.path("l").asDouble(),Math.max(Math.abs(b.path("h").asDouble()-pc),Math.abs(b.path("l").asDouble()-pc)));}
        double recent=0,base=0;int baseN=0;
        for(int i=n-14;i<n;i++)recent+=tr[i];recent/=14;
        for(int i=Math.max(1,n-114);i<n-14;i++){base+=tr[i];baseN++;}
        return baseN==0||base<=0?Double.NaN:recent/(base/baseN);
    }
    static double change24h(JsonNode h1){
        if(h1==null||h1.size()<25)return Double.NaN;
        double now=h1.get(h1.size()-1).path("c").asDouble(),then=h1.get(h1.size()-25).path("c").asDouble();
        return then>0?(now/then-1)*100:Double.NaN;
    }
    ObjectNode review(JsonNode snap,Map<String,Object> calendar,Instant now){
        var out=json.createObjectNode();out.put("at",now.toEpochMilli()).put("session",session(now)).put("metalsOpen",metalsOpen(now));
        var list=out.putArray("instruments");
        for(String sym:SYMS){
            var inst=snap==null?null:snap.path(sym);var r=list.addObject().put("sym",sym).put("name",NAMES.get(sym));
            boolean open=sym.equals("BTCUSD")||metalsOpen(now);r.put("open",open);
            if(inst==null||inst.isMissingNode()||!inst.path("bars").path("1h").isArray()||inst.path("bars").path("1h").isEmpty()){r.put("view","No market data yet");continue;}
            var h1=inst.path("bars").path("1h");var h4=inst.path("bars").path("4h");
            double price=inst.path("price").asDouble(h1.get(h1.size()-1).path("c").asDouble());
            String t1=trend(h1),t4=trend(h4);double vol=volatility(h1),chg=change24h(h1);
            r.put("price",price).put("trend1h",t1).put("trend4h",t4);
            if(Double.isFinite(vol))r.put("volatility",Math.round(vol*100)/100.0);
            if(Double.isFinite(chg))r.put("change24h",Math.round(chg*100)/100.0);
            r.put("quoteFresh",inst.has("quoteAt")&&now.toEpochMilli()-inst.path("quoteAt").asLong()<60_000L);
            r.put("view",view(NAMES.get(sym),open,t1,t4,vol,chg));
        }
        var events=out.putArray("highImpactToday");
        Object cal=calendar.get("calendar");if(cal==null)cal=calendar.get("displayCalendar");
        LocalDate today=now.atZone(IST).toLocalDate();
        if(cal instanceof JsonNode arr)for(var ev:arr){
            try{
                Instant at=Instant.parse(ev.path("date").asText());
                if(!"High".equals(ev.path("impact").asText())||!at.atZone(IST).toLocalDate().equals(today))continue;
                if(!Set.of("USD","All").contains(ev.path("country").asText()))continue;
                events.addObject().put("title",ev.path("title").asText()).put("country",ev.path("country").asText()).put("at",at.toEpochMilli()).put("ist",at.atZone(IST).format(DateTimeFormatter.ofPattern("HH:mm")));
            }catch(RuntimeException ignored){/* skip malformed event */}
        }
        out.put("calendarReady",Boolean.TRUE.equals(calendar.get("ready")));
        return out;
    }
    static String view(String name,boolean open,String t1,String t4,double vol,double chg){
        if(!open)return name+": market closed.";
        String trend=t1.equals("unknown")?"trend unknown":t1.equals(t4)?(t1.equals("sideways")?"sideways on 1h and 4h":t1+"trend on 1h and 4h"):"mixed trend (1h "+t1+", 4h "+t4+")";
        String v=!Double.isFinite(vol)?"volatility unknown":vol>=1.5?"volatility high ("+String.format(Locale.ROOT,"%.1f",vol)+"x normal)":vol<=0.7?"volatility low ("+String.format(Locale.ROOT,"%.1f",vol)+"x normal)":"volatility normal";
        String c=Double.isFinite(chg)?", "+(chg>=0?"up ":"down ")+String.format(Locale.ROOT,"%.2f",Math.abs(chg))+"% in 24 h":"";
        return name+": "+trend+", "+v+c+".";
    }
    /** Plain-language notes for the day, comparing with yesterday's briefing where one exists. */
    ArrayNode notes(JsonNode market,JsonNode yesterday){
        var out=json.createArrayNode();
        for(var r:market.path("instruments")){
            String sym=r.path("sym").asText();out.add(r.path("view").asText());
            if(yesterday!=null)for(var y:yesterday.path("instruments"))if(y.path("sym").asText().equals(sym)&&y.has("trend4h")&&r.has("trend4h")&&!y.path("trend4h").asText().equals(r.path("trend4h").asText()))
                out.add(r.path("name").asText()+": the 4h trend changed from "+y.path("trend4h").asText()+" yesterday to "+r.path("trend4h").asText()+" today. Older setups may not fit.");
            if(r.path("volatility").asDouble(1)>=1.5)out.add(r.path("name").asText()+": moves are bigger than usual. Stops are hit faster; the entry rules and the $4 risk cap still apply.");
            if(r.path("open").asBoolean()&&"sideways".equals(r.path("trend1h").asText())&&"sideways".equals(r.path("trend4h").asText()))out.add(r.path("name").asText()+": no clear direction. Fewer Auto signals are expected; Low Profit range levels matter more.");
        }
        var ev=market.path("highImpactToday");
        if(ev.isEmpty())out.add(market.path("calendarReady").asBoolean()?"No high-impact USD news today.":"News calendar not confirmed yet; new entries stay paused around unknown news.");
        else for(var e:ev)out.add("High-impact news at "+e.path("ist").asText()+" IST: "+e.path("title").asText()+". Entries pause around it.");
        out.add("Session now: "+market.path("session").asText()+".");
        return out;
    }

    // ── Daily plan and task checks ────────────────────────────────────────────────
    static List<Task> plan(JsonNode market){
        var out=new ArrayList<Task>(List.of(
            new Task("NIGHT OWL","server-scan","Run the server scan for every account all day","HIGH"),
            new Task("TICKER","quotes","Keep gold, silver and bitcoin prices fresh","HIGH"),
            new Task("SCOUT","calendar","Confirm today's economic calendar and high-impact news","HIGH"),
            new Task("HUNTER","auto-scan","Check Auto signal setups on each open market and log why none entered","NORMAL"),
            new Task("SPARROW","low-profit-scan","Check Low Profit setups (support/resistance, order blocks) on each open market","NORMAL"),
            new Task("TRAPPER","order-flow","Record the order-flow footprint for gold, silver and bitcoin","NORMAL"),
            new Task("WARDEN","risk","Check every account against the paper risk limits","HIGH"),
            new Task("COURIER","alerts","Deliver every new signal alert (Telegram and phone push)","NORMAL"),
            new Task("VAULT","ledger","Confirm the paper ledger is saving to the database","NORMAL")));
        for(var r:market.path("instruments"))
            if(r.path("open").asBoolean()&&r.path("volatility").asDouble(1)>=1.5)
                out.add(new Task("HUNTER","focus-"+r.path("sym").asText(),"Watch "+r.path("name").asText()+" closely: volatility is "+r.path("volatility").asText()+"x normal","HIGH"));
        for(var e:market.path("highImpactToday"))
            out.add(new Task("SCOUT","news-"+e.path("at").asText(),"Warn the team before "+clip(e.path("title").asText(),90)+" at "+e.path("ist").asText()+" IST","HIGH"));
        return out;
    }
    private String[] check(String agent,String key,JsonNode snap,Map<String,Object> calendar,JsonNode market,Instant now){
        long t=now.toEpochMilli();boolean metals=metalsOpen(now);
        switch(key){
            case "server-scan"->{
                if(!scanner.enabled())return r("BLOCKED","Server scanner is turned off on this deployment");
                long age=t-scanner.cycleFinishedAt();
                if(scanner.cycleFinishedAt()==0)return r("ASSIGNED","Waiting for the first scan after start-up");
                if(!scanner.cycleError().isEmpty())return r("BLOCKED","Last scan failed: "+scanner.cycleError());
                if(age>3*60_000L)return r("BLOCKED","Last scan finished "+age/60_000L+" min ago");
                if("BROWSER_OR_PAUSED".equals(scanner.phase()))return r("DONE","An open browser owns every account (or scanning is paused); the server takes over when it closes");
                return r("DONE","Scanned "+scanner.lastAccounts()+" account(s), last scan "+age/1000+" s ago");
            }
            case "quotes"->{
                if(snap==null)return r("ASSIGNED","Waiting for the first market snapshot");
                var missing=new ArrayList<String>();int open=0;
                for(String s:SYMS){if(!s.equals("BTCUSD")&&!metals)continue;open++;var i=snap.path(s);
                    if(!i.has("price")||t-i.path("quoteAt").asLong()>5*60_000L)missing.add(NAMES.get(s)+(i.has("quoteError")?" ("+i.path("quoteError").asText()+")":""));}
                if(!missing.isEmpty())return r("BLOCKED","No fresh price for "+String.join(", ",missing));
                return r("DONE","Fresh prices for "+open+" open market(s)"+(metals?"":"; metals closed"));
            }
            case "calendar"->{
                Object state=calendar.get("calendarState");
                if(Boolean.TRUE.equals(calendar.get("ready")))return r("DONE","Calendar "+state+": "+market.path("highImpactToday").size()+" high-impact USD event(s) today");
                return r("BLOCKED","Calendar not confirmed: "+Objects.toString(calendar.get("calendarError"),"unavailable"));
            }
            case "auto-scan","low-profit-scan"->{
                var diag=diagnostics(t);if(diag==null)return r(scanner.phase().equals("BROWSER_OR_PAUSED")?"DONE":"ASSIGNED",scanner.phase().equals("BROWSER_OR_PAUSED")?"The open browser is running the scan":"Waiting for a server scan result");
                var parts=new ArrayList<String>();
                for(String s:SYMS){if(!s.equals("BTCUSD")&&!metals)continue;var d=diag.path(s);if(d.isMissingNode())continue;
                    parts.add(NAMES.get(s)+": "+clip(d.path(key.equals("auto-scan")?"auto":"lowProfit").asText("no result"),70));}
                return parts.isEmpty()?r("ASSIGNED","No scan result yet"):r("DONE",String.join("; ",parts));
            }
            case "order-flow"->{
                var rows=jdbc.queryForList("SELECT symbol,extract(epoch FROM max(updated_at))*1000 AS at FROM order_flow_minutes WHERE updated_at>now()-interval '1 day' GROUP BY symbol");
                var at=new HashMap<String,Long>();for(var row:rows)at.put((String)row.get("symbol"),((Number)row.get("at")).longValue());
                var stale=new ArrayList<String>();
                for(String s:SYMS){if(!s.equals("BTCUSD")&&!metals)continue;Long a=at.get(s);if(a==null||t-a>15*60_000L)stale.add(NAMES.get(s));}
                return stale.isEmpty()?r("DONE","Footprint minutes recorded in the last 15 min"):r("BLOCKED","No recent order-flow minutes for "+String.join(", ",stale));
            }
            case "risk"->{
                var breaches=riskBreaches(now);
                return breaches.isEmpty()?r("DONE","All accounts inside limits (max 5 open, $4 risk per trade, $8 daily loss)"):r("DONE","Limit reached, new entries blocked for: "+String.join(", ",breaches));
            }
            case "alerts"->{
                var failed=jdbc.queryForObject("SELECT count(*) FROM telegram_deliveries WHERE state='FAILED' AND created_at>now()-interval '1 day'",Long.class);
                var stuck=jdbc.queryForObject("SELECT count(*) FROM telegram_deliveries WHERE state IN ('PENDING','RETRY') AND created_at<now()-interval '10 minutes'",Long.class);
                var push=jdbc.queryForObject("SELECT count(*) FROM push_alerts WHERE sent_at IS NULL AND created_at<now()-interval '10 minutes' AND created_at>now()-interval '1 day'",Long.class);
                var sent=jdbc.queryForObject("SELECT (SELECT count(*) FROM telegram_deliveries WHERE state='SENT' AND sent_at>now()-interval '1 day')+(SELECT count(*) FROM push_alerts WHERE sent_at>now()-interval '1 day')",Long.class);
                if(failed+stuck+push>0)return r("BLOCKED",failed+" failed and "+(stuck+push)+" late alert(s) in the last day");
                return r("DONE",sent+" alert(s) delivered in the last 24 h, none waiting");
            }
            case "ledger"->{
                var n=jdbc.queryForObject("SELECT (SELECT count(*) FROM auto_signals WHERE updated_at>now()-interval '1 day')+(SELECT count(*) FROM low_profit_signals WHERE updated_at>now()-interval '1 day')",Long.class);
                return r("DONE","Database reachable; "+n+" paper record(s) saved or updated in the last 24 h");
            }
            default->{
                if(key.startsWith("focus-")){
                    String s=key.substring(6);var diag=diagnostics(t);
                    if(!s.equals("BTCUSD")&&!metals)return r("SKIPPED","Market closed");
                    if(diag==null||diag.path(s).isMissingNode())return r("ASSIGNED","Waiting for a server scan of "+NAMES.getOrDefault(s,s));
                    return r("DONE",NAMES.getOrDefault(s,s)+" scanned: "+clip(diag.path(s).path("auto").asText(),120));
                }
                if(key.startsWith("news-")){
                    long at=Long.parseLong(key.substring(5));
                    if(t>=at)return r("DONE","Event time passed; entries were paused around it by the news filter");
                    if(at-t<=2*3600_000L)return r("DONE","Team warned: "+Math.max(1,(at-t)/60_000L)+" min to go, entries pause around it");
                    return r("ASSIGNED","Event at "+Instant.ofEpochMilli(at).atZone(IST).format(DateTimeFormatter.ofPattern("HH:mm"))+" IST; warning goes out 2 h before");
                }
                return r("SKIPPED","Unknown task");
            }
        }
    }
    /** Latest server diagnostics across accounts (instrument diagnostics are market level). */
    private JsonNode diagnostics(long now){
        var rows=jdbc.query("SELECT details::text FROM background_scanner_status WHERE state='SCANNING' AND checked_at>now()-interval '5 minutes' ORDER BY checked_at DESC LIMIT 1",(r,n)->r.getString(1));
        try{return rows.isEmpty()?null:json.readTree(rows.getFirst()).path("instruments");}catch(Exception e){return null;}
    }
    private List<String> riskBreaches(Instant now){
        long today=Math.floorDiv(now.toEpochMilli()+19800000,86400000);
        var out=new ArrayList<String>();
        var users=jdbc.queryForList("SELECT username FROM auth_users WHERE active AND role IN ('admin','user')");
        for(var u:users){
            String name=(String)u.get("username");
            var rows=jdbc.query("""
                SELECT payload::text FROM auto_signals WHERE created_by=? AND (status='OPEN' OR updated_at>now()-interval '2 days')
                UNION ALL SELECT payload::text FROM low_profit_signals WHERE created_by=? AND (status='OPEN' OR updated_at>now()-interval '2 days')
                """,(r,n)->r.getString(1),name,name);
            int open=0;double net=0;
            for(String row:rows){
                try{
                    var r=json.readTree(row);String st=r.has("outcome")?r.path("outcome").asText():r.path("status").asText();
                    if("OPEN".equals(st)||"OPEN".equals(r.path("status").asText())){open++;continue;}
                    long at=r.path("closedAt").asLong(r.path("ts").asLong(r.path("t").asLong()));
                    if(Math.floorDiv(at+19800000,86400000)==today){double v=r.has("pnlUsd")?r.path("pnlUsd").asDouble(Double.NaN):r.path("pnl").asDouble(Double.NaN);if(Double.isFinite(v))net+=v;}
                }catch(Exception ignored){/* unreadable row is not counted */}
            }
            if(open>=PaperTradingService.MAX_OPEN||net<=-PaperTradingService.DAY_LOSS_USD)out.add(name+(open>=PaperTradingService.MAX_OPEN?" ("+open+" open)":" (day "+String.format(Locale.ROOT,"%.2f",net)+" USD)"));
        }
        return out;
    }
    private static String[] r(String status,String evidence){return new String[]{status,evidence};}
    static String clip(String s,int n){return s==null?"":s.length()>n?s.substring(0,n-1)+"…":s;}

    // ── Read model for the Agents and Office tabs ────────────────────────────────
    public Map<String,Object> view(AuthService.Identity user){
        Instant now=Instant.now();LocalDate day=now.atZone(IST).toLocalDate();
        var out=new LinkedHashMap<String,Object>();
        out.put("day",day.toString());out.put("lastCycleAt",lastCycleAt);out.put("lastError",lastError);
        var b=jdbc.queryForList("SELECT market::text AS market,notes::text AS notes,extract(epoch FROM updated_at)*1000 AS at FROM agent_briefings WHERE day=?",day);
        try{
            if(!b.isEmpty()){out.put("market",json.readTree((String)b.getFirst().get("market")));out.put("notes",json.readTree((String)b.getFirst().get("notes")));out.put("briefingAt",((Number)b.getFirst().get("at")).longValue());}
        }catch(Exception ignored){/* unreadable briefing: tasks still shown */}
        out.put("tasks",jdbc.queryForList("""
            SELECT agent,task_key AS key,title,priority,status,evidence,
              extract(epoch FROM assigned_at)*1000 AS "assignedAt",extract(epoch FROM checked_at)*1000 AS "checkedAt",extract(epoch FROM done_at)*1000 AS "doneAt"
            FROM agent_tasks WHERE day=? ORDER BY CASE priority WHEN 'HIGH' THEN 0 ELSE 1 END,id
            """,day));
        // Day-to-day record: how many tasks were done on each of the last 7 days.
        out.put("history",jdbc.queryForList("""
            SELECT day::text AS day,count(*) AS total,count(*) FILTER (WHERE status IN ('DONE','SKIPPED')) AS done,count(*) FILTER (WHERE status='BLOCKED') AS blocked
            FROM agent_tasks WHERE day>=?::date-6 GROUP BY day ORDER BY day DESC
            """,day));
        if(Set.of("admin","user").contains(user.role()))out.put("paperReview",paperReview(user.username(),now));
        out.put("background",background(now));
        return out;
    }
    /** The account's own closed paper results for the last 7 days, by instrument and session. Paper only. */
    Map<String,Object> paperReview(String username,Instant now){
        var rows=jdbc.query("""
            SELECT 'Auto' AS kind,payload::text FROM auto_signals WHERE created_by=? AND updated_at>now()-interval '8 days'
            UNION ALL SELECT 'Low Profit',payload::text FROM low_profit_signals WHERE created_by=? AND updated_at>now()-interval '8 days'
            """,(r,n)->new String[]{r.getString(1),r.getString(2)},username,username);
        long since=now.toEpochMilli()-7*86400_000L;
        var by=new TreeMap<String,double[]>();var sessions=new TreeMap<String,double[]>();
        for(var row:rows){
            try{
                var r=json.readTree(row[1]);if(r.path("accountingVersion").asInt()!=2)continue;
                String st=r.has("outcome")?r.path("outcome").asText():r.path("status").asText();if("OPEN".equals(st)||"OPEN".equals(r.path("status").asText()))continue;
                double pnl=r.has("pnlUsd")?r.path("pnlUsd").asDouble(Double.NaN):r.path("pnl").asDouble(Double.NaN);if(!Double.isFinite(pnl))continue;
                long opened=r.path("ts").asLong(r.path("t").asLong());if(opened<since)continue;
                String k=NAMES.getOrDefault(r.path("sym").asText(),r.path("sym").asText())+" "+row[0];
                var a=by.computeIfAbsent(k,x->new double[3]);a[pnl>0.005?0:pnl<-0.005?1:2]++;
                var s=sessions.computeIfAbsent(session(Instant.ofEpochMilli(opened)),x->new double[3]);s[pnl>0.005?0:pnl<-0.005?1:2]++;
            }catch(Exception ignored){/* skip unreadable record */}
        }
        var out=new LinkedHashMap<String,Object>();var lines=new ArrayList<String>();
        by.forEach((k,a)->lines.add(k+": "+(int)a[0]+" won, "+(int)a[1]+" lost"+(a[2]>0?", "+(int)a[2]+" breakeven":"")));
        out.put("lines",lines);
        String best=null;double bestRate=-1;int bestN=0;
        for(var e:sessions.entrySet()){double n=e.getValue()[0]+e.getValue()[1];if(n>=3&&e.getValue()[0]/n>bestRate){bestRate=e.getValue()[0]/n;best=e.getKey();bestN=(int)n;}}
        if(best!=null)out.put("bestSession",best+" ("+Math.round(bestRate*100)+"% of "+bestN+" decided paper trades won)");
        out.put("note","Paper trades only. Past paper results do not predict future results.");
        return out;
    }
    Map<String,Object> background(Instant now){
        var out=new LinkedHashMap<String,Object>();
        long age=scanner.cycleFinishedAt()==0?-1:now.toEpochMilli()-scanner.cycleFinishedAt();
        out.put("scannerEnabled",scanner.enabled());out.put("lastScanAgoSeconds",age<0?-1:age/1000);out.put("phase",scanner.phase());
        // Mirrors KeepAwake.start(): only the staging service pings itself.
        boolean configured=keepAwakeEnabled&&"staging".equalsIgnoreCase(env);
        out.put("keepAwakeConfigured",configured);out.put("keepAwake",configured&&KeepAwake.inWindow(now));out.put("keepAwakeWindow",KeepAwake.WINDOW_TEXT);
        return out;
    }
}
