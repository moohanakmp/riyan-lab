package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@RestController
@RequestMapping("/api/v1")
public class RecordController {
    private static final Map<String,String> TABLES=Map.ofEntries(
        Map.entry("auto-signals","auto_signals"),
        Map.entry("manual-signals","manual_signals"),
        Map.entry("low-profit","low_profit_signals"),
        Map.entry("analysis","analysis_reports"),
        Map.entry("seven-day","seven_day_predictions"),
        Map.entry("pnl","pnl_reports"),
        Map.entry("gold-calls","gold_predictions_actuals"),
        Map.entry("research","research_reports"),
        Map.entry("tab-state","tab_states"),
        Map.entry("news-alerts","news_alerts"),
        Map.entry("user-state","user_states"),
        Map.entry("basket-sessions","basket_scalp_sessions"),
        Map.entry("basket-positions","basket_scalp_positions"),
        Map.entry("basket-events","basket_scalp_events"),
        Map.entry("basket-replays","basket_scalp_replays")
    );
    private final JdbcTemplate jdbc;
    private final AuthService auth;
    public RecordController(JdbcTemplate jdbc,AuthService auth) {
        this.jdbc=jdbc;this.auth=auth;
    }
    private String table(String type) {
        String mapped=TABLES.get(type);
        if(mapped==null)throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Unknown record type");
        return ""+mapped;
    }
    private boolean basketType(String type) {
        return Set.of("basket-sessions","basket-positions","basket-events").contains(type);
    }
    private void scope(AuthService.Identity identity,String type,String sourceId) {
        if(basketType(type) && !sourceId.startsWith(identity.username()+"--"))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,"Basket paper ledger is user-owned");
        if("user-state".equals(type) && !"admin".equals(identity.role()) &&
            !sourceId.startsWith(identity.username()+":") &&
            !sourceId.matches(java.util.regex.Pattern.quote(identity.username())+"--id-[a-f0-9]{64}"))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,"User-scoped key required");
    }
    @GetMapping("/health")
    public Map<String,String> health() {return Map.of("status","UP");}

    @GetMapping("/records/{type}")
    public List<Map<String,Object>> list(@PathVariable String type,HttpServletRequest request,
               @RequestParam(defaultValue="200") int limit) {
        AuthService.Identity identity=auth.require(request,false);
        auth.mayRead(identity,type);
        String sql="SELECT source_id,payload::text AS payload,created_by,updated_by,created_at,updated_at FROM "
            +table(type);
        if (("user-state".equals(type) || basketType(type)) && !"admin".equals(identity.role()))
            return jdbc.queryForList(sql+" WHERE created_by=? ORDER BY updated_at DESC LIMIT ?",
                identity.username(),Math.max(1,Math.min(limit,1000)));
        return jdbc.queryForList(sql+" ORDER BY updated_at DESC LIMIT ?",Math.max(1,Math.min(limit,1000)));
    }

    private String field(JsonNode node,String... keys) {
        for(String key:keys)if(node.hasNonNull(key) && !node.get(key).isContainerNode())return node.get(key).asText();
        return null;
    }
    private BigDecimal number(JsonNode node,String... keys) {
        String value=field(node,keys);
        if(value==null || value.isBlank())return null;
        try{return new BigDecimal(value);}catch(NumberFormatException e){return null;}
    }
    private Timestamp timestamp(JsonNode node) {
        JsonNode n=node.path("ts");
        if(n.isMissingNode())n=node.path("t");
        if(n.isNumber()) {
            try {
                long number=n.asLong();
                return Timestamp.from(number>100000000000L?Instant.ofEpochMilli(number):Instant.ofEpochSecond(number));
            } catch(RuntimeException ignored) {}
        }
        return Timestamp.from(Instant.now());
    }

    @PutMapping("/records/{type}/{sourceId}")
    @Transactional
    public ResponseEntity<Map<String,Object>> put(@PathVariable String type,
           @PathVariable String sourceId,HttpServletRequest request,@RequestBody JsonNode payload) {
        AuthService.Identity identity=auth.require(request,true);
        auth.mayWrite(identity,type);
        scope(identity,type,sourceId);
        if(sourceId.isBlank()||sourceId.length()>200 || !payload.isObject() ||
           payload.toString().length()>1_000_000) return ResponseEntity.badRequest().build();
        String target=table(type),raw=payload.toString();
        List<String> previous=jdbc.query("SELECT payload::text FROM "+target+" WHERE source_id=? FOR UPDATE",
            (rs,rowNum)->rs.getString(1),sourceId);
        if(!previous.isEmpty()) {
            // Compare jsonb semantically, not key order or formatting.
            Boolean unchanged=jdbc.queryForObject("SELECT ?::jsonb=?::jsonb",Boolean.class,previous.get(0),raw);
            if(Boolean.TRUE.equals(unchanged)) return ResponseEntity.ok(Map.of("saved",true,"unchanged",true,"sourceId",sourceId));
        }
        String conditions=payload.path("conditions").isMissingNode()?null:payload.path("conditions").toString();
        String reason=field(payload,"reason","strategy");
        if(reason==null && payload.path("conditions").isArray()) {
            List<String> explanations=new ArrayList<>();
            for(JsonNode condition:payload.path("conditions"))
                if(explanations.size()<12)explanations.add(condition.isTextual()?condition.asText():condition.toString());
            reason=String.join("; ",explanations);
        }
        if(reason==null)reason=field(payload,"why","setup");
        String sym=field(payload,"sym","symbol");
        String dir=field(payload,"dir","direction");
        String state=field(payload,"outcome","status");
        jdbc.update("""
            INSERT INTO %s (source_id,symbol,direction,status,event_time,payload,created_by,updated_by,reason,timeframe,
                 entry_price,stop_loss,take_profit_1,take_profit_2,take_profit_3,signal_conditions)
            VALUES(?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?,?,?,?::jsonb)
            ON CONFLICT(source_id) DO UPDATE SET symbol=EXCLUDED.symbol,direction=EXCLUDED.direction,status=EXCLUDED.status,
                 event_time=EXCLUDED.event_time,payload=EXCLUDED.payload,updated_by=EXCLUDED.updated_by,reason=EXCLUDED.reason,
                 timeframe=EXCLUDED.timeframe,entry_price=EXCLUDED.entry_price,stop_loss=EXCLUDED.stop_loss,
                 take_profit_1=EXCLUDED.take_profit_1,take_profit_2=EXCLUDED.take_profit_2,
                 take_profit_3=EXCLUDED.take_profit_3,signal_conditions=EXCLUDED.signal_conditions,updated_at=now()
            """.formatted(target),
            sourceId,sym,dir,state,timestamp(payload),raw,identity.username(),identity.username(),
            reason,field(payload,"tf","timeframe"),
            number(payload,"entry","entryPrice","price"),number(payload,"sl","stopLoss"),
            number(payload,"tp1","takeProfit1","tp"),number(payload,"tp2","takeProfit2"),
            number(payload,"tp3","takeProfit3"),conditions);
        jdbc.update("""
            INSERT INTO audit_events(record_type,source_id,action,actor,old_payload,new_payload)
            VALUES(?,?,?, ?,?::jsonb,?::jsonb)
            """,type,sourceId,previous.isEmpty()?"CREATE":"UPDATE",identity.username(),
            previous.isEmpty()?null:previous.get(0),raw);
        auth.activity(identity.username(),previous.isEmpty()?"RECORD_CREATED":"RECORD_UPDATED",type,sourceId,
            "{\"role\":\""+identity.role()+"\"}");
        return ResponseEntity.ok(Map.of("saved",true,"sourceId",sourceId));
    }

    @GetMapping("/audit")
    public List<Map<String,Object>> audit(HttpServletRequest request,@RequestParam(defaultValue="100") int limit) {
        auth.admin(request,false);
        return jdbc.queryForList("""
           SELECT record_type,source_id,action,actor,event_time,old_payload::text AS old_payload,
                  new_payload::text AS new_payload FROM audit_events
           ORDER BY id DESC LIMIT ?
           """,Math.max(1,Math.min(limit,1000)));
    }
    @GetMapping("/activity")
    public List<Map<String,Object>> activity(HttpServletRequest request,@RequestParam(defaultValue="100") int limit) {
        auth.admin(request,false);
        return jdbc.queryForList("""
           SELECT username,action,entity_type,entity_id,details::text AS details,created_at
           FROM user_activity ORDER BY id DESC LIMIT ?
           """,Math.max(1,Math.min(limit,1000)));
    }
}
