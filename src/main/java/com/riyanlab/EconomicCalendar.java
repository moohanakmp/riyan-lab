package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.function.LongSupplier;

/** One trusted schedule and freshness clock for every browser and server engine. */
@Service
public class EconomicCalendar {
    static final String URL="https://nfs.faireconomy.media/ff_calendar_thisweek.json";
    static final long TTL=1800000,REFRESH=900000;
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final HttpClient client;private final LongSupplier clock;
    private JsonNode calendar;private long fetchedAt,nextAttempt;private String etag="",error="Calendar not checked yet";private int httpStatus,failures;private boolean loaded;
    @org.springframework.beans.factory.annotation.Autowired
    public EconomicCalendar(JdbcTemplate jdbc,ObjectMapper json){this(jdbc,json,HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).version(HttpClient.Version.HTTP_1_1).build(),System::currentTimeMillis);}
    EconomicCalendar(JdbcTemplate jdbc,ObjectMapper json,HttpClient client,LongSupplier clock){this.jdbc=jdbc;this.json=json;this.client=client;this.clock=clock;}
    public synchronized Map<String,Object> view(){
        long now=clock.getAsLong();restore(now);
        if(now>=nextAttempt){
            if(claim(now))refresh(now);
            else{loaded=false;restore(now);}
        }
        return snapshot(clock.getAsLong());
    }
    private boolean claim(long now){
        if(jdbc==null)return true;
        // A short durable reservation also coalesces overlapping deployment instances.
        return jdbc.update("""
            INSERT INTO economic_calendar_cache(id,next_attempt_at) VALUES(1,?)
            ON CONFLICT(id) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at
            WHERE economic_calendar_cache.next_attempt_at<=?
            """,java.sql.Timestamp.from(Instant.ofEpochMilli(now+60000)),java.sql.Timestamp.from(Instant.ofEpochMilli(now)))>0;
    }
    public synchronized Map<String,Object> peek(){restore(clock.getAsLong());return snapshot(clock.getAsLong());}
    private void restore(long now){
        if(loaded)return;
        if(jdbc!=null){
            var rows=jdbc.queryForList("SELECT payload::text AS payload,extract(epoch FROM fetched_at)*1000 AS fetched,extract(epoch FROM next_attempt_at)*1000 AS retry,etag,last_error,last_http_status FROM economic_calendar_cache WHERE id=1");
            if(!rows.isEmpty()){
                var r=rows.getFirst();nextAttempt=((Number)r.get("retry")).longValue();etag=(String)r.get("etag");error=(String)r.get("last_error");httpStatus=((Number)r.get("last_http_status")).intValue();
                try{fetchedAt=r.get("fetched")==null?0:((Number)r.get("fetched")).longValue();if(r.get("payload")!=null)calendar=validate(json.readTree((String)r.get("payload")),now,json);}catch(Exception e){calendar=null;fetchedAt=0;error="Stored calendar is invalid or belongs to another week";etag="";}
                // Corrupt future timestamps must never postpone checking indefinitely.
                if(nextAttempt>now+3600000||fetchedAt>now){calendar=null;fetchedAt=0;nextAttempt=now;etag="";error="Invalid calendar clock";}
            }
        }
        loaded=true;
    }
    private void refresh(long started){
        nextAttempt=started+60000;
        try{
            var request=HttpRequest.newBuilder(URI.create(URL)).timeout(Duration.ofSeconds(8))
                .header("User-Agent","RiyanLabCalendar/1.0").header("Accept","application/json");
            if(calendar!=null&&!etag.isBlank())request.header("If-None-Match",etag);
            var response=client.send(request.GET().build(),HttpResponse.BodyHandlers.ofString());httpStatus=response.statusCode();
            long now=clock.getAsLong();
            if(httpStatus==429){
                failures++;nextAttempt=now+Math.max(backoff(),MarketDataController.retryDelay(response.headers()));
                error="Calendar provider rate limited (HTTP 429)";
            }else if(httpStatus==304){
                if(calendar==null||etag.isBlank())throw new IllegalArgumentException("Unverifiable not-modified response");
                calendar=validate(calendar,now,json);fetchedAt=now;nextAttempt=now+REFRESH;failures=0;error="";
            }else if(httpStatus==200){
                String body=response.body();if(body.length()>1_000_000)throw new IllegalArgumentException("Calendar too large");
                JsonNode candidate=validate(json.readTree(body),now,json);
                String tag=response.headers().firstValue("ETag").orElse("");if(tag.length()>500||tag.chars().anyMatch(c->c<32||c==127))tag="";
                calendar=candidate;etag=tag;fetchedAt=now;nextAttempt=now+REFRESH;failures=0;error="";
            }else{failures++;nextAttempt=now+backoff();error="Calendar provider unavailable (HTTP "+httpStatus+")";}
        }catch(Exception e){
            if(e instanceof InterruptedException)Thread.currentThread().interrupt();
            failures++;nextAttempt=clock.getAsLong()+backoff();error="Calendar request failed: "+e.getClass().getSimpleName();
        }
        persist();
    }
    private long backoff(){return Math.min(900000,60000L*(1L<<Math.min(4,Math.max(0,failures-1))));}
    private void persist(){
        if(jdbc==null)return;
        jdbc.update("""
            INSERT INTO economic_calendar_cache(id,payload,fetched_at,etag,next_attempt_at,last_error,last_http_status)
            VALUES(1,?::jsonb,?,?,?, ?,?) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,
            fetched_at=EXCLUDED.fetched_at,etag=EXCLUDED.etag,next_attempt_at=EXCLUDED.next_attempt_at,
            last_error=EXCLUDED.last_error,last_http_status=EXCLUDED.last_http_status,updated_at=now()
            """,calendar==null?null:calendar.toString(),fetchedAt==0?null:java.sql.Timestamp.from(Instant.ofEpochMilli(fetchedAt)),etag,
            java.sql.Timestamp.from(Instant.ofEpochMilli(nextAttempt)),error,httpStatus);
    }
    private Map<String,Object> snapshot(long now){
        long end=calendar==null?0:weekStart(Instant.parse(calendar.get(0).path("date").asText()).toEpochMilli()).plusWeeks(1).toInstant().toEpochMilli();
        boolean ready=calendar!=null&&fetchedAt>0&&fetchedAt<=now&&now-fetchedAt<TTL&&now+45*60000<end;
        String reason=ready?error:error.isBlank()?"Calendar stale or weekly coverage ended — new entries paused":error;
        var out=new LinkedHashMap<String,Object>();
        out.put("calendarAt",ready?fetchedAt:0);out.put("calendarError",reason);out.put("calendarState",ready?(error.isBlank()?"READY":"DEGRADED"):"PAUSED");
        out.put("ready",ready);out.put("fetchedAt",fetchedAt);out.put("expiresAt",calendar==null?0:Math.min(fetchedAt+TTL,end-45*60000));out.put("retryAt",nextAttempt);
        out.put("source","Forex Factory / Fair Economy");out.put("sourceUrl","https://www.forexfactory.com/calendar");out.put("eventCount",calendar==null?0:calendar.size());out.put("httpStatus",httpStatus);
        if(ready)out.put("calendar",calendar.deepCopy());
        return out;
    }
    static ZonedDateTime weekStart(long now){
        var date=Instant.ofEpochMilli(now).atZone(ZoneId.of("America/New_York")).toLocalDate();
        return date.minusDays(date.getDayOfWeek().getValue()%7).atStartOfDay(ZoneId.of("America/New_York"));
    }
    static ArrayNode validate(JsonNode input,long now,ObjectMapper json){
        if(!input.isArray()||input.isEmpty()||input.size()>2000)throw new IllegalArgumentException("Empty or malformed calendar");
        long start=weekStart(now).toInstant().toEpochMilli(),end=weekStart(now).plusWeeks(1).toInstant().toEpochMilli();
        var unique=new TreeMap<String,ObjectNode>();boolean usd=false;
        for(JsonNode ev:input){
            String title=ev.path("title").asText(),country=ev.path("country").asText(),impact=ev.path("impact").asText(),date=ev.path("date").asText();
            long at=OffsetDateTime.parse(date).toInstant().toEpochMilli();
            if(title.isBlank()||title.length()>300||title.contains("<")||title.contains(">")||!country.matches("[A-Z]{3}|All")||
               !Set.of("High","Medium","Low","Holiday","Non-Economic").contains(impact)||at<start||at>=end)throw new IllegalArgumentException("Invalid calendar coverage or event");
            ObjectNode event=json.createObjectNode().put("title",title).put("country",country).put("date",Instant.ofEpochMilli(at).toString()).put("impact",impact);
            for(String field:List.of("forecast","previous","actual")){
                String value=ev.path(field).asText("");if(value.length()>100||value.contains("<")||value.contains(">"))throw new IllegalArgumentException("Invalid event value");event.put(field,value);
            }
            usd|=country.equals("USD");String key=at+"|"+country+"|"+title;
            ObjectNode old=unique.put(key,event);if(old!=null&&!old.equals(event))throw new IllegalArgumentException("Conflicting calendar events");
        }
        if(!usd)throw new IllegalArgumentException("USD calendar coverage missing");
        ArrayNode out=json.createArrayNode();unique.values().forEach(out::add);return out;
    }
}
