package com.riyanlab;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
class EconomicCalendarTest {
 private final ObjectMapper json=new ObjectMapper();
 private final long start=Instant.parse("2026-10-19T15:00:00Z").toEpochMilli();
 private ArrayNode events(long now){return json.createArrayNode().add(json.createObjectNode().put("title","Test USD release").put("country","USD").put("impact","High").put("date",EconomicCalendar.weekStart(now).plusDays(2).plusHours(8).plusMinutes(30).toOffsetDateTime().toString()));}
 @SuppressWarnings("unchecked") private HttpResponse<String> response(int status,String body,Map<String,List<String>> headers){
  HttpResponse<String> r=mock(HttpResponse.class);when(r.statusCode()).thenReturn(status);when(r.body()).thenReturn(body);when(r.headers()).thenReturn(HttpHeaders.of(headers,(a,b)->true));return r;
 }
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void sharedCacheRateLimitExpiryAnd304RecoveryKeepTheTrueClock()throws Exception{
  var now=new AtomicLong(start);var client=mock(HttpClient.class);
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response(200,events(start).toString(),Map.of("ETag",List.of("\"v1\""))));
  var feed=new EconomicCalendar(null,json,client,now::get);
  var initial=feed.view();assertEquals(true,initial.get("ready"));assertEquals(start,initial.get("calendarAt"));feed.view();feed.peek();
  verify(client,times(1)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  now.addAndGet(EconomicCalendar.REFRESH);when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response(429,"",Map.of("Retry-After",List.of("1200"))));
  var delayed=feed.view();assertEquals("DEGRADED",delayed.get("calendarState"));assertEquals(start,delayed.get("calendarAt"));
  now.set(start+EconomicCalendar.TTL+1);var stale=feed.view();assertEquals(false,stale.get("ready"));assertFalse(stale.containsKey("calendar"));assertEquals(start,stale.get("fetchedAt"));
  verify(client,times(2)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  now.set(start+35*60000L);when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response(304,"",Map.of()));
  assertEquals(now.get(),feed.view().get("calendarAt"));
  var requests=org.mockito.ArgumentCaptor.forClass(HttpRequest.class);verify(client,times(3)).send(requests.capture(),any(HttpResponse.BodyHandler.class));
  assertEquals("\"v1\"",requests.getAllValues().get(2).headers().firstValue("If-None-Match").orElseThrow());
 }
 @Test void malformedPartialAndPreviousWeekCalendarsAreRejected(){
  assertThrows(RuntimeException.class,()->EconomicCalendar.validate(json.createArrayNode(),start,json));
  var bad=events(start);((ObjectNode)bad.get(0)).put("impact","unknown");assertThrows(RuntimeException.class,()->EconomicCalendar.validate(bad,start,json));
  var noUsd=events(start);((ObjectNode)noUsd.get(0)).put("country","EUR");assertThrows(RuntimeException.class,()->EconomicCalendar.validate(noUsd,start,json));
  assertThrows(RuntimeException.class,()->EconomicCalendar.validate(events(start-7*86400000L),start,json));
  var conflict=events(start);var other=conflict.get(0).deepCopy();((ObjectNode)other).put("impact","Low");conflict.add(other);
  assertThrows(RuntimeException.class,()->EconomicCalendar.validate(conflict,start,json));
  var invalidDate=events(start);((ObjectNode)invalidDate.get(0)).put("date","2026-10-20 08:30");assertThrows(RuntimeException.class,()->EconomicCalendar.validate(invalidDate,start,json));
 }
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void weeklyCoverageExpiresEvenIfARecentlyFetchedSnapshotCrossesSunday()throws Exception{
  long saturday=Instant.parse("2026-10-25T03:00:00Z").toEpochMilli();var now=new AtomicLong(saturday);var client=mock(HttpClient.class);
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response(200,events(saturday).toString(),Map.of()));
  var feed=new EconomicCalendar(null,json,client,now::get);assertEquals(true,feed.view().get("ready"));
  now.set(Instant.parse("2026-10-25T03:20:00Z").toEpochMilli());assertEquals(false,feed.peek().get("ready"),"45-minute entry horizon requires next-week coverage");
  now.set(Instant.parse("2026-10-25T04:01:00Z").toEpochMilli());assertEquals(false,feed.peek().get("ready"));
  assertEquals(169,Duration.between(EconomicCalendar.weekStart(Instant.parse("2026-11-03T12:00:00Z").toEpochMilli()),EconomicCalendar.weekStart(Instant.parse("2026-11-03T12:00:00Z").toEpochMilli()).plusWeeks(1)).toHours(),"DST changes the UTC length of the covered week");
 }
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void restartRestoresRetryWindowAndDoesNotRefreshStaleDataLocally()throws Exception{
  var jdbc=mock(JdbcTemplate.class);var client=mock(HttpClient.class);var now=new AtomicLong(start+20*60000);
  var row=new HashMap<String,Object>();row.put("payload",events(start).toString());row.put("fetched",start);row.put("retry",start+40*60000);row.put("etag","\"saved\"");row.put("last_error","Calendar provider rate limited (HTTP 429)");row.put("last_http_status",429);
  when(jdbc.queryForList(anyString())).thenReturn(List.of(row));
  var feed=new EconomicCalendar(jdbc,json,client,now::get);assertEquals(start,feed.view().get("calendarAt"));
  now.set(start+31*60000);var restarted=new EconomicCalendar(jdbc,json,client,now::get);
  assertEquals(false,restarted.view().get("ready"));assertEquals(start,restarted.peek().get("fetchedAt"));verifyNoInteractions(client);
  row.put("fetched",now.get()+60000);var future=new EconomicCalendar(jdbc,json,client,now::get);assertEquals(false,future.peek().get("ready"));
 }
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void invalidNotModifiedOrMalformedSuccessCannotEnableEntries()throws Exception{
  var client=mock(HttpClient.class);when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response(304,"",Map.of()));
  var feed=new EconomicCalendar(null,json,client,()->start);assertEquals(false,feed.view().get("ready"));
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response(200,"[{\"title\":\"missing fields\"}]",Map.of()));
  assertEquals(false,new EconomicCalendar(null,json,client,()->start).view().get("ready"));
 }
}
