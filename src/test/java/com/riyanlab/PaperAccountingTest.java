package com.riyanlab;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;
import static org.junit.jupiter.api.Assertions.*;

class PaperAccountingTest {
    private final ObjectMapper json=new ObjectMapper();
    private final PaperTradingService service=new PaperTradingService(new JdbcTemplate(),json);
    ObjectNode scalp(){
        return json.createObjectNode().put("sym","XAUUSD").put("dir","BUY").put("entry",100)
            .put("sl",99).put("tp",102).put("units",1).put("lot",.01).put("accountingVersion",2)
            .put("status","OPEN").put("updatedAt",1000);
    }
    @Test void stopGapMustUseTheActualFillInProfit(){
        var old=scalp();var close=old.deepCopy().put("status","SL").put("exit",90).put("pnl",-10.35).put("updatedAt",2000);
        assertDoesNotThrow(()->service.validate("u","low-profit","1",close,old.toString()));
        close.put("pnl",-1.35);
        assertThrows(ResponseStatusException.class,()->service.validate("u","low-profit","1",close,old.toString()));
    }
    @Test void closedResultAndEntryPlanCannotBeRewritten(){
        var old=scalp();var n=old.deepCopy().put("entry",101).put("updatedAt",2000);
        assertThrows(ResponseStatusException.class,()->service.validate("u","low-profit","1",n,old.toString()));
        var close=old.deepCopy().put("status","TP").put("exit",102).put("pnl",1.65).put("updatedAt",2000);
        assertThrows(ResponseStatusException.class,()->service.validate("u","low-profit","1",old,close.toString()));
    }
    @Test void partialFillQuantitiesAndNetMustReconcile(){
        var old=json.createObjectNode().put("sym","XAUUSD").put("dir","BUY").put("price",100)
            .put("sl",95).put("tp",115).put("posUnits",1).put("lot",.01).put("accountingVersion",2)
            .put("outcome","OPEN").put("remFrac",1).put("realUsd",0).put("updatedAt",1000);
        var n=old.deepCopy().put("outcome","LOSS").put("remFrac",0).put("realUsd",-2.85)
            .put("pnlUsd",-2.85).put("exitPrice",90).put("updatedAt",2000);
        var fills=n.putArray("fills");
        fills.addObject().put("price",105).put("units",.5).put("netUsd",2.325);
        fills.addObject().put("price",90).put("units",.5).put("netUsd",-5.175);
        assertDoesNotThrow(()->service.validate("u","auto-signals","1",n,old.toString()));
        n.putNull("realUsd");
        assertThrows(ResponseStatusException.class,()->service.validate("u","auto-signals","1",n,old.toString()));
        n.put("realUsd",-2.85).put("remFrac",.2);
        assertThrows(ResponseStatusException.class,()->service.validate("u","auto-signals","1",n,old.toString()));
    }
    @Test void accountingCannotBeDowngradedOrStopProtectionRemoved(){
        var old=scalp().put("beMoved",true).put("updatedAt",2000);
        var n=old.deepCopy().put("beMoved",false).put("updatedAt",3000);
        assertThrows(ResponseStatusException.class,()->service.validate("u","low-profit","1",n,old.toString()));
        n.put("beMoved",true).put("accountingVersion",1);
        assertThrows(ResponseStatusException.class,()->service.validate("u","low-profit","1",n,old.toString()));
    }
}
