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
 @Test void skipReasonsKeepOneRowPerChange()throws Exception{
  String user="reasonowner";
  var d=json.createObjectNode();d.putObject("XAUUSD").put("auto","ADX 17 — ranging/choppy market").put("lowProfit","Waiting for confirmed setup");
  scanner.recordReasons(user,d);
  ((com.fasterxml.jackson.databind.node.ObjectNode)d.path("XAUUSD")).put("auto","ADX 18 — ranging/choppy market");
  scanner.recordReasons(user,d);
  assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM background_scanner_reasons WHERE username=?",Integer.class,user),"numbers alone do not add rows");
  assertEquals("ADX 18 — ranging/choppy market",jdbc.queryForObject("SELECT reason FROM background_scanner_reasons WHERE username=? AND strategy='auto'",String.class,user));
  ((com.fasterxml.jackson.databind.node.ObjectNode)d.path("XAUUSD")).put("auto","1H BULL vs 4H BEAR — no clear higher-timeframe direction");
  scanner.recordReasons(user,d);
  assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM background_scanner_reasons WHERE username=? AND strategy='auto'",Integer.class,user),"a new reason adds a row");
  @SuppressWarnings("unchecked") var history=(List<Map<String,Object>>)scanner.status(user).get("reasonHistory");
  assertEquals("1H BULL vs 4H BEAR — no clear higher-timeframe direction",history.getFirst().get("reason"));
  assertEquals("Signal # at #/#",BackgroundScanner.reasonKey("Signal 3.25 at 1,234/100"));
 }
}
