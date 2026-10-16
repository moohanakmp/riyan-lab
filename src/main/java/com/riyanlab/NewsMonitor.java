package com.riyanlab;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;
import org.xml.sax.InputSource;
import java.io.StringReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;

@Component
@RestController
@RequestMapping("/api/v1/news")
public class NewsMonitor {
    private final JdbcTemplate jdbc;
    private final AuthService auth;
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8))
        .followRedirects(HttpClient.Redirect.NORMAL).build();
    private static final Map<String,String> TOPICS=Map.of(
        "XAUUSD","gold price US Federal Reserve inflation",
        "XAGUSD","silver commodities price inflation",
        "BTCUSD","bitcoin crypto market regulation"
    );
    public NewsMonitor(JdbcTemplate jdbc,AuthService auth){this.jdbc=jdbc;this.auth=auth;}

    @Scheduled(initialDelay=45000,fixedDelay=15*60*1000)
    public void poll() {
        TOPICS.forEach((symbol,topic)->{
            int count=0;String error=null;
            try {
                String q=URLEncoder.encode(topic+" when:1d",StandardCharsets.UTF_8);
                URI uri=URI.create("https://news.google.com/rss/search?q="+q+"&hl=en-US&gl=US&ceid=US%3Aen");
                HttpRequest request=HttpRequest.newBuilder(uri).GET()
                    .timeout(Duration.ofSeconds(12))
                    .header("User-Agent","RiyanLabNewsMonitor/1.0 (RSS reader)").build();
                HttpResponse<String> response=client.send(request,HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                if(response.statusCode()!=200)throw new IllegalStateException("HTTP "+response.statusCode());
                DocumentBuilderFactory factory=DocumentBuilderFactory.newInstance();
                factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
                factory.setFeature("http://xml.org/sax/features/external-general-entities",false);
                factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
                factory.setXIncludeAware(false);
                factory.setExpandEntityReferences(false);
                var doc=factory.newDocumentBuilder().parse(new InputSource(new StringReader(response.body())));
                NodeList items=doc.getElementsByTagName("item");
                for(int i=0;i<Math.min(items.getLength(),20);i++){
                    Node node=items.item(i);
                    if(!(node instanceof Element el))continue;
                    String headline=tag(el,"title"),url=tag(el,"link"),date=tag(el,"pubDate");
                    if(headline.isBlank()||url.isBlank())continue;
                    Instant published=null;
                    try{published=ZonedDateTime.parse(date,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant();}catch(Exception ignored){}
                    jdbc.update("""
                      INSERT INTO news_feed_items(symbol,headline,source_url,source_name,published_at)
                      VALUES(?,?,?,?,?) ON CONFLICT(symbol,source_url) DO UPDATE SET checked_at=now()
                    """,symbol,headline,url,"Google News RSS",published==null?null:java.sql.Timestamp.from(published));
                    count++;
                }
                if(count==0)error="Feed returned no parseable items";
            } catch(Exception ex){
                error=ex.getClass().getSimpleName()+": "+String.valueOf(ex.getMessage());
                if(error.length()>480)error=error.substring(0,480);
            }
            jdbc.update("INSERT INTO news_fetch_runs(source,symbol,status,found_count,error_message) VALUES(?,?,?,?,?)",
                "Google News RSS",symbol,error==null?"OK":"FAILED",count,error);
        });
    }
    private String tag(Element el,String tag){
        NodeList values=el.getElementsByTagName(tag);
        return values.getLength()>0 ? values.item(0).getTextContent().trim() : "";
    }
    @GetMapping("/latest")
    public List<Map<String,Object>> latest(HttpServletRequest request,@RequestParam(defaultValue="XAUUSD") String symbol){
        auth.require(request,false);
        if(!TOPICS.containsKey(symbol))throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        return jdbc.queryForList("""
          SELECT headline,source_url AS url,source_name,published_at,checked_at
          FROM news_feed_items WHERE symbol=? ORDER BY published_at DESC NULLS LAST LIMIT 20
        """,symbol);
    }
    @GetMapping("/status")
    public List<Map<String,Object>> status(HttpServletRequest request) {
        auth.admin(request,false);
        return jdbc.queryForList("""
          SELECT source,symbol,status,found_count,error_message,checked_at
          FROM news_fetch_runs ORDER BY id DESC LIMIT 30
        """);
    }
}
