package com.riyanlab;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.junit.jupiter.api.Test;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
class NextWeekCalendarTest {
 private final ObjectMapper json=new ObjectMapper();
 private record Reply(int statusCode,String body,HttpHeaders headers) implements HttpResponse<String>{
  public HttpRequest request(){return null;}
  public Optional<HttpResponse<String>> previousResponse(){return Optional.empty();}
  public Optional<javax.net.ssl.SSLSession> sslSession(){return Optional.empty();}
  public java.net.URI uri(){return java.net.URI.create(NextWeekCalendar.URL);}
  public HttpClient.Version version(){return HttpClient.Version.HTTP_1_1;}
 }
 private HttpResponse<String> reply(int status,String body){return new Reply(status,body,HttpHeaders.of(Map.of(),(a,b)->true));}
 private ArrayNode week(long anyTimeInWeek){
  return json.createArrayNode().add(json.createObjectNode().put("title","Non-Farm Employment Change").put("country","USD").put("impact","High")
   .put("date",EconomicCalendar.weekStart(anyTimeInWeek).plusDays(5).plusHours(8).plusMinutes(30).toOffsetDateTime().toString()));
 }
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void previewOnlyAtWeekEndValidatedAndRateLimited()throws Exception{
  long wednesday=Instant.parse("2026-11-11T15:00:00Z").toEpochMilli(),saturday=Instant.parse("2026-11-14T03:00:00Z").toEpochMilli();
  var now=new AtomicLong(wednesday);var client=mock(HttpClient.class);
  long nextWeek=saturday+3*86400000L;
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(reply(200,week(nextWeek).toString()));
  var preview=new NextWeekCalendar(json,client,now::get);
  var out=new LinkedHashMap<String,Object>();preview.attach(out);
  assertTrue(out.isEmpty(),"midweek makes no request");verify(client,never()).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  now.set(saturday);preview.attach(out);
  assertEquals(1,((JsonNode)out.get("nextWeekCalendar")).size());
  out.clear();preview.attach(out);verify(client,times(1)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  assertTrue(out.containsKey("nextWeekCalendar"),"cached for an hour");
  // A schedule for the wrong week is rejected; a rate limit waits six hours.
  now.addAndGet(NextWeekCalendar.SUCCESS_INTERVAL);
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(reply(429,""));
  out.clear();preview.attach(out);assertTrue(out.containsKey("nextWeekCalendar"),"previous valid preview kept");
  now.addAndGet(3600000);out.clear();preview.attach(out);
  verify(client,times(2)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  var fresh=new NextWeekCalendar(json,client,()->saturday);
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(reply(200,week(saturday).toString()));
  out.clear();fresh.attach(out);assertFalse(out.containsKey("nextWeekCalendar"),"this week's file is not shown as next week");
 }
}
