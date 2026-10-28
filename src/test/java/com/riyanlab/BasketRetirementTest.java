package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
class BasketRetirementTest {
 @Test void newBasketPositionsAreRejectedButExistingPositionsCanStillUpdate()throws Exception{
  var jdbc=mock(JdbcTemplate.class);var json=new ObjectMapper();var service=new PaperTradingService(jdbc,json);
  var old=json.readTree("{\"sym\":\"XAUUSD\",\"dir\":\"BUY\",\"entry\":100,\"sl\":99,\"tp\":103,\"lot\":0.01,\"units\":1,\"signalKey\":\"legacy\",\"status\":\"OPEN\",\"updatedAt\":1}");
  var error=assertThrows(ResponseStatusException.class,()->service.validate("owner","basket-positions","id",old,null));
  assertTrue(error.getReason().contains("OFF"));
  var next=old.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)next).put("status","CLOSED").put("exit",101).put("pnl",.65).put("updatedAt",2);
  assertDoesNotThrow(()->service.validate("owner","basket-positions","id",next,old.toString()));
 }
}
