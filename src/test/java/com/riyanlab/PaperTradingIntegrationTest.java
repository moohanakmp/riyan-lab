package com.riyanlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class PaperTradingIntegrationTest {
    @Autowired MockMvc mvc;@Autowired ObjectMapper json;@Autowired JdbcTemplate jdbc;
    record Session(Cookie[] cookies,String csrf){}
    Session login(String name,String password)throws Exception{
        var r=mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("username",name,"password",password))))
            .andExpect(status().isOk()).andReturn().getResponse();
        return new Session(r.getCookies(),json.readTree(r.getContentAsString()).path("csrf").asText());
    }
    Session user(String name)throws Exception{
        var a=login("testadmin","unit-test-password-1234");
        mvc.perform(post("/api/v1/auth/users").cookie(a.cookies).header("X-CSRF-Token",a.csrf)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("username",name,"password","testpass123","role","user"))))
            .andExpect(status().isOk());
        return login(name,"testpass123");
    }
    boolean lease(Session s,String engine)throws Exception{
        var r=mvc.perform(post("/api/v1/paper/lease").cookie(s.cookies).header("X-CSRF-Token",s.csrf).header("X-Paper-Engine",engine))
            .andExpect(status().isOk()).andReturn().getResponse();
        return json.readTree(r.getContentAsString()).path("owned").asBoolean();
    }
    ObjectNode entry(String key,double stop){
        var n=json.createObjectNode();
        n.put("sym","XAUUSD").put("dir","BUY").put("entry",100).put("sl",stop).put("tp",104)
            .put("units",1).put("lot",.01).put("status","OPEN").put("paperOnly",true)
            .put("accountingVersion",2).put("signalKey",key).put("updatedAt",1000).putNull("brokerOrderId");
        return n;
    }
    int write(Session s,String engine,String id,ObjectNode n)throws Exception{
        return mvc.perform(put("/api/v1/records/low-profit/"+id).cookie(s.cookies)
            .header("X-CSRF-Token",s.csrf).header("X-Paper-Engine",engine)
            .contentType(MediaType.APPLICATION_JSON).content(n.toString())).andReturn().getResponse().getStatus();
    }
    @Test void leaseDuplicateRiskAndLifecycleAreEnforced()throws Exception{
        var s=user("riskowner");
        assertTrue(lease(s,"engine-one-123"));assertFalse(lease(s,"engine-two-123"));
        var n=entry("risk-bar-1",98.5);
        assertEquals(409,write(s,"engine-two-123","risk-1",n));
        assertEquals(200,write(s,"engine-one-123","risk-1",n));
        assertEquals(200,write(s,"engine-one-123","risk-1",n),"retry is idempotent");
        mvc.perform(get("/api/v1/paper/ledger").cookie(s.cookies))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1))
            .andExpect(jsonPath("$[0].record_type").value("low-profit"));

        assertEquals(409,write(s,"engine-one-123","risk-copy",n),"different random ID cannot duplicate candle");
        assertEquals(409,write(s,"engine-one-123","risk-2",entry("risk-bar-2",97.5)),"combined risk exceeds $4");
        var closed=n.deepCopy().put("status","SL").put("exit",98.5).put("pnl",-1.85).put("closedAt",2000).put("updatedAt",2000);
        assertEquals(200,write(s,"engine-one-123","risk-1",closed));
        assertEquals(409,write(s,"engine-one-123","risk-1",n),"stale snapshot cannot reopen a closed trade");
        var other=user("riskreader");assertTrue(lease(other,"engine-other-123"));
        assertEquals(403,write(other,"engine-other-123","risk-1",n));
        mvc.perform(get("/api/v1/records/low-profit").cookie(other.cookies)).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(get("/api/v1/paper/ledger").cookie(other.cookies)).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(get("/api/v1/paper/ledger")).andExpect(status().isUnauthorized());

        jdbc.update("UPDATE paper_engine_leases SET expires_at=now()-interval '1 second' WHERE username='riskowner'");
        assertTrue(lease(s,"engine-two-123"));
        assertEquals(409,write(s,"engine-one-123","risk-3",entry("risk-bar-3",99)));
    }
    @Test void concurrentEntriesCannotOverbookAccountRisk()throws Exception{
        var s=user("raceowner");assertTrue(lease(s,"engine-race-123"));
        ExecutorService pool=Executors.newFixedThreadPool(2);
        try{
            var ready=new CountDownLatch(2);var start=new CountDownLatch(1);
            var one=pool.submit(()->{ready.countDown();start.await();return write(s,"engine-race-123","race-1",entry("race-bar-1",98));});
            var two=pool.submit(()->{ready.countDown();start.await();return write(s,"engine-race-123","race-2",entry("race-bar-2",98));});
            assertTrue(ready.await(5,TimeUnit.SECONDS));start.countDown();
            var statuses=new ArrayList<>(List.of(one.get(15,TimeUnit.SECONDS),two.get(15,TimeUnit.SECONDS)));
            Collections.sort(statuses);assertEquals(List.of(200,409),statuses);
        }finally{pool.shutdownNow();}
    }
    @Test void readOnlyManualPlansAreOwnerScopedAndDoNotNeedTradeLease()throws Exception{
        var owner=user("planowner");var other=user("planreader");
        String id="planowner--id-"+"d".repeat(64);
        String path="/api/v1/records/manual-plans/"+id;
        var plan=json.createObjectNode().put("source","manual-analysis").put("ready",true).put("symbol","XAUUSD");
        mvc.perform(put(path).cookie(owner.cookies).header("X-CSRF-Token",owner.csrf)
            .contentType(MediaType.APPLICATION_JSON).content(plan.toString())).andExpect(status().isOk());
        mvc.perform(get("/api/v1/records/manual-plans").cookie(owner.cookies))
            .andExpect(status().isOk()).andExpect(jsonPath("$[0].source_id").value(id));
        mvc.perform(get("/api/v1/records/manual-plans").cookie(other.cookies))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(put(path).cookie(other.cookies).header("X-CSRF-Token",other.csrf)
            .contentType(MediaType.APPLICATION_JSON).content(plan.toString())).andExpect(status().isForbidden());
        mvc.perform(put(path).cookie(owner.cookies).header("X-CSRF-Token",owner.csrf)
            .contentType(MediaType.APPLICATION_JSON).content(entry("not-a-plan",99).put("source","manual-analysis").toString()))
            .andExpect(status().isBadRequest());
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM manual_signals WHERE created_by='planowner'",Integer.class));
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM audit_events WHERE record_type='manual-plans' AND source_id=?",Integer.class,id));
    }
    @Test void paperRiskRejectionReturnsControlledReason()throws Exception{
        var s=user("reasonowner");assertTrue(lease(s,"reason-engine-123"));
        mvc.perform(put("/api/v1/records/low-profit/reason-wide").cookie(s.cookies)
            .header("X-CSRF-Token",s.csrf).header("X-Paper-Engine","reason-engine-123")
            .contentType(MediaType.APPLICATION_JSON).content(entry("reason-wide-bar",90).toString()))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.reason").value("Invalid size or stop risk exceeds $4"));
    }

}
