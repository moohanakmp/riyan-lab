package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.net.http.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
class TelegramDeliveryTest {
 final ObjectMapper json=new ObjectMapper();
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void successRequiresTelegramAcknowledgmentAndRejectionsCarryRetryDelay()throws Exception{
  var client=mock(HttpClient.class);var response=mock(HttpResponse.class);
  when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response);
  var service=new TelegramDelivery(mock(JdbcTemplate.class),json,mock(AuthService.class),client);
  when(response.statusCode()).thenReturn(200);when(response.body()).thenReturn("{\"ok\":true,\"result\":{\"message_id\":55}}");
  assertEquals(55,service.send("12345:dummy-token","42","test").messageId());
  when(response.statusCode()).thenReturn(429);when(response.body()).thenReturn("{\"ok\":false,\"description\":\"Too Many Requests\",\"parameters\":{\"retry_after\":120}}");
  var rejected=service.send("12345:dummy-token","42","test");assertFalse(rejected.ok());assertEquals(120,rejected.retrySeconds());
  when(response.statusCode()).thenReturn(200);when(response.body()).thenReturn("{\"ok\":false,\"description\":\"chat not found\"}");
  assertFalse(service.send("12345:dummy-token","42","test").ok());
  when(response.body()).thenReturn("not json");assertFalse(service.send("12345:dummy-token","42","test").ok());
 }
 @Test @SuppressWarnings({"unchecked","rawtypes"}) void errorsNeverExposeTokenOrUrl()throws Exception{
  var client=mock(HttpClient.class);when(client.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenThrow(new java.io.IOException("https://api.telegram.org/botSECRET/sendMessage"));
  var result=new TelegramDelivery(mock(JdbcTemplate.class),json,mock(AuthService.class),client).send("SECRET","42","test");
  assertFalse(result.ok());assertFalse(result.error().contains("SECRET"));assertTrue(result.retrySeconds()>0);
 }
 @Test void entryMessagesIncludeOriginalIstTimeAndCorrectLadder()throws Exception{
  var r=json.readTree("{\"id\":15,\"ts\":1792788300000,\"sym\":\"BTCUSD\",\"dir\":\"SELL\",\"price\":80808,\"tp1\":80436,\"tp2\":80064,\"tp3\":79692,\"sl\":81180,\"lot\":0.01}");
  var message=TelegramDelivery.message("auto-signals",r);assertTrue(message.contains("BTCUSD SELL"));assertTrue(message.contains("TP1 80436"));assertTrue(message.contains("TP3 79692"));assertTrue(message.contains("IST"));assertTrue(message.contains("Signal ID 15"));
  var scalp=TelegramDelivery.message("low-profit",json.readTree("{\"id\":16,\"sym\":\"XAUUSD\",\"dir\":\"BUY\",\"entry\":4000,\"tp\":4001,\"sl\":3998,\"lot\":0.01}"));
  assertTrue(scalp.contains("Low Profit"));assertTrue(scalp.contains("Entry 4000"));assertTrue(scalp.contains("TP 4001"));assertFalse(scalp.contains("TP1"));
 }
 @Test void claimedDeliveryCannotBeSentTwice()throws Exception{
  var jdbc=mock(JdbcTemplate.class);var client=mock(HttpClient.class);
  when(jdbc.queryForList(anyString(),any(Object[].class))).thenReturn(List.of());
  new TelegramDelivery(jdbc,json,mock(AuthService.class),client).deliverOne(9);
  verifyNoInteractions(client);
 }
}
