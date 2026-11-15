package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
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
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class BrokerMirrorIntegrationTest {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper mapper;
    @Autowired private JdbcTemplate jdbc;
    private static final String ENGINE="broker-it-engine";

    private record Session(Cookie[] cookies,String csrf){}

    private Session login(String user,String password) throws Exception {
        var r=mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(Map.of("username",user,"password",password)))).andExpect(status().isOk()).andReturn();
        return new Session(r.getResponse().getCookies(),mapper.readTree(r.getResponse().getContentAsString()).path("csrf").asText());
    }
    private void ensureUser(Session admin,String user,String role,String password) throws Exception {
        if(jdbc.queryForObject("SELECT count(*) FROM auth_users WHERE username=?",Integer.class,user)>0)return;
        mvc.perform(post("/api/v1/auth/users").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf).header("X-Paper-Engine",ENGINE)
            .contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(Map.of("username",user,"role",role,"password",password))))
            .andExpect(status().isOk());
    }
    private ObjectNode signal(String key) {
        var n=mapper.createObjectNode();
        n.put("sym","XAUUSD").put("dir","BUY").put("entry",100).put("sl",99.5).put("tp",102).put("tp1",100.5).put("tp2",101).put("tp3",102)
            .put("units",1).put("lot",.01).put("status","OPEN").put("paperOnly",true).put("accountingVersion",2)
            .put("signalKey",key).put("updatedAt",System.currentTimeMillis()).putNull("brokerOrderId");
        return n;
    }
    private void putSignal(Session s,String id,JsonNode body) throws Exception {
        mvc.perform(put("/api/v1/records/auto-signals/"+id).cookie(s.cookies).header("X-CSRF-Token",s.csrf).header("X-Paper-Engine",ENGINE)
            .contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(body))).andExpect(status().isOk());
    }
    private String poll(String token,Map<String,String> form) throws Exception {
        var req=post("/api/v1/broker/connector/poll").header("X-Riyan-Connector-Token",token).contentType(MediaType.APPLICATION_FORM_URLENCODED);
        for(var e:form.entrySet())req=req.param(e.getKey(),e.getValue());
        return mvc.perform(req).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
    }
    private void report(String token,Map<String,String> form) throws Exception {
        var req=post("/api/v1/broker/connector/report").header("X-Riyan-Connector-Token",token).contentType(MediaType.APPLICATION_FORM_URLENCODED);
        for(var e:form.entrySet())req=req.param(e.getKey(),e.getValue());
        mvc.perform(req).andExpect(status().isOk());
    }
    private Map<String,Object> order(String sourceId) {
        return jdbc.queryForMap("SELECT * FROM broker_orders WHERE signal_source_id=? AND action='OPEN'",sourceId);
    }

    @Test
    void adminLinksDemoAccountAndEveryEntryIsMirroredWithBrokerEvidence() throws Exception {
        Session root=login("testadmin","unit-test-password-1234");
        ensureUser(root,"brokeradmin","admin","broker-admin-password-123");
        ensureUser(root,"brokeruser","user","broker-user-password-123");
        Session admin=login("brokeradmin","broker-admin-password-123");
        Session user=login("brokeruser","broker-user-password-123");

        // Admin-only, and the connector rejects missing/unknown tokens.
        mvc.perform(get("/api/v1/broker/account")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/broker/account").cookie(user.cookies)).andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/broker/connector/poll").contentType(MediaType.APPLICATION_FORM_URLENCODED).param("login","1"))
            .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/broker/connector/poll").header("X-Riyan-Connector-Token","rlc_not-a-real-token-at-all")
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)).andExpect(status().isUnauthorized());

        // EXECUTE is refused before a token exists; CSRF is required.
        mvc.perform(put("/api/v1/broker/account").cookie(admin.cookies).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isForbidden());
        mvc.perform(put("/api/v1/broker/account").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf).contentType(MediaType.APPLICATION_JSON)
            .content("{\"accountLogin\":\"99887766\",\"accountServer\":\"OctaFX-Demo\",\"mode\":\"EXECUTE\",\"enabled\":true}"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.reason").exists());

        String token=mapper.readTree(mvc.perform(post("/api/v1/broker/account/token").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("token").asText();
        assertTrue(token.startsWith("rlc_"));
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM broker_accounts WHERE connector_token_hash=?",Integer.class,token));

        // 1) Dry-run (default): entry is recorded, never dispatched.
        mvc.perform(put("/api/v1/broker/account").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf).contentType(MediaType.APPLICATION_JSON)
            .content("{\"accountLogin\":\"99887766\",\"accountServer\":\"OctaFX-Demo\",\"enabled\":true}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.account.mode").value("DRY_RUN"));
        mvc.perform(post("/api/v1/paper/lease").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf).header("X-Paper-Engine",ENGINE))
            .andExpect(status().isOk());
        putSignal(admin,"broker-it-dry",signal("broker-it-dry"));
        assertEquals("DRY_RUN",order("broker-it-dry").get("state"));
        var demo=Map.of("login","99887766","server","OctaFX-Demo","mode","demo","balance","1000","equity","1000","currency","USD");
        String idle=poll(token,demo);
        assertTrue(idle.startsWith("IDLE|"),idle);
        assertFalse(idle.contains("CMD|"));
        // Link test carries every mapped symbol so the EA checks all three in one tap (also works in dry-run).
        String ping=mapper.readTree(mvc.perform(post("/api/v1/broker/ping").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("clientOrderId").asText();
        String pingCmd=poll(token,demo);
        assertTrue(pingCmd.contains("|"+ping+"|PING|XAUUSD,XAGUSD,BTCUSD|"),pingCmd);
        report(token,Map.of("clientId",ping,"status","DONE","message","ALL SYMBOLS OK XAUUSD=OK bid=1 XAGUSD=OK bid=1 BTCUSD=OK bid=1"));
        assertEquals("DONE",jdbc.queryForObject("SELECT state FROM broker_orders WHERE client_order_id=?",String.class,ping));

        // 2) Execute on demo: queued, dispatched only to the matching terminal.
        mvc.perform(put("/api/v1/broker/account").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf).contentType(MediaType.APPLICATION_JSON)
            .content("{\"mode\":\"EXECUTE\"}")).andExpect(status().isOk());
        putSignal(admin,"broker-it-live",signal("broker-it-live"));
        var o=order("broker-it-live");
        assertEquals("QUEUED",o.get("state"));
        assertEquals(0,new java.math.BigDecimal("0.01").compareTo((java.math.BigDecimal)o.get("volume")));
        String wrong=poll(token,Map.of("login","11111111","server","OctaFX-Demo","mode","demo"));
        assertTrue(wrong.startsWith("HALT|"),wrong);
        String real=poll(token,Map.of("login","99887766","server","OctaFX-Demo","mode","real"));
        assertTrue(real.startsWith("HALT|Real-money"),real);
        assertEquals("QUEUED",order("broker-it-live").get("state"));
        String cmd=poll(token,demo);
        String clientId=(String)o.get("client_order_id");
        assertTrue(cmd.contains("|"+clientId+"|OPEN|XAUUSD|BUY|0.01|99.5|102|100|"),cmd);
        assertTrue(cmd.contains("|END"),cmd);
        assertEquals("DISPATCHED",order("broker-it-live").get("state"));
        assertFalse(poll(token,demo).contains(clientId),"never re-sent");

        report(token,Map.of("clientId",clientId,"status","FILLED","ticket","5550001","price","100.02","volume","0.01","retcode","10009","message","done"));
        o=order("broker-it-live");
        assertEquals("FILLED",o.get("state"));
        assertEquals("5550001",o.get("broker_ticket"));

        // 3) App closes the signal -> CLOSE queued for the broker position; broker close reconciled with profit.
        var closed=signal("broker-it-live");closed.put("status","CLOSED").put("pnl",1.15).put("exit",101.5).put("closedAt",System.currentTimeMillis())
            .put("updatedAt",System.currentTimeMillis()+1000);
        putSignal(admin,"broker-it-live",closed);
        String closeCmd=poll(token,Map.of("login","99887766","server","OctaFX-Demo","mode","demo","positions","5550001|"+clientId+"|XAUUSD|BUY|0.01|100.02|99.5|102|1.40"));
        assertTrue(closeCmd.contains("|CLOSE|")&&closeCmd.contains("|5550001|END"),closeCmd);
        String closeId=jdbc.queryForObject("SELECT client_order_id FROM broker_orders WHERE parent_id=? AND action='CLOSE'",String.class,o.get("id"));
        report(token,Map.of("clientId",closeId,"status","DONE","ticket","5550001","price","101.48","retcode","10009"));
        poll(token,Map.of("login","99887766","server","OctaFX-Demo","mode","demo","closes","5550001|[tp 102]|101.48|1.46|"+System.currentTimeMillis()/1000));
        o=order("broker-it-live");
        assertEquals("CLOSED",o.get("state"));
        assertEquals(0,new java.math.BigDecimal("1.46").compareTo((java.math.BigDecimal)o.get("profit_usd")));

        // 4) Kill switch blocks new entries; audit trail holds every step.
        mvc.perform(post("/api/v1/broker/kill-switch").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf).contentType(MediaType.APPLICATION_JSON)
            .content("{\"on\":true}")).andExpect(status().isOk()).andExpect(jsonPath("$.account.kill_switch").value(true));
        putSignal(admin,"broker-it-killed",signal("broker-it-killed"));
        assertEquals("BLOCKED",order("broker-it-killed").get("state"));
        var events=jdbc.queryForList("SELECT event FROM broker_order_events WHERE order_id=? ORDER BY id",String.class,o.get("id"));
        assertEquals(java.util.List.of("ORDER_CREATED","DISPATCHED","BROKER_REPORT","BROKER_CLOSED"),events);
        mvc.perform(get("/api/v1/broker/orders").cookie(admin.cookies)).andExpect(status().isOk()).andExpect(jsonPath("$[0].client_order_id").exists());

        // 5) Live confirmation is impossible while the server flag is off.
        mvc.perform(post("/api/v1/broker/live-confirmation").cookie(admin.cookies).header("X-CSRF-Token",admin.csrf).contentType(MediaType.APPLICATION_JSON)
            .content("{\"confirm\":true,\"accountLogin\":\"99887766\"}")).andExpect(status().isBadRequest());

        // Another admin's signals are not mirrored to this account.
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM broker_orders WHERE signal_owner<>'brokeradmin'",Integer.class));
    }
}
