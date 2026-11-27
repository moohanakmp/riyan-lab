package com.riyanlab;

import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.util.concurrent.*;

/**
 * Render free sleeps after 15 minutes without incoming requests, and a sleeping service runs no
 * scheduled work. While awake, the staging service pings its own public health URL every 10
 * minutes for the whole metals trading week: Sunday 18:00 to Friday 17:30 New York time
 * (about Monday 03:30 to Saturday 03:00 IST), including the daily one-hour metals break so the
 * service does not fall asleep overnight. The owner approved weekday market-hours keep-awake on
 * 2026-11-14; until 2026-11-26 the window was 06:00-21:00 UTC, which let the service sleep every
 * night and miss the Asian session. Outside the window (the weekend) it does nothing and the
 * service can sleep. It cannot wake a sleeping service: the first request after the weekend
 * (opening the app, or the MT5 EA) wakes it, and the window keeps it awake from then on.
 * Free tier budget: about 120 h a week of the 750 free instance hours a month.
 */
@Component
public class KeepAwake {
    @Value("${app.keep-awake.enabled:true}") boolean enabled;
    @Value("${RENDER_EXTERNAL_URL:}") String url;
    // Approved for staging only; production keeps sleeping so the free instance hours last.
    @Value("${APP_ENV:production}") String env;
    private ScheduledExecutorService timer;
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final String WINDOW_TEXT="Sunday 18:00 to Friday 17:30 New York time (about Monday 03:30 to Saturday 03:00 IST)";
    static boolean inWindow(Instant now){
        var t=now.atZone(ZoneId.of("America/New_York"));int d=t.getDayOfWeek().getValue(),m=t.getHour()*60+t.getMinute();
        if(d==6)return false;
        if(d==7)return m>=18*60;
        if(d==5)return m<17*60+30;
        return true;
    }
    @EventListener(ApplicationReadyEvent.class)
    public void start(){
        if(!enabled||!"staging".equalsIgnoreCase(env)||url==null||!url.startsWith("https://")||timer!=null)return;
        timer=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"keep-awake");t.setDaemon(true);return t;});
        timer.scheduleWithFixedDelay(this::ping,10,10,TimeUnit.MINUTES);
        System.out.println(Instant.now()+" Keep-awake on for the metals trading week: "+WINDOW_TEXT);
    }
    void ping(){
        if(!inWindow(Instant.now()))return;
        try{client.send(HttpRequest.newBuilder(URI.create(url.replaceAll("/+$","")+"/api/v1/health")).header("User-Agent","RiyanLab/1.0 keep-awake").timeout(Duration.ofSeconds(20)).GET().build(),HttpResponse.BodyHandlers.discarding());}
        catch(Exception e){System.out.println(Instant.now()+" Keep-awake ping failed: "+e.getMessage());}
    }
    @PreDestroy public void stop(){if(timer!=null)timer.shutdownNow();}
}
