package com.riyanlab;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
class MetalHistoryTest {
 private final ObjectMapper json=new ObjectMapper();
 private final long ms=900000,t=1792418400000L/900000*900000;
 private ArrayNode row(long time,String confirmed){return json.createArrayNode().add(""+time).add("100").add("102").add("99").add("101").add("12000").add("12").add("1200").add(confirmed);}
 @Test void confirmedBarsKeepActualPricesAndBaseVolumeWithoutFillingGaps(){
  var raw=json.createArrayNode().add(row(t,"1")).add(row(t-2*ms,"1")).add(row(t-ms,"0")).add(row(t,"1"));
  var bars=MetalHistory.normalize(raw,ms,t+ms,"XAU-USDT-SWAP",json);
  assertEquals(2,bars.size());assertEquals(t-2*ms,bars.get(0).path("t").asLong());
  assertEquals(12,bars.get(0).path("v").asDouble());assertEquals(101,bars.get(0).path("c").asDouble());
  assertTrue(bars.get(0).path("complete").asBoolean());assertFalse(bars.get(0).has("analysisOnly"));
  assertEquals(0,MetalHistory.normalize(json.createArrayNode().add(row(t,"1")),ms,t+1000,"XAU-USDT-SWAP",json).size());
 }
 @Test void invalidValuesAndConflictingDuplicatesFailClosed(){
  for(int field:new int[]{1,2,3,4,6}){
   var bad=row(t,"1");bad.set(field,json.getNodeFactory().textNode("NaN"));
   assertThrows(RuntimeException.class,()->MetalHistory.normalize(json.createArrayNode().add(bad),ms,t+ms,"XAG-USDT-SWAP",json));
  }
  var bad=row(t,"1");bad.set(2,json.getNodeFactory().textNode("98"));
  assertThrows(RuntimeException.class,()->MetalHistory.normalize(json.createArrayNode().add(bad),ms,t+ms,"XAG-USDT-SWAP",json));
  var conflict=row(t,"1");conflict.set(4,json.getNodeFactory().textNode("100"));
  assertThrows(RuntimeException.class,()->MetalHistory.normalize(json.createArrayNode().add(row(t,"1")).add(conflict),ms,t+ms,"XAG-USDT-SWAP",json));
 }
 @Test void paginationCombinesHistoryAndProviderFailureCannotProduceCandles(){
  var market=mock(MarketDataController.class);var first=json.createArrayNode();var second=json.createArrayNode();
  long now=System.currentTimeMillis()/ms*ms;
  for(int i=0;i<300;i++){first.add(row(now-i*ms,i==0?"0":"1"));second.add(row(now-(300+i)*ms,"1"));}
  when(market.publicData(anyString())).thenAnswer(call->{String url=call.getArgument(0);return ResponseEntity.ok(json.createObjectNode().put("code","0").set("data",url.contains("after=")?second:first).toString());});
  var feed=new MetalHistory(null,market,json);var bars=feed.candles("XAGUSD","15m",500);
  assertEquals(500,bars.size());assertEquals(now-ms,bars.get(499).path("t").asLong());
  verify(market,times(2)).publicData(anyString());
  reset(market);when(market.publicData(anyString())).thenReturn(ResponseEntity.status(503).body("{\"upstreamStatus\":429}"));
  assertThrows(RuntimeException.class,()->feed.candles("XAUUSD","5m",300));
  assertThrows(RuntimeException.class,()->feed.candles("BTCUSD","5m",300));
 }
 @Test void outboundRequestsAreLimitedToMetalsAndBoundedCandles(){
  String base="https://www.okx.com/api/v5/market/candles?";
  assertNotNull(MarketDataController.allowed(base+"instId=XAU-USDT-SWAP&bar=15m&limit=300"));
  assertNotNull(MarketDataController.allowed(base+"instId=XAG-USDT-SWAP&bar=4H&limit=300&after="+t));
  for(String query:new String[]{"instId=BTC-USDT-SWAP&bar=15m&limit=300","instId=XAU-USDT-SWAP&bar=15m&limit=301","instId=XAU-USDT-SWAP&bar=15m&limit=300&callback=x","instId=XAU-USDT-SWAP&bar=15m&limit=300&bar=1m","instId=XAU-USDT-SWAP&bar=15m&limit=300&after=-1"})
   assertThrows(RuntimeException.class,()->MarketDataController.allowed(base+query));
 }
}
