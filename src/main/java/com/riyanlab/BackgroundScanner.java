package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

@Service
public class BackgroundScanner {
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final BackgroundFeeds feeds;
    private final PaperTradingService paper;private final RecordController records;
    private final String owner="server-"+UUID.randomUUID();
    private final AtomicBoolean busy=new AtomicBoolean();
    private Path runtime;
    private volatile String phase="STARTING",cycleError="";
    private volatile long cycleStartedAt=0,cycleFinishedAt=0;
    @Value("${app.background.enabled:true}") private boolean enabled;
    @Value("${app.background.node:node}") private String node;
    public BackgroundScanner(JdbcTemplate jdbc,ObjectMapper json,BackgroundFeeds feeds,PaperTradingService paper,RecordController records){this.jdbc=jdbc;this.json=json;this.feeds=feeds;this.paper=paper;this.records=records;}
    private synchronized Path runtime()throws Exception{
        if(runtime!=null)return runtime;
        Path folder=Files.createTempDirectory("riyan-scanner-");Files.createDirectories(folder.resolve("static"));Files.createDirectories(folder.resolve("background"));
        for(String file:List.of("static/index.html","static/trading-core.js","static/paper-engine.js","static/market-context.js","background/scanner.cjs"))
            try(var input=new ClassPathResource(file).getInputStream()){Files.copy(input,folder.resolve(file));}
        runtime=folder;return folder;
    }
    @Scheduled(initialDelayString="${app.background.initial-delay:20000}",fixedDelayString="${app.background.interval:20000}")
    public void scan(){
        if(!enabled||!busy.compareAndSet(false,true))return;
        cycleStartedAt=System.currentTimeMillis();phase="CHECKING_OWNERSHIP";cycleError="";
        try{
            var users=jdbc.queryForList("""
                SELECT u.id,u.username,u.role FROM auth_users u
                LEFT JOIN background_scanner_settings s ON s.username=u.username
                LEFT JOIN paper_engine_leases l ON l.username=u.username
                WHERE u.active=true AND u.role IN ('admin','user') AND COALESCE(s.enabled,true)
                  AND (l.username IS NULL OR l.expires_at<=now() OR l.owner=?)
                ORDER BY u.id
                """,owner);
            if(users.isEmpty()){phase="BROWSER_OR_PAUSED";return;}
            phase="LOADING_CALENDAR";var calendar=feeds.calendar();phase="LOADING_MARKETS";var snapshot=feeds.snapshot();
            phase="SCANNING_ACCOUNTS";
            for(var user:users){
                var identity=new AuthService.Identity(((Number)user.get("id")).longValue(),(String)user.get("username"),(String)user.get("role"));
                if(!paper.backgroundLease(identity.username(),owner))continue;
                try{runUser(identity,snapshot,calendar);}catch(Exception e){status(identity.username(),"ERROR",json.createObjectNode().put("reason",e.getClass().getSimpleName()+": "+Objects.toString(e.getMessage(),"Scanner failed").substring(0,Math.min(260,Objects.toString(e.getMessage(),"Scanner failed").length()))));}
            }
        }catch(Exception e){phase="ERROR";cycleError=e.getClass().getSimpleName()+": "+Objects.toString(e.getMessage(),"Cycle failed");System.err.println("Background scanner cycle failed: "+cycleError);}
        finally{cycleFinishedAt=System.currentTimeMillis();busy.set(false);}
    }
    private void runUser(AuthService.Identity identity,ObjectNode snapshot,Map<String,Object> calendar)throws Exception{
        var settings=jdbc.query("SELECT config::text FROM background_scanner_settings WHERE username=?",(r,n)->r.getString(1),identity.username());
        var job=json.createObjectNode().put("username",identity.username()).put("role",identity.role()).put("now",System.currentTimeMillis());
        ObjectNode config=settings.isEmpty()?legacyConfig(identity.username()):(ObjectNode)json.readTree(settings.getFirst());
        job.set("config",config.path("scalp").isObject()?config.path("scalp"):config);
        job.put("allowEntries",!settings.isEmpty());
        job.put("basketEnabled",config.path("basketModeVersion").asInt()==2&&config.path("basketEnabled").asBoolean());
        Boolean openBasket=jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM basket_scalp_positions WHERE created_by=? AND status='OPEN')",Boolean.class,identity.username());
        if(Boolean.TRUE.equals(openBasket))job.put("basketActive",true);
        job.set("feeds",snapshot);calendar.forEach((k,v)->job.set(k,json.valueToTree(v)));
        ArrayNode history=job.putArray("history");Set<String> existing=new HashSet<>();
        for(var table:Map.of("auto-signals","auto_signals","manual-signals","manual_signals","low-profit","low_profit_signals").entrySet()){
            var rows=jdbc.queryForList("SELECT source_id,payload::text AS payload FROM "+table.getValue()+" WHERE created_by=? AND (status='OPEN' OR updated_at>now()-interval '2 days') ORDER BY updated_at DESC LIMIT 10000",identity.username());
            for(var row:rows){String id=(String)row.get("source_id");history.addObject().put("id",id).put("type",table.getKey()).set("record",json.readTree((String)row.get("payload")));existing.add(table.getKey()+"|"+id);}
        }
        Path dir=runtime();Path output=Files.createTempFile(dir,"out-",".json"),error=Files.createTempFile(dir,"err-",".log");Process process=null;
        try{
            process=new ProcessBuilder(node,"--max-old-space-size=64",dir.resolve("background/scanner.cjs").toString()).redirectOutput(output.toFile()).redirectError(error.toFile()).start();
            try(var stdin=process.getOutputStream()){stdin.write(json.writeValueAsBytes(job));}
            if(!process.waitFor(12,TimeUnit.SECONDS)){process.destroyForcibly();throw new IllegalStateException("Shared strategy runtime timed out");}
            if(process.exitValue()!=0)throw new IllegalStateException("Shared strategy runtime failed: "+Files.readString(error).substring(0,(int)Math.min(220,Files.size(error))));
            if(Files.size(output)>6000000)throw new IllegalStateException("Oversized strategy result");
            var result=json.readTree(Files.readString(output));
            var changes=new ArrayList<JsonNode>();result.path("changes").forEach(changes::add);
            changes.sort(Comparator.comparing(c->!existing.contains(c.path("type").asText()+"|"+c.path("id").asText())));
            Boolean permitted=jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM auth_users u LEFT JOIN background_scanner_settings s ON s.username=u.username WHERE u.username=? AND u.active=true AND u.role IN ('admin','user') AND COALESCE(s.enabled,true))",Boolean.class,identity.username());
            if(!Boolean.TRUE.equals(permitted)){status(identity.username(),"PAUSED",json.createObjectNode().put("reason","Background disabled or account no longer active"));return;}
            int saved=0,rejected=0;var reasons=json.createArrayNode();
            for(var change:changes){
                String type=change.path("type").asText();if(!Set.of("auto-signals","manual-signals","low-profit").contains(type))throw new IllegalStateException("Unexpected background record type");
                try{
                    String recordId=change.path("id").asText();
                    if(!existing.contains(type+"|"+recordId)){
                        long next=jdbc.queryForObject("SELECT nextval('background_signal_ids')",Long.class);
                        recordId=Long.toString(next);((ObjectNode)change.path("record")).put("id",next);
                    }
                    if(!records.saveForEngine(identity,type,recordId,change.path("record"),owner).getStatusCode().is2xxSuccessful())throw new IllegalStateException("Invalid background record");
                    saved++;
                }
                catch(org.springframework.web.server.ResponseStatusException e){rejected++;if(reasons.size()<5)reasons.add(Objects.toString(e.getReason(),"Entry rejected"));}
            }
            var detail=json.createObjectNode().put("saved",saved).put("rejected",rejected).put("paperOnly",true);
            detail.set("reasons",reasons);detail.set("instruments",result.path("diagnostics"));
            detail.put("calendarAt",((Number)calendar.getOrDefault("calendarAt",0)).longValue());
            detail.put("calendarError",Objects.toString(calendar.getOrDefault("calendarError","")));
            detail.put("basket",Boolean.TRUE.equals(openBasket)?"Basket positions remain browser managed":"Low Profit uses structure; optional Basket mode requires a browser");
            status(identity.username(),"SCANNING",detail);
        }finally{if(process!=null&&process.isAlive())process.destroyForcibly();Files.deleteIfExists(output);Files.deleteIfExists(error);}
    }
    private ObjectNode legacyConfig(String user)throws Exception{
        ObjectNode config=json.createObjectNode();ObjectNode assets=config.putObject("assets");boolean any=false;
        for(String sym:List.of("XAUUSD","XAGUSD","BTCUSD")){
            var rows=jdbc.query("SELECT payload::text FROM user_states WHERE created_by=? AND payload->>'symbol'=? AND payload->>'continuationEnabled' IS NOT NULL ORDER BY updated_at DESC LIMIT 1",(r,n)->r.getString(1),user,sym);
            if(!rows.isEmpty()){var p=json.readTree(rows.getFirst());config.put("auto",p.path("auto").asBoolean(true));assets.put(sym,p.path("assetEnabled").asBoolean(true));config.put("continuation",p.path("continuationEnabled").asBoolean(false));any=true;}
        }
        if(!any)config.put("auto",true);
        var baskets=jdbc.query("SELECT payload::text FROM user_states WHERE created_by=? AND payload->>'key'='basket-demo-settings' ORDER BY updated_at DESC LIMIT 1",(r,n)->r.getString(1),user);
        if(!baskets.isEmpty())config.put("basketEnabled",json.readTree(baskets.getFirst()).path("enabled").asBoolean());
        return config;
    }
    private void status(String user,String state,JsonNode details){jdbc.update("""
        INSERT INTO background_scanner_status(username,state,details) VALUES(?,?,?::jsonb)
        ON CONFLICT(username) DO UPDATE SET state=EXCLUDED.state,details=EXCLUDED.details,checked_at=now()
        """,user,state,details.toString());}
    public Map<String,Object> status(String user){
        var out=new LinkedHashMap<String,Object>();out.put("available",enabled);out.put("phase",phase);out.put("busy",busy.get());out.put("cycleStartedAt",cycleStartedAt);out.put("cycleFinishedAt",cycleFinishedAt);out.put("cycleError",cycleError);out.put("hosting","Render free services may sleep without incoming traffic; an always-on host is needed for uninterrupted scans.");out.put("intervalSeconds",20);
        var health=new LinkedHashMap<>(feeds.calendarStatus());health.remove("calendar");out.put("calendarHealth",health);
        var settings=jdbc.queryForList("SELECT enabled FROM background_scanner_settings WHERE username=?",user);out.put("enabled",settings.isEmpty()||Boolean.TRUE.equals(settings.getFirst().get("enabled")));
        var rows=jdbc.queryForList("SELECT state,checked_at,details::text AS details FROM background_scanner_status WHERE username=?",user);
        if(!rows.isEmpty())out.putAll(rows.getFirst());
        var leases=jdbc.queryForList("SELECT owner,expires_at FROM paper_engine_leases WHERE username=? AND expires_at>now()",user);
        out.put("owner",leases.isEmpty()?"WAITING":((String)leases.getFirst().get("owner")).startsWith("server-")?"SERVER":"BROWSER");
        return out;
    }
    @PreDestroy public void cleanup(){if(runtime!=null)try(var files=Files.walk(runtime)){files.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.deleteIfExists(p);}catch(Exception ignored){}});}catch(Exception ignored){}}
}
