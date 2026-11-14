package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import org.springframework.stereotype.Service;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.function.LongSupplier;

/**
 * Display-only preview of next week's published schedule, shown when the current
 * calendar week has no events left (Friday evening to Sunday). It never feeds the
 * news-risk gate: entries keep using the validated current-week schedule only.
 */
@Service
public class NextWeekCalendar {
    static final String URL="https://nfs.faireconomy.media/ff_calendar_nextweek.json";
    static final long SUCCESS_INTERVAL=3600000,FAILURE_INTERVAL=3*3600000,RATE_LIMIT_INTERVAL=6*3600000;
    private final ObjectMapper json;private final HttpClient client;private final LongSupplier clock;
    private JsonNode preview;private long fetchedAt,nextAttempt;private String error="";
    @org.springframework.beans.factory.annotation.Autowired
    public NextWeekCalendar(ObjectMapper json){this(json,HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).version(HttpClient.Version.HTTP_1_1).build(),System::currentTimeMillis);}
    NextWeekCalendar(ObjectMapper json,HttpClient client,LongSupplier clock){this.json=json;this.client=client;this.clock=clock;}

    /** Only near the end of the week, when the current schedule has nothing left to show. */
    static boolean inPreviewWindow(long now){
        var start=EconomicCalendar.weekStart(now);
        return now>=start.plusDays(5).plusHours(12).toInstant().toEpochMilli();
    }
    public synchronized void attach(Map<String,Object> out){
        long now=clock.getAsLong();
        long nextStart=EconomicCalendar.weekStart(now).plusWeeks(1).toInstant().toEpochMilli();
        if(!inPreviewWindow(now))return;
        if(now>=nextAttempt)refresh(now,nextStart);
        if(preview!=null&&EconomicCalendar.weekStart(Instant.parse(preview.get(0).path("date").asText()).toEpochMilli()).toInstant().toEpochMilli()==nextStart){
            out.put("nextWeekCalendar",preview.deepCopy());out.put("nextWeekFetchedAt",fetchedAt);
        }else if(!error.isBlank())out.put("nextWeekError",error);
    }
    private void refresh(long now,long nextStart){
        nextAttempt=now+FAILURE_INTERVAL;
        try{
            var response=client.send(HttpRequest.newBuilder(URI.create(URL)).timeout(Duration.ofSeconds(8))
                .header("User-Agent","RiyanLabCalendar/1.0").header("Accept","application/json").GET().build(),HttpResponse.BodyHandlers.ofString());
            if(response.statusCode()==429){nextAttempt=now+Math.max(RATE_LIMIT_INTERVAL,MarketDataController.retryDelay(response.headers()));error="Next-week schedule rate limited";return;}
            if(response.statusCode()!=200||response.body().length()>1_000_000){error="Next-week schedule not published yet";return;}
            // Validate against next week's boundaries with the same rules as the live schedule.
            preview=EconomicCalendar.validate(json.readTree(response.body()),nextStart+3600000,json);
            fetchedAt=now;nextAttempt=now+SUCCESS_INTERVAL;error="";
        }catch(Exception e){
            if(e instanceof InterruptedException)Thread.currentThread().interrupt();
            error="Next-week schedule unavailable";
        }
    }
}
