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
 * Render free sleeps after 15 minutes without incoming requests. The scheduled GitHub ping
 * (approved 2026-11-14: weekday market hours only) runs far less often than scheduled, so once
 * the service is awake it also pings its own public health URL every 10 minutes inside the
 * same approved window: Monday–Friday 06:00–21:00 UTC (11:30–02:30 IST). Outside the window
 * it does nothing and the service can sleep as before. It cannot wake a sleeping service.
 */
@Component
public class KeepAwake {
    @Value("${app.keep-awake.enabled:true}") boolean enabled;
    @Value("${RENDER_EXTERNAL_URL:}") String url;
    // Approved for staging only; production keeps sleeping so the free instance hours last.
    @Value("${APP_ENV:production}") String env;
    private ScheduledExecutorService timer;
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static boolean inWindow(Instant now){
        var t=now.atZone(ZoneOffset.UTC);
        return t.getDayOfWeek().getValue()<=5&&t.getHour()>=6&&t.getHour()<21;
    }
    @EventListener(ApplicationReadyEvent.class)
    public void start(){
        if(!enabled||!"staging".equalsIgnoreCase(env)||url==null||!url.startsWith("https://")||timer!=null)return;
        timer=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"keep-awake");t.setDaemon(true);return t;});
        timer.scheduleWithFixedDelay(this::ping,10,10,TimeUnit.MINUTES);
        System.out.println(Instant.now()+" Keep-awake on for weekday market hours (06:00-21:00 UTC)");
    }
    void ping(){
        if(!inWindow(Instant.now()))return;
        try{client.send(HttpRequest.newBuilder(URI.create(url.replaceAll("/+$","")+"/api/v1/health")).header("User-Agent","RiyanLab/1.0 keep-awake").timeout(Duration.ofSeconds(20)).GET().build(),HttpResponse.BodyHandlers.discarding());}
        catch(Exception e){System.out.println(Instant.now()+" Keep-awake ping failed: "+e.getMessage());}
    }
    @PreDestroy public void stop(){if(timer!=null)timer.shutdownNow();}
}
