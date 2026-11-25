package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
@SpringBootTest(properties={"app.background.enabled=false","app.orderflow.enabled=false"})
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class OrderFlowPersistenceIntegrationTest {
 @Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;
 @Test void closedMinutesSurviveARestart(){
  jdbc.update("DELETE FROM order_flow_minutes WHERE symbol='XAGUSD'"); // repeatable on a reused database
  long now=System.currentTimeMillis(),t=Math.floorDiv(now,60_000L)*60_000L-5*60_000L;
  var a=new OrderFlowCollector(jdbc,json,url->{throw new IllegalStateException("offline");});var b=a.books.get("XAGUSD");
  synchronized(b){a.connected(b,t-1000);}
  a.onTrade(b,1,1,t+1000,30.123,4,true);a.onTrade(b,2,2,t+2000,30.120,1,false);a.onTrade(b,3,3,t+60_500,30.2,2,true);
  a.onTrade(b,4,4,now,30.3,1,true); // forming minute is not saved
  assertEquals(2,a.flush(now));assertEquals(0,a.flush(now),"unchanged minutes are not written again");
  var restarted=new OrderFlowCollector(jdbc,json,url->{throw new IllegalStateException("offline");});restarted.load();
  @SuppressWarnings("unchecked") var rows=(List<Map<String,Object>>)restarted.view("XAGUSD","",0,now).get("minutes");
  assertEquals(2,rows.size());
  assertEquals(4.0,rows.get(0).get("buy"));assertEquals(1.0,rows.get(0).get("sell"));assertEquals(true,rows.get(0).get("partial"));
  assertEquals(false,rows.get(1).get("partial"));
  @SuppressWarnings("unchecked") var cells=(List<double[]>)rows.get(0).get("cells");
  assertEquals(2,cells.size());
  assertEquals(t+60_000L,restarted.books.get("XAGUSD").verifiedUpTo-60_000L,"complete history is not re-fetched");
 }
}
