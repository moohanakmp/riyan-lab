package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
@SpringBootTest(properties={"app.background.enabled=true","app.background.initial-delay=3600000"})
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class BackgroundScannerIntegrationTest {
 @Autowired BackgroundScanner scanner;@Autowired PaperTradingService paper;@Autowired RecordController records;@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
 @MockBean BackgroundFeeds feeds;
 @Test void offlineWorkerSettlesAuditsAndHandsBackWithoutDuplicate()throws Exception{
  String user="backgroundowner";
  jdbc.update("INSERT INTO auth_users(username,password_hash,role) VALUES(?,'not-a-login-password','user')",user);
  long id=jdbc.queryForObject("SELECT id FROM auth_users WHERE username=?",Long.class,user);
  var identity=new AuthService.Identity(id,user,"user");String browser="browser-before-background";
  assertTrue(paper.lease(user,browser));assertFalse(paper.backgroundLease(user,"server-test-background"),"active browser remains owner");
  long now=System.currentTimeMillis();
  var r=json.createObjectNode().put("id",991).put("sym","BTCUSD").put("dir","BUY").put("price",100).put("sl",90).put("slNow",90)
   .put("tp1",105).put("tp2",110).put("tp",115).put("outcome","OPEN").put("posUnits",.01).put("lot",.01)
   .put("remFrac",1).put("realUsd",0).put("spreadPerUnit",5).put("accountingVersion",2).put("signalKey","background-fixture-candle").put("paperOnly",true).put("owner",user).put("ts",now-3600000).put("updatedAt",now-3600000).putNull("brokerOrderId");
  records.saveForEngine(identity,"auto-signals","991",r,browser);
  jdbc.update("UPDATE paper_engine_leases SET expires_at=now()-interval '1 second' WHERE username=?",user);
  var snapshot=json.createObjectNode();snapshot.putObject("BTCUSD").put("price",120).put("quoteAt",System.currentTimeMillis());
  when(feeds.snapshot()).thenReturn(snapshot);when(feeds.calendar()).thenReturn(Map.of("calendarAt",0));when(feeds.calendarStatus()).thenReturn(Map.of("ready",false));
  scanner.scan();
  var closed=json.readTree(jdbc.queryForObject("SELECT payload::text FROM auto_signals WHERE source_id='991'",String.class));
  assertEquals("WIN",closed.path("outcome").asText());assertEquals(3,closed.path("fills").size());
  assertEquals("SCANNING",scanner.status(user).get("state"));
  assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM audit_events WHERE record_type='auto-signals' AND source_id='991'",Integer.class));
  assertTrue(paper.lease(user,"browser-returned-owner"),"returning browser safely preempts server owner");
  scanner.scan();
  assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM auto_signals WHERE created_by=?",Integer.class,user));
  assertThrows(org.springframework.web.server.ResponseStatusException.class,()->records.saveForEngine(identity,"auto-signals","992",r,browser),"old engine cannot write after handover");
  jdbc.update("INSERT INTO background_scanner_settings(username,enabled) VALUES(?,false)",user);
  assertEquals(false,scanner.status(user).get("enabled"));
 }
}
