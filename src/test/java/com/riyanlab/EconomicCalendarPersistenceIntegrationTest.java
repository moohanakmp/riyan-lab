package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import java.net.http.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
@SpringBootTest
@Transactional
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class EconomicCalendarPersistenceIntegrationTest {
 @Autowired JdbcTemplate jdbc;
 @Autowired ObjectMapper json;
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void databaseSnapshotAndRateLimitSurviveAServiceRestart()throws Exception{
  jdbc.update("DELETE FROM economic_calendar_cache WHERE id=1");
  var now=new AtomicLong(java.time.Instant.parse("2026-10-19T15:00:00Z").toEpochMilli());var client=mock(HttpClient.class);var response=mock(HttpResponse.class);
  var events=json.createArrayNode().add(json.createObjectNode().put("title","Integration USD event").put("country","USD").put("impact","High").put("date",EconomicCalendar.weekStart(now.get()).plusDays(2).plusHours(8).toOffsetDateTime().toString()));
  when(response.statusCode()).thenReturn(200);when(response.body()).thenReturn(events.toString());when(response.headers()).thenReturn(HttpHeaders.of(Map.of("ETag",List.of("\"snapshot\"")),(a,b)->true));
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response);
  var feed=new EconomicCalendar(jdbc,json,client,now::get);assertEquals(true,feed.view().get("ready"));
  long fetched=now.get();now.addAndGet(EconomicCalendar.REFRESH);
  when(response.statusCode()).thenReturn(429);when(response.headers()).thenReturn(HttpHeaders.of(Map.of("Retry-After",List.of("1200")),(a,b)->true));
  assertEquals("DEGRADED",feed.view().get("calendarState"));
  var restarted=new EconomicCalendar(jdbc,json,client,now::get);assertEquals(fetched,restarted.view().get("calendarAt"));
  verify(client,times(2)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  now.set(fetched+31*60000L);var expired=new EconomicCalendar(jdbc,json,client,now::get);assertEquals(false,expired.view().get("ready"));
  assertEquals(fetched,expired.peek().get("fetchedAt"));verify(client,times(2)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
 }
}
