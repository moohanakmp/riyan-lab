package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
class BackgroundFeedsTest {
 private final ObjectMapper json=new ObjectMapper();
 @Test void oneFailedTimeframeDoesNotDiscardHealthyHistory()throws Exception{
  var market=mock(MarketDataController.class);
  when(market.publicData(anyString())).thenAnswer(call->{
   String url=call.getArgument(0);
   if(url.contains("granularity=300&"))return org.springframework.http.ResponseEntity.status(503).body("5m unavailable");
   int seconds=url.contains("granularity=900&")?900:3600;
   long t=(System.currentTimeMillis()/1000/seconds-2)*seconds;
   return org.springframework.http.ResponseEntity.ok("[["+t+",99,102,100,101,12]]");
  });
  var result=new BackgroundFeeds(market,json).instrument("BTCUSD");
  assertFalse(result.path("bars").path("15m").isEmpty());
  assertFalse(result.path("bars").path("1h").isEmpty());
  assertTrue(result.path("frameErrors").has("5m"));assertTrue(result.has("scalpError"));
 }
 @Test void failedFifteenMinuteFeedFallsBackToCompleteFiveMinuteGroups()throws Exception{
  var market=mock(MarketDataController.class);
  when(market.publicData(anyString())).thenAnswer(call->{
   String url=call.getArgument(0);
   if(url.contains("granularity=900&"))return org.springframework.http.ResponseEntity.status(503).body("15m unavailable");
   int seconds=url.contains("granularity=300&")?300:3600;
   long t=(System.currentTimeMillis()/1000/900-10)*900;
   var rows=json.createArrayNode();for(int i=0;i<6;i++)rows.addArray().add(t+i*seconds).add(99).add(102).add(100).add(101).add(12);
   return org.springframework.http.ResponseEntity.ok(rows.toString());
  });
  var result=new BackgroundFeeds(market,json).instrument("BTCUSD");
  assertEquals(2,result.path("bars").path("15m").size());
  assertTrue(result.path("frameErrors").has("15m"));assertFalse(result.has("scalpError"));
  var five=result.path("five").deepCopy();((com.fasterxml.jackson.databind.node.ArrayNode)five).remove(1);
  assertEquals(1,new BackgroundFeeds(null,json).aggregatePeriod(five,300000,3).size(),"missing candles cannot be interpolated");
 }
 @Test void allHistoriesFinishBeforeAnyQuoteIsFetched(){
  var finished=new java.util.concurrent.atomic.AtomicInteger();
  var early=new java.util.concurrent.atomic.AtomicBoolean();
  var feeds=new BackgroundFeeds(null,json){
   @Override com.fasterxml.jackson.databind.node.ObjectNode instrument(String sym){finished.incrementAndGet();return json.createObjectNode();}
   @Override void refreshQuote(String sym,com.fasterxml.jackson.databind.node.ObjectNode out){
    if(finished.get()!=3)early.set(true);out.put("price",100).put("quoteAt",System.currentTimeMillis());
   }
  };
  var result=feeds.snapshot();assertFalse(early.get());
  for(String sym:java.util.List.of("XAUUSD","XAGUSD","BTCUSD"))assertEquals(100,result.path(sym).path("price").asInt());
 }
 @Test void failedQuoteDoesNotLeaveAnOldPriceAvailable(){
  var market=mock(MarketDataController.class);
  when(market.publicData(anyString())).thenReturn(org.springframework.http.ResponseEntity.status(503).body("unavailable"));
  var out=json.createObjectNode().put("price",100).put("quoteAt",System.currentTimeMillis());
  new BackgroundFeeds(market,json).refreshQuote("BTCUSD",out);
  assertFalse(out.has("price"));assertFalse(out.has("quoteAt"));assertTrue(out.has("quoteError"));
 }
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
 @Test void metalQuotesUseProviderTimeAndRejectWrongOrStaleData(){
  long now=java.time.Instant.parse("2026-10-19T15:00:00Z").toEpochMilli();
  var q=json.createObjectNode().put("symbol","XAU").put("updatedAt",java.time.Instant.ofEpochMilli(now-5000).toString());
  assertEquals(now-5000,BackgroundFeeds.metalQuoteTime(q,"XAUUSD",now));
  assertThrows(RuntimeException.class,()->BackgroundFeeds.metalQuoteTime(q,"XAGUSD",now));
  q.put("updatedAt",java.time.Instant.ofEpochMilli(now-30000).toString());assertThrows(RuntimeException.class,()->BackgroundFeeds.metalQuoteTime(q,"XAUUSD",now));
  q.put("updatedAt",java.time.Instant.ofEpochMilli(now+1000).toString());assertThrows(RuntimeException.class,()->BackgroundFeeds.metalQuoteTime(q,"XAUUSD",now));
 }
}
