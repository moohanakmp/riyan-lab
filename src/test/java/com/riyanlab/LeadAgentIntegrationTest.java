package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
@SpringBootTest(properties={"app.background.initial-delay=3600000","app.lead.initial-delay=3600000"})
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class LeadAgentIntegrationTest {
 @Autowired LeadAgent lead;@Autowired PushNotifications push;@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
 @MockBean BackgroundFeeds feeds;@MockBean BackgroundScanner scanner;
 @Test void atlasAssignsChecksAndReportsTasksFromRealState()throws Exception{
  String user="leadowner";
  jdbc.update("INSERT INTO auth_users(username,password_hash,role) VALUES(?,'not-a-login-password','user') ON CONFLICT DO NOTHING",user);
  long id=jdbc.queryForObject("SELECT id FROM auth_users WHERE username=?",Long.class,user);
  Instant now=Instant.now();
  var snap=json.createObjectNode();snap.putObject("BTCUSD").put("price",90000).put("quoteAt",now.toEpochMilli()-2000).putObject("bars").putArray("1h");
  when(scanner.lastSnapshot()).thenReturn(snap);when(scanner.lastSnapshotAt()).thenReturn(now.toEpochMilli());
  when(scanner.enabled()).thenReturn(true);when(scanner.cycleFinishedAt()).thenReturn(now.toEpochMilli()-30_000);
  when(scanner.cycleError()).thenReturn("");when(scanner.phase()).thenReturn("SCANNING_ACCOUNTS");when(scanner.lastAccounts()).thenReturn(1);
  when(feeds.calendarStatus()).thenReturn(Map.of("ready",false,"calendarError","Calendar HTTP 429"));
  lead.run(now);lead.run(now);
  var view=lead.view(new AuthService.Identity(id,user,"user"));
  @SuppressWarnings("unchecked") var tasks=(List<Map<String,Object>>)view.get("tasks");
  assertTrue(tasks.size()>=9,"a task for every agent");
  assertEquals(tasks.size(),new HashSet<>(tasks.stream().map(t->t.get("agent")+"|"+t.get("key")).toList()).size(),"running twice does not duplicate tasks");
  var byKey=new HashMap<String,Map<String,Object>>();tasks.forEach(t->byKey.put((String)t.get("key"),t));
  assertEquals("DONE",byKey.get("server-scan").get("status"));assertTrue(((String)byKey.get("server-scan").get("evidence")).contains("Scanned 1 account"));
  assertEquals("BLOCKED",byKey.get("calendar").get("status"));assertTrue(((String)byKey.get("calendar").get("evidence")).contains("429"));
  assertEquals("DONE",byKey.get("risk").get("status"));
  assertNotNull(byKey.get("server-scan").get("doneAt"));
  assertNotNull(view.get("notes"));assertNotNull(view.get("paperReview"));assertNotNull(view.get("background"));
  var guest=lead.view(new AuthService.Identity(id,user,"guest"));assertNull(guest.get("paperReview"),"paper review only for the account itself");

  // Push: a new accepted paper entry after the device subscribed becomes one alert, once.
  jdbc.update("INSERT INTO push_subscriptions(username,endpoint,device,created_at) VALUES(?,?,?,now()-interval '1 minute')",user,"https://fcm.googleapis.com/fcm/send/test-"+UUID.randomUUID(),"Android Chrome");
  var r=json.createObjectNode().put("sym","XAUUSD").put("dir","BUY").put("price",2650).put("sl",2645).put("tp1",2655).put("accountingVersion",2).put("outcome","OPEN");
  jdbc.update("INSERT INTO auto_signals(source_id,symbol,direction,status,payload,created_by) VALUES('push-1','XAUUSD','BUY','OPEN',?::jsonb,?)",r.toString(),user);
  push.queue();push.queue();
  assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM push_alerts WHERE username=? AND source_id='push-1'",Integer.class,user));
  assertEquals("Paper signal: Gold BUY",jdbc.queryForObject("SELECT title FROM push_alerts WHERE source_id='push-1'",String.class));
 }
}
