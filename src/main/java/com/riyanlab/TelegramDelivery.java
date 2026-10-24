package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Durable entry notifications for both browser and background accepted paper trades. */
@RestController
@RequestMapping("/api/v1/telegram")
public class TelegramDelivery {
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final AuthService auth;private final HttpClient client;
    private final AtomicBoolean busy=new AtomicBoolean();
    @org.springframework.beans.factory.annotation.Autowired
    public TelegramDelivery(JdbcTemplate jdbc,ObjectMapper json,AuthService auth){this(jdbc,json,auth,HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build());}
    TelegramDelivery(JdbcTemplate jdbc,ObjectMapper json,AuthService auth,HttpClient client){this.jdbc=jdbc;this.json=json;this.auth=auth;this.client=client;}
    private AuthService.Identity user(HttpServletRequest request,boolean write){
        var u=auth.require(request,write);
        if(!Set.of("admin","user").contains(u.role()))throw new ResponseStatusException(HttpStatus.FORBIDDEN,"Telegram settings require a user account");
        return u;
    }
    @PostMapping("/settings") public Map<String,Object> settings(HttpServletRequest request,@RequestBody JsonNode input){
        var u=user(request,true);
        if(!input.path("enabled").isBoolean())throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid Telegram settings");
        boolean enabled=input.path("enabled").asBoolean();
        var old=jdbc.queryForList("SELECT bot_token,chat_id FROM telegram_settings WHERE username=?",u.username());
        String token=input.path("token").asText("").trim(),chat=input.path("chatId").asText("").trim();
        if(token.isEmpty()&&!old.isEmpty())token=(String)old.get(0).get("bot_token");
        if(chat.isEmpty()&&!old.isEmpty())chat=(String)old.get(0).get("chat_id");
        if(enabled&&(!token.matches("[0-9]{5,20}:[A-Za-z0-9_-]{20,100}")||!chat.matches("-?[0-9]{1,25}|@[A-Za-z0-9_]{5,100}")))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Enter a valid bot token and Telegram chat ID");
        if(token.length()>150||chat.length()>150)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid Telegram settings");
        jdbc.update("""
            INSERT INTO telegram_settings(username,enabled,bot_token,chat_id) VALUES(?,?,?,?)
            ON CONFLICT(username) DO UPDATE SET enabled=EXCLUDED.enabled,bot_token=EXCLUDED.bot_token,chat_id=EXCLUDED.chat_id,
            enabled_since=CASE WHEN NOT telegram_settings.enabled AND EXCLUDED.enabled THEN now() ELSE telegram_settings.enabled_since END,updated_at=now()
            """,u.username(),enabled,token,chat);
        return Map.of("saved",true,"enabled",enabled);
    }
    @GetMapping("/status") public Map<String,Object> status(HttpServletRequest request){
        var u=user(request,false);var config=jdbc.queryForList("SELECT enabled,chat_id FROM telegram_settings WHERE username=?",u.username());
        var counts=jdbc.queryForList("SELECT state,count(*) AS count FROM telegram_deliveries WHERE username=? GROUP BY state",u.username());
        var latest=jdbc.queryForList("SELECT record_type,source_id,state,attempts,last_error,sent_at FROM telegram_deliveries WHERE username=? ORDER BY id DESC LIMIT 5",u.username());
        return Map.of("configured",!config.isEmpty(),"enabled",!config.isEmpty()&&Boolean.TRUE.equals(config.get(0).get("enabled")),"chatId",config.isEmpty()?"":config.get(0).get("chat_id"),"counts",counts,"latest",latest);
    }
    @PostMapping("/test") public Map<String,Object> test(HttpServletRequest request){
        var u=user(request,true);var settings=jdbc.queryForList("SELECT bot_token,chat_id FROM telegram_settings WHERE username=? AND enabled",u.username());
        if(settings.isEmpty())throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Enable and save Telegram first");
        var c=settings.get(0);return send((String)c.get("bot_token"),(String)c.get("chat_id"),"Kalai Markets — server Telegram alerts connected. Confirmed paper entries will include their original trigger time.").view();
    }
    @PostMapping("/retry") public Map<String,Object> retry(HttpServletRequest request){
        var u=user(request,true);
        int count=jdbc.update("UPDATE telegram_deliveries SET state='RETRY',attempts=0,retry_at=now(),claim_id=NULL WHERE username=? AND state='FAILED' AND created_at>now()-interval '24 hours'",u.username());
        return Map.of("queued",count);
    }
    record Result(boolean ok,long messageId,String error,int retrySeconds){
        Map<String,Object> view(){return Map.of("ok",ok,"error",error,"messageId",messageId);}
    }
    Result send(String token,String chat,String message){
        try{
            var body=json.createObjectNode().put("chat_id",chat).put("text",message);
            var request=HttpRequest.newBuilder(URI.create("https://api.telegram.org/bot"+token+"/sendMessage")).timeout(Duration.ofSeconds(10)).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();
            var response=client.send(request,HttpResponse.BodyHandlers.ofString());
            JsonNode data=json.readTree(response.body());
            if(response.statusCode()==200&&data.path("ok").asBoolean()&&data.path("result").path("message_id").canConvertToLong())return new Result(true,data.path("result").path("message_id").asLong(),"",0);
            // Telegram descriptions only; never retain request URLs, bot tokens or raw bodies.
            String error=data.path("description").asText("Telegram rejected the message (HTTP "+response.statusCode()+")").replace(token,"[redacted]");
            return new Result(false,0,error.substring(0,Math.min(280,error.length())),Math.min(86400,Math.max(30,data.path("parameters").path("retry_after").asInt(30))));
        }catch(Exception e){if(e instanceof InterruptedException)Thread.currentThread().interrupt();return new Result(false,0,"Telegram network request failed; delivery will retry",60);}
    }
    @Scheduled(initialDelay=15000,fixedDelay=15000) public void deliver(){
        if(!busy.compareAndSet(false,true))return;
        try{
            for(var entry:Map.of("auto-signals","auto_signals","manual-signals","manual_signals","low-profit","low_profit_signals").entrySet()){
                jdbc.update("""
                    INSERT INTO telegram_deliveries(username,record_type,source_id,payload)
                    SELECT r.created_by,?,r.source_id,r.payload FROM %s r
                    JOIN telegram_settings s ON s.username=r.created_by AND s.enabled
                    JOIN auth_users u ON u.username=s.username AND u.active AND u.role IN ('admin','user')
                    WHERE r.payload->>'accountingVersion'='2' AND r.created_at>now()-interval '24 hours'
                      AND (r.created_at>=s.enabled_since OR r.status='OPEN')
                    ON CONFLICT(username,record_type,source_id) DO NOTHING
                    """.formatted(entry.getValue()),entry.getKey());
            }
            jdbc.update("UPDATE telegram_deliveries SET state='FAILED',last_error='Delivery interrupted after final attempt; verify Telegram before retrying' WHERE state='SENDING' AND retry_at<=now() AND attempts>=5");
            var due=jdbc.queryForList("""
                SELECT d.id FROM telegram_deliveries d JOIN telegram_settings s ON s.username=d.username AND s.enabled
                JOIN auth_users u ON u.username=d.username AND u.active AND u.role IN ('admin','user')
                WHERE d.state IN ('PENDING','RETRY','SENDING') AND d.retry_at<=now() AND d.attempts<5
                ORDER BY d.retry_at,d.id LIMIT 10
                """);
            for(var item:due)deliverOne(((Number)item.get("id")).longValue());
        }catch(Exception ignored){/* Keep the worker alive; delivery failures are recorded per item. No credentials logged. */}
        finally{busy.set(false);}
    }
    void deliverOne(long id)throws Exception{
        String claim=UUID.randomUUID().toString();
        var rows=jdbc.queryForList("""
            UPDATE telegram_deliveries d SET state='SENDING',attempts=attempts+1,claim_id=?,retry_at=now()+interval '3 minutes'
            FROM telegram_settings s,auth_users u WHERE d.id=? AND s.username=d.username AND s.enabled
            AND u.username=d.username AND u.active AND u.role IN ('admin','user')
            AND d.state IN ('PENDING','RETRY','SENDING') AND d.retry_at<=now() AND d.attempts<5
            RETURNING d.payload::text AS payload,d.record_type,d.attempts,s.bot_token,s.chat_id
            """,claim,id);
        if(rows.isEmpty())return;
        var row=rows.get(0);Result result;
        try{result=send((String)row.get("bot_token"),(String)row.get("chat_id"),message((String)row.get("record_type"),json.readTree((String)row.get("payload"))));}
        catch(Exception ignored){result=new Result(false,0,"Invalid signal alert data",60);}
        int attempts=((Number)row.get("attempts")).intValue();
        if(result.ok())jdbc.update("UPDATE telegram_deliveries SET state='SENT',message_id=?,sent_at=now(),last_error='',claim_id=NULL WHERE id=? AND claim_id=?",result.messageId(),id,claim);
        else jdbc.update("UPDATE telegram_deliveries SET state=?,last_error=?,retry_at=now()+(? * interval '1 second'),claim_id=NULL WHERE id=? AND claim_id=?",attempts>=5?"FAILED":"RETRY",result.error(),Math.max(result.retrySeconds(),Math.min(1800,30*(1<<attempts))),id,claim);
    }
    static String message(String type,JsonNode r){
        boolean scalp=type.equals("low-profit");
        long at=r.path(scalp?"t":"ts").asLong();
        String when=at>0?Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Kolkata")).format(java.time.format.DateTimeFormatter.ofPattern("dd MMM yyyy HH:mm:ss 'IST'")):"Unavailable";
        StringBuilder text=new StringBuilder("PAPER SIGNAL — ").append(scalp?"Low Profit":type.equals("manual-signals")?"Manual":"Auto").append('\n').append(r.path("sym").asText()).append(' ').append(r.path("dir").asText()).append("\nTriggered: ").append(when).append("\nEntry ").append(r.path(scalp?"entry":"price").asText());
        if(scalp)text.append("\nTP ").append(r.path("tp").asText());
        else for(String target:List.of("tp1","tp2","tp3"))if(r.hasNonNull(target))text.append('\n').append(target.toUpperCase()).append(' ').append(r.path(target).asText());
        text.append("\nSL ").append(r.path("sl").asText()).append("\nLot ").append(r.path("lot").asText()).append("\nSignal ID ").append(r.path("id").asText()).append("\nOriginal entry notification; check current status before acting.");
        return text.toString();
    }
}
