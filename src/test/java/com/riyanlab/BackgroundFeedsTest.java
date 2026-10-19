package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class BackgroundFeedsTest {
 private final ObjectMapper json=new ObjectMapper();
 @Test void historyValidationRejectsFormingMalformedAndConflictingBars()throws Exception{
  long t=1792375200000L;t=t/300000*300000;
  var rows=json.readTree("[["+(t/1000)+",99,102,100,101,12]]");
  assertEquals(0,BackgroundFeeds.normalize(rows,300000,t+1000,true,json).size());
  assertEquals(1,BackgroundFeeds.normalize(rows,300000,t+300000,true,json).size());
  var bad=json.readTree("[["+(t/1000)+",103,102,100,101,12]]");
  assertThrows(IllegalArgumentException.class,()->BackgroundFeeds.normalize(bad,300000,Long.MAX_VALUE,true,json));
  var conflict=json.readTree("[["+(t/1000)+",99,102,100,101,12],["+(t/1000)+",99,102,100,101,13]]");
  assertThrows(IllegalArgumentException.class,()->BackgroundFeeds.normalize(conflict,300000,Long.MAX_VALUE,true,json));
 }
 @Test void fourHourAggregationRequiresAllFourConsecutiveHours(){
  var feed=new BackgroundFeeds(null,json);var bars=json.createArrayNode();long start=1792368000000L/14400000*14400000;
  for(int i=0;i<4;i++)bars.addObject().put("t",start+i*3600000).put("o",100).put("h",102).put("l",99).put("c",101).put("v",10);
  assertEquals(1,feed.aggregate(bars,4).size());bars.remove(1);assertEquals(0,feed.aggregate(bars,4).size());
 }
 @Test @SuppressWarnings({"unchecked","rawtypes"})
 void calendarProxyJsonAndRateLimitUseBoundedCachedSources()throws Exception{
  var client=org.mockito.Mockito.mock(java.net.http.HttpClient.class);
  var response=org.mockito.Mockito.mock(java.net.http.HttpResponse.class);
  org.mockito.Mockito.when(response.statusCode()).thenReturn(200);
  String date=java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).plusHours(2).toString();
  org.mockito.Mockito.when(response.body()).thenReturn("Title: Calendar\nMarkdown Content:\n[{\"date\":\""+date+"\",\"title\":\"Test event\",\"impact\":\"High\",\"country\":\"USD\"}]");
  org.mockito.Mockito.when(client.send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class))).thenReturn(response);
  var feeds=new BackgroundFeeds(null,json,client);assertTrue(feeds.calendar().containsKey("calendar"));feeds.calendar();
  org.mockito.Mockito.verify(client,org.mockito.Mockito.times(1)).send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class));
  org.mockito.Mockito.reset(client);org.mockito.Mockito.when(response.statusCode()).thenReturn(429);
  org.mockito.Mockito.when(client.send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class))).thenReturn(response);
  var limited=new BackgroundFeeds(null,json,client);assertEquals(0,limited.calendar().get("calendarAt"));limited.calendar();
  org.mockito.Mockito.verify(client,org.mockito.Mockito.times(1)).send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class));
 }
}
