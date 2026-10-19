package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@EnabledIfEnvironmentVariable(named="RIYAN_INTEGRATION_TEST",matches="true")
class AuthPersistenceIntegrationTest {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper mapper;

    private String paperJson(String key) throws Exception {
        var n=mapper.createObjectNode();
        n.put("sym","XAUUSD").put("dir","BUY").put("entry",100).put("sl",99.5)
            .put("tp",102).put("units",1).put("lot",.01).put("status","OPEN")
            .put("paperOnly",true).put("accountingVersion",2).put("signalKey",key)
            .put("updatedAt",System.currentTimeMillis()).putNull("brokerOrderId");
        return mapper.writeValueAsString(n);
    }
    private void lease(Cookie[] cookies,String csrf) throws Exception {
        mvc.perform(post("/api/v1/paper/lease").cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .header("X-Paper-Engine","integration-engine"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.owned").value(true));
    }
    @Test
    void loginAndAuditRequireServerSession() throws Exception {
        mvc.perform(get("/api/v1/paper/background/calendar-status")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/records/auto-signals"))
            .andExpect(status().isUnauthorized());
        var login=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"username\":\"testadmin\",\"password\":\"unit-test-password-1234\"}"))
            .andExpect(status().isOk()).andReturn();
        JsonNode session=mapper.readTree(login.getResponse().getContentAsString());
        assertEquals("admin",session.get("role").asText());
        String csrf=session.get("csrf").asText();
        Cookie[] cookies=login.getResponse().getCookies();
        assertNotNull(cookies);
        Cookie sessionCookie=null,csrfCookie=null;
        for(Cookie c:cookies) {
            if("RIYAN_SESSION".equals(c.getName()))sessionCookie=c;
            if("RIYAN_CSRF".equals(c.getName()))csrfCookie=c;
        }
        assertNotNull(sessionCookie);
        assertNotNull(csrfCookie);
        Cookie[] authCookies={sessionCookie,csrfCookie};
        lease(authCookies,csrf);
        mvc.perform(put("/api/v1/records/auto-signals/ci-123")
            .cookie(authCookies).contentType(MediaType.APPLICATION_JSON)
            .content("{\"sym\":\"XAUUSD\",\"dir\":\"BUY\",\"reason\":\"EMA20\"}"))
            .andExpect(status().isForbidden());
        mvc.perform(put("/api/v1/records/auto-signals/ci-123")
            .cookie(authCookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine").contentType(MediaType.APPLICATION_JSON)
            .content(paperJson("ci-123")))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/records/auto-signals").cookie(authCookies))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].source_id").exists());
        mvc.perform(get("/api/v1/audit").cookie(authCookies))
            .andExpect(status().isOk());
        mvc.perform(post("/api/v1/auth/logout").cookie(authCookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine"))
            .andExpect(status().isNoContent());
        mvc.perform(get("/api/v1/records/auto-signals").cookie(authCookies))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void allTradingTabsWriteIntoRiyanLabAndAuditUpdates() throws Exception {
        var login=mvc.perform(post("/api/v1/auth/login")
           .contentType(MediaType.APPLICATION_JSON)
           .content("{\"username\":\"testadmin\",\"password\":\"unit-test-password-1234\"}"))
           .andExpect(status().isOk()).andReturn();
        JsonNode session=mapper.readTree(login.getResponse().getContentAsString());
        String csrf=session.path("csrf").asText();
        var cookies=login.getResponse().getCookies();
        lease(cookies,csrf);
        for(String type:new String[]{"auto-signals","manual-signals","low-profit","analysis","seven-day",
                                     "pnl","gold-calls","research","news-alerts","tab-state","user-state"}) {
            String id="ci-"+type;
            mvc.perform(put("/api/v1/records/"+type+"/"+id)
                .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
                .contentType(MediaType.APPLICATION_JSON)
                .content(paperJson(id)))
                .andExpect(status().isOk());
            mvc.perform(get("/api/v1/records/"+type).cookie(cookies))
                .andExpect(status().isOk());
        }
        var closed=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.readTree(paperJson("ci-auto-signals"));
        closed.put("status","CLOSED").put("pnl",1.65).put("exit",102).put("closedAt",System.currentTimeMillis());
        mvc.perform(put("/api/v1/records/auto-signals/ci-auto-signals")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(closed)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/audit").cookie(cookies))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].action").value("UPDATE"));
    }

    @Test
    void adminCanProvisionNamedUserAccountsWithoutLegacyFrontendPasswords() throws Exception {
        var adminLogin=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","testadmin","password","unit-test-password-1234"))))
            .andExpect(status().isOk()).andReturn();
        String csrf=mapper.readTree(adminLogin.getResponse().getContentAsString()).path("csrf").asText();
        var adminCookies=adminLogin.getResponse().getCookies();
        for(var entry:java.util.Map.of("tsuser","user","vino","user","guest","guest").entrySet()) {
            String password="staging-new-password-"+entry.getKey()+"-123!";
            mvc.perform(post("/api/v1/auth/users")
                .cookie(adminCookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(java.util.Map.of(
                    "username",entry.getKey(),"role",entry.getValue(),"password",password))))
                .andExpect(status().isOk());
            var userLogin=mvc.perform(post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(java.util.Map.of(
                    "username",entry.getKey(),"password",password))))
                .andExpect(status().isOk()).andReturn();
            var session=mapper.readTree(userLogin.getResponse().getContentAsString());
            assertEquals(entry.getValue(),session.path("role").asText());
            if("guest".equals(entry.getValue())) {
                mvc.perform(get("/api/v1/records/pnl").cookie(userLogin.getResponse().getCookies()))
                    .andExpect(status().isForbidden());
            } else {
                mvc.perform(get("/api/v1/records/pnl").cookie(userLogin.getResponse().getCookies()))
                    .andExpect(status().isOk());
            }
        }
    }

    @Test
    void roleBasedPasswordPolicyWorksForCreateResetAndPromotion() throws Exception {
        var adminLogin=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","testadmin","password","unit-test-password-1234"))))
            .andExpect(status().isOk()).andReturn();
        String csrf=mapper.readTree(adminLogin.getResponse().getContentAsString()).path("csrf").asText();
        var cookies=adminLogin.getResponse().getCookies();
        // Admin keeps 12+ characters.
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","weakadmin","role","admin","password","12345"))))
            .andExpect(status().isBadRequest());

        // Normal users can use a password of exactly 5 characters, not 4.
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","shortuser","role","user","password","1234"))))
            .andExpect(status().isBadRequest());
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","shortuser","role","user","password","12345"))))
            .andExpect(status().isOk());
        mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","shortuser","password","12345"))))
            .andExpect(status().isOk());

        // Guest has no minimum (even a blank password), but no write access.
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","nopassguest","role","guest","password",""))))
            .andExpect(status().isOk());
        var guestLogin=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","nopassguest","password",""))))
            .andExpect(status().isOk()).andReturn();
        String guestCsrf=mapper.readTree(guestLogin.getResponse().getContentAsString())
            .path("csrf").asText();
        mvc.perform(put("/api/v1/records/auto-signals/test-guest-write")
            .cookie(guestLogin.getResponse().getCookies())
            .header("X-CSRF-Token",guestCsrf)
            .contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isForbidden());

        // Password reset obeys the existing role.
        mvc.perform(put("/api/v1/auth/users/shortuser/password")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("password","1234"))))
            .andExpect(status().isBadRequest());
        mvc.perform(put("/api/v1/auth/users/shortuser/password")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("password","abcde"))))
            .andExpect(status().isOk());

        // Guest -> user and user -> admin require new, stronger passwords.
        mvc.perform(put("/api/v1/auth/users/nopassguest/role")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("role","user"))))
            .andExpect(status().isBadRequest());
        mvc.perform(put("/api/v1/auth/users/nopassguest/role")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("role","user","password","abcde"))))
            .andExpect(status().isOk());
        mvc.perform(put("/api/v1/auth/users/shortuser/role")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("role","admin","password","abcde"))))
            .andExpect(status().isBadRequest());
        mvc.perform(put("/api/v1/auth/users/shortuser/role")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "role","admin","password","new-admin-secret-1234"))))
            .andExpect(status().isOk());
        var promotedLogin=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","shortuser","password","new-admin-secret-1234"))))
            .andExpect(status().isOk()).andReturn();
        assertEquals("admin",mapper.readTree(promotedLogin.getResponse().getContentAsString())
            .path("role").asText());
    }

    @Test
    void nonAdminCanSaveOnlyOwnHashedLowProfitDiagnostics() throws Exception {
        var adminLogin=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","testadmin","password","unit-test-password-1234"))))
            .andExpect(status().isOk()).andReturn();
        String adminCsrf=mapper.readTree(adminLogin.getResponse().getContentAsString())
            .path("csrf").asText();
        mvc.perform(post("/api/v1/auth/users")
            .cookie(adminLogin.getResponse().getCookies())
            .header("X-CSRF-Token",adminCsrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","stateowner","role","user","password","abcde"))))
            .andExpect(status().isOk());
        var login=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","stateowner","password","abcde"))))
            .andExpect(status().isOk()).andReturn();
        String csrf=mapper.readTree(login.getResponse().getContentAsString())
            .path("csrf").asText();
        var cookies=login.getResponse().getCookies();
        String hash="a".repeat(64);
        String ownId="stateowner--id-"+hash;
        String otherId="otheruser--id-"+hash;
        mvc.perform(put("/api/v1/records/user-state/"+ownId)
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "symbol","XAUUSD","blocked","5m data stale",
                "originalSourceId","stateowner:low-profit-diagnostics-XAUUSD"))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.saved").value(true));
        mvc.perform(get("/api/v1/records/user-state").cookie(cookies))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].source_id").value(ownId));
        mvc.perform(put("/api/v1/records/user-state/"+otherId)
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"symbol\":\"BTCUSD\"}"))
            .andExpect(status().isForbidden());
        mvc.perform(put("/api/v1/records/user-state/stateowner--not-a-hash")
            .cookie(cookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"symbol\":\"BTCUSD\"}"))
            .andExpect(status().isForbidden());
    }

    @Test
    void basketPaperLedgerIsAuditedAndUserScoped() throws Exception {
        var login=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","testadmin","password","unit-test-password-1234"))))
            .andExpect(status().isOk()).andReturn();
        var adminCookies=login.getResponse().getCookies();
        String adminCsrf=mapper.readTree(login.getResponse().getContentAsString())
            .path("csrf").asText();
        mvc.perform(post("/api/v1/auth/users")
            .cookie(adminCookies).header("X-CSRF-Token",adminCsrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","basketowner","role","user","password","abcde"))))
            .andExpect(status().isOk());
        var ownLogin=mvc.perform(post("/api/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","basketowner","password","abcde"))))
            .andExpect(status().isOk()).andReturn();
        var ownerCookies=ownLogin.getResponse().getCookies();
        String csrf=mapper.readTree(ownLogin.getResponse().getContentAsString())
            .path("csrf").asText();
        lease(ownerCookies,csrf);
        String ownId="basketowner--id-"+"b".repeat(64);
        String alienId="otheruser--id-"+"c".repeat(64);
        for(String type:java.util.List.of("basket-sessions","basket-positions",
                "basket-events","basket-replays")) {
            String path="/api/v1/records/"+type+"/"+ownId;
            String paperJson=paperJson("basket-ci");
            mvc.perform(put(path).cookie(ownerCookies)
                .header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine").contentType(MediaType.APPLICATION_JSON)
                .content(paperJson)).andExpect(status().isOk());
            mvc.perform(get("/api/v1/records/"+type).cookie(ownerCookies))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].source_id").value(ownId));
            mvc.perform(put("/api/v1/records/"+type+"/"+alienId)
                .cookie(ownerCookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
                .contentType(MediaType.APPLICATION_JSON)
                .content(paperJson)).andExpect(status().isForbidden());
        }
        mvc.perform(put("/api/v1/records/basket-sessions/"+ownId)
            .cookie(ownerCookies).header("X-CSRF-Token",csrf).header("X-Paper-Engine","integration-engine")
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "symbol","XAUUSD","status","CLOSED",
                "paperOnly",true,"closeReason","NET_TP",
                "netPnl",2.03)))).andExpect(status().isOk());
        mvc.perform(get("/api/v1/audit?limit=1000").cookie(adminCookies))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].record_type").value("basket-sessions"))
            .andExpect(jsonPath("$[0].action").value("UPDATE"));
    }
}
