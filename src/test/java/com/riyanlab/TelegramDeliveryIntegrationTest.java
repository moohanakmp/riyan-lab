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
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
@SpringBootTest
@Transactional
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class TelegramDeliveryIntegrationTest {
 @Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void acceptedBrowserAndBackgroundEntriesAreDurableDeduplicatedAndRetryable()throws Exception{
  String user="tg_"+UUID.randomUUID().toString().substring(0,8);
  jdbc.update("INSERT INTO auth_users(username,password_hash,role) VALUES(?,'test-only-no-login','user')",user);
  jdbc.update("INSERT INTO telegram_settings(username,enabled,bot_token,chat_id) VALUES(?,true,'12345:dummy-token-for-tests-only','42')",user);
  for(String table:List.of("auto_signals","low_profit_signals")){
   var record=json.createObjectNode().put("id",17).put("ts",System.currentTimeMillis()).put("t",System.currentTimeMillis()).put("sym","BTCUSD").put("dir","SELL").put("price",100).put("entry",100).put("tp",98).put("sl",102).put("lot",.01).put("accountingVersion",2).put("generator",table.equals("auto_signals")?"browser":"server-background");
   jdbc.update("INSERT INTO "+table+"(source_id,payload,created_by,status) VALUES(?,?::jsonb,?,'OPEN')",user+table,record.toString(),user);
  }
  var client=mock(HttpClient.class);var response=mock(HttpResponse.class);when(response.statusCode()).thenReturn(429);when(response.body()).thenReturn("{\"ok\":false,\"description\":\"rate limited\",\"parameters\":{\"retry_after\":120}}");when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response);
  var service=new TelegramDelivery(jdbc,json,mock(AuthService.class),client);service.deliver();
  assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM telegram_deliveries WHERE username=? AND state='RETRY'",Integer.class,user));
  service.deliver();verify(client,times(2)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  jdbc.update("UPDATE telegram_deliveries SET retry_at=now()-interval '1 second' WHERE username=?",user);
  when(response.statusCode()).thenReturn(200);when(response.body()).thenReturn("{\"ok\":true,\"result\":{\"message_id\":123}}");
  new TelegramDelivery(jdbc,json,mock(AuthService.class),client).deliver();
  assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM telegram_deliveries WHERE username=? AND state='SENT' AND message_id=123",Integer.class,user));
  service.deliver();verify(client,times(4)).send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class));
  assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM telegram_deliveries WHERE username=?",Integer.class,user));
 }
}
