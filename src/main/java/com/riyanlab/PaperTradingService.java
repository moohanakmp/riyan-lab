package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;

@Service
public class PaperTradingService {
    private static final Set<String> TRADES=Set.of("auto-signals","manual-signals","low-profit","basket-positions");
    private static final Map<String,Double> CONTRACT=Map.of("XAUUSD",100d,"XAGUSD",100d,"BTCUSD",1d);
    private static final Map<String,Double> SPREAD=Map.of("XAUUSD",.35,"XAGUSD",.03,"BTCUSD",5d);
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    public PaperTradingService(JdbcTemplate jdbc,ObjectMapper json){this.jdbc=jdbc;this.json=json;}
    public static boolean isTrade(String type){return TRADES.contains(type);}
    private void reject(String reason){throw new ResponseStatusException(HttpStatus.CONFLICT,reason);}
    private JsonNode parse(String raw){try{return json.readTree(raw);}catch(Exception e){throw new IllegalStateException("Invalid stored paper ledger",e);}}
    private String status(JsonNode n){return n.path("outcome").asText(n.path("status").asText());}
    private double value(JsonNode n,String a,String b){return n.path(a).asDouble(n.path(b).asDouble(Double.NaN));}
    private void accounting(JsonNode n) {
        if(n.path("accountingVersion").asInt()!=2)return; // Preserve, label and audit legacy results.
        String symbol=n.path("sym").asText();
        double entry=value(n,"entry","price"),units=value(n,"units","posUnits"),
            spread=SPREAD.getOrDefault(symbol,Double.NaN),sign=n.path("dir").asText().equals("BUY")?1:-1;
        if(!Double.isFinite(entry)||!Double.isFinite(units)||!Double.isFinite(spread)||units<=0)reject("Invalid accounting inputs");
        if(n.has("fills")){
            if(!n.path("fills").isArray())reject("Invalid fill ledger");
            double total=0,qty=0;
            for(JsonNode fill:n.path("fills")) {
                double px=fill.path("price").asDouble(Double.NaN),u=fill.path("units").asDouble(Double.NaN);
                double net=((px-entry)*sign-spread)*u;
                if(!Double.isFinite(net)||px<=0||u<=0||(!Double.isFinite(fill.path("netUsd").asDouble(Double.NaN))||Math.abs(net-fill.path("netUsd").asDouble(Double.NaN))>.00001))
                    reject("Fill price and profit disagree");
                total+=net;qty+=u;
            }
            if(!Double.isFinite(n.path("realUsd").asDouble(Double.NaN))||!Double.isFinite(n.path("remFrac").asDouble(Double.NaN))||qty>units+1e-8||Math.abs(total-n.path("realUsd").asDouble(Double.NaN))>.00001||
               Math.abs(qty/units+n.path("remFrac").asDouble(Double.NaN)-1)>.00001)reject("Invalid partial quantities");
            if(!status(n).equals("OPEN")&&(!Double.isFinite(value(n,"pnlUsd","pnl"))||Math.abs(qty-units)>1e-8||
               Math.abs(total-value(n,"pnlUsd","pnl"))>.005))reject("Final profit disagrees with fill ledger");
            if(!status(n).equals("OPEN")&&n.path("fills").size()>0&&
                Math.abs(n.path("fills").get(n.path("fills").size()-1).path("price").asDouble()-value(n,"exit","exitPrice"))>1e-8)
                reject("Final fill and reported exit disagree");
        }else if(!status(n).equals("OPEN")){
            double exit=value(n,"exit","exitPrice"),net=((exit-entry)*sign-spread)*units;
            double recorded=value(n,"pnlUsd","pnl");
            if(!Double.isFinite(net)||!Double.isFinite(recorded)||Math.abs(net-recorded)>.0051)reject("Exit price and profit disagree");
        }
    }
    public void lock(String user){jdbc.queryForList("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", "paper:"+user);}
    public void requireLease(String user,String owner){
        if(owner==null||owner.length()>80)reject("Paper engine ownership required");
        Boolean ok=jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM paper_engine_leases WHERE username=? AND owner=? AND expires_at>now())",Boolean.class,user,owner);
        if(!Boolean.TRUE.equals(ok))reject("Paper engine lease expired");
    }
    @Transactional
    public boolean lease(String user,String owner){
        if(owner==null||!owner.matches("[A-Za-z0-9-]{10,80}"))reject("Invalid engine ID");
        lock(user);
        return jdbc.update("""
            INSERT INTO paper_engine_leases(username,owner,expires_at) VALUES(?,?,now()+interval '40 seconds')
            ON CONFLICT(username) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
            WHERE paper_engine_leases.owner=EXCLUDED.owner OR paper_engine_leases.expires_at<=now() OR paper_engine_leases.owner LIKE 'server-%'
            """,user,owner)>0;
    }
    @Transactional
    public boolean backgroundLease(String user,String owner){
        lock(user);
        return jdbc.update("""
            INSERT INTO paper_engine_leases(username,owner,expires_at) VALUES(?,?,now()+interval '40 seconds')
            ON CONFLICT(username) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
            WHERE paper_engine_leases.owner=EXCLUDED.owner OR paper_engine_leases.expires_at<=now()
            """,user,owner)>0;
    }
    public List<Map<String,Object>> readLedger(String user,int limit,int offset){
        return jdbc.queryForList("""
            SELECT * FROM (
             SELECT 'auto-signals' AS record_type,source_id,payload::text AS payload FROM auto_signals WHERE created_by=?
             UNION ALL SELECT 'manual-signals',source_id,payload::text FROM manual_signals WHERE created_by=?
             UNION ALL SELECT 'low-profit',source_id,payload::text FROM low_profit_signals WHERE created_by=?
             UNION ALL SELECT 'basket-sessions',source_id,payload::text FROM basket_scalp_sessions WHERE created_by=?
             UNION ALL SELECT 'basket-positions',source_id,payload::text FROM basket_scalp_positions WHERE created_by=?
            ) ledger ORDER BY record_type,source_id LIMIT ? OFFSET ?
            """,user,user,user,user,user,limit,offset);
    }
    public void validate(String user,String type,String id,JsonNode next,String previous){
        if(!isTrade(type))return;
        accounting(next);
        if(previous!=null){
            JsonNode old=parse(previous);
            if(!status(old).equals("OPEN")&&!old.equals(next)) {
                // Historical results are immutable; archive/display metadata may change.
                for(String field:List.of("outcome","status","pnlUsd","pnl","exit","exitPrice","closedAt","realUsd"))
                    if(!old.path(field).equals(next.path(field)))reject("Closed paper results cannot be rewritten");
            }
            if(old.path("updatedAt").asLong()>next.path("updatedAt").asLong())reject("Stale paper update");
            if(old.path("tp1Hit").asBoolean()&&!next.path("tp1Hit").asBoolean() ||
               old.path("tp2Hit").asBoolean()&&!next.path("tp2Hit").asBoolean() ||
               old.path("beMoved").asBoolean()&&!next.path("beMoved").asBoolean())reject("Paper lifecycle cannot move backwards");
            for(String field:List.of("sym","dir","price","entry","sl","tp","tp1","tp2","tp3","lot","units","posUnits","signalKey"))
                if(!old.path(field).equals(next.path(field)))reject("Entry plan is immutable");
            if(old.path("accountingVersion").asInt()==2 && next.path("accountingVersion").asInt()!=2)reject("Accounting version cannot be downgraded");
            if(old.path("fills").isArray()){
                for(int i=0;i<old.path("fills").size();i++)
                    if(!old.path("fills").path(i).equals(next.path("fills").path(i)))reject("Recorded fills cannot be rewritten");
            }
            return;
        }
        if(type.equals("basket-positions"))reject("Basket entries retired; use Low Profit paper trading");
        if(next.path("accountingVersion").asInt()!=2 || !next.path("paperOnly").asBoolean() ||
           !next.path("brokerOrderId").isNull() || !"OPEN".equals(status(next)))reject("New entries require paper accounting v2");
        String sym=next.path("sym").asText(),dir=next.path("dir").asText(),key=next.path("signalKey").asText();
        if(!CONTRACT.containsKey(sym)||!Set.of("BUY","SELL").contains(dir)||key.isBlank()||key.length()>200)reject("Invalid signal identity");
        double entry=value(next,"entry","price"),stop=next.path("sl").asDouble(Double.NaN),
            units=value(next,"units","posUnits"),lot=next.path("lot").asDouble(Double.NaN),sign=dir.equals("BUY")?1:-1;
        double risk=((entry-stop)*sign+SPREAD.get(sym))*units;
        if(!Double.isFinite(risk)||entry<=0||stop<=0||units<=0||!Double.isFinite(lot)||Math.abs(lot-.01)>1e-8||
           Math.abs(units-lot*CONTRACT.get(sym))>1e-7||(entry-stop)*sign<=0||risk>4.000001)reject("Invalid size or stop risk exceeds $4");
        List<String> rows=jdbc.query("""
            SELECT payload::text FROM auto_signals WHERE created_by=?
            UNION ALL SELECT payload::text FROM manual_signals WHERE created_by=?
            UNION ALL SELECT payload::text FROM low_profit_signals WHERE created_by=?
            UNION ALL SELECT payload::text FROM basket_scalp_positions WHERE created_by=?
            """,(rs,n)->rs.getString(1),user,user,user,user);
        int count=0;double total=risk,dayNet=0;
        long today=Math.floorDiv(System.currentTimeMillis()+19800000,86400000);
        for(String row:rows){
            JsonNode r=parse(row);
            if("OPEN".equals(status(r))){
                count++;
                String symbol=r.path("sym").asText();
                double e=value(r,"entry","price"),sl=r.path("slNow").asDouble(r.path("sl").asDouble(Double.NaN)),u=value(r,"units","posUnits");
                double openRisk=(e-sl)*(r.path("dir").asText().equals("BUY")?1:-1)*u+SPREAD.getOrDefault(symbol,Double.NaN)*u;
                if(!Double.isFinite(openRisk))reject("Existing open trade risk cannot be verified");
                total+=Math.max(0,openRisk);
            }else{
                long at=r.path("closedAt").asLong(r.path("ts").asLong(r.path("t").asLong()));
                if(Math.floorDiv(at+19800000,86400000)==today){
                    double net=value(r,"pnlUsd","pnl");if(Double.isFinite(net))dayNet+=net;
                }
            }
        }
        if(count>=5||total>4.000001||dayNet<=-8||total>8+dayNet)reject("Account paper risk or daily loss limit reached");
        if(jdbc.update("INSERT INTO paper_signal_keys(username,signal_key,record_type,source_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",user,key,type,id)==0)
            reject("This confirmed candle already has an entry");
    }
}

@RestController
@RequestMapping("/api/v1/paper")
class PaperTradingController {
    private final AuthService auth;private final PaperTradingService paper;
    PaperTradingController(AuthService auth,PaperTradingService paper){this.auth=auth;this.paper=paper;}
    @GetMapping("/ledger")
    List<Map<String,Object>> ledger(HttpServletRequest request,
            @RequestParam(defaultValue="1000") int limit,@RequestParam(defaultValue="0") int offset){
        var u=auth.require(request,false);auth.mayWrite(u,"low-profit");
        return paper.readLedger(u.username(),Math.max(1,Math.min(1000,limit)),Math.max(0,offset));
    }
    @PostMapping("/lease")
    Map<String,Object> lease(HttpServletRequest request){
        var identity=auth.require(request,true);auth.mayWrite(identity,"low-profit");
        return Map.of("owned",paper.lease(identity.username(),request.getHeader("X-Paper-Engine")));
    }
}
