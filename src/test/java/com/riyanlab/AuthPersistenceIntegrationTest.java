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

    @Test
    void loginAndAuditRequireServerSession() throws Exception {
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
        mvc.perform(put("/api/v1/records/auto-signals/ci-123")
            .cookie(authCookies).contentType(MediaType.APPLICATION_JSON)
            .content("{\"sym\":\"XAUUSD\",\"dir\":\"BUY\",\"reason\":\"EMA20\"}"))
            .andExpect(status().isForbidden());
        mvc.perform(put("/api/v1/records/auto-signals/ci-123")
            .cookie(authCookies).header("X-CSRF-Token",csrf).contentType(MediaType.APPLICATION_JSON)
            .content("{\"sym\":\"XAUUSD\",\"dir\":\"BUY\",\"reason\":\"EMA20\",\"conditions\":{\"trend\":\"BULL\"}}"))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/records/auto-signals").cookie(authCookies))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].source_id").exists());
        mvc.perform(get("/api/v1/audit").cookie(authCookies))
            .andExpect(status().isOk());
        mvc.perform(post("/api/v1/auth/logout").cookie(authCookies).header("X-CSRF-Token",csrf))
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
        for(String type:new String[]{"auto-signals","manual-signals","low-profit","analysis","seven-day",
                                     "pnl","gold-calls","research","news-alerts","tab-state","user-state"}) {
            String id="ci-"+type;
            mvc.perform(put("/api/v1/records/"+type+"/"+id)
                .cookie(cookies).header("X-CSRF-Token",csrf)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"symbol\":\"XAUUSD\",\"status\":\"OPEN\",\"timeframe\":\"5m\",\"entry\":5000,\"sl\":4980,\"tp1\":5010,\"tp2\":5020,\"reason\":\"EMA20\",\"conditions\":{\"trend\":\"BULL\",\"adx\":24}}"))
                .andExpect(status().isOk());
            mvc.perform(get("/api/v1/records/"+type).cookie(cookies))
                .andExpect(status().isOk());
        }
        mvc.perform(put("/api/v1/records/auto-signals/ci-auto-signals")
            .cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"symbol\":\"XAUUSD\",\"status\":\"CLOSED\",\"reason\":\"TP1 reached\"}"))
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
                .cookie(adminCookies).header("X-CSRF-Token",csrf)
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
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","weakadmin","role","admin","password","12345"))))
            .andExpect(status().isBadRequest());

        // Normal users can use a password of exactly 5 characters, not 4.
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","shortuser","role","user","password","1234"))))
            .andExpect(status().isBadRequest());
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","shortuser","role","user","password","12345"))))
            .andExpect(status().isOk());
        mvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of(
                "username","shortuser","password","12345"))))
            .andExpect(status().isOk());

        // Guest has no minimum (even a blank password), but no write access.
        mvc.perform(post("/api/v1/auth/users").cookie(cookies).header("X-CSRF-Token",csrf)
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
            .cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("password","1234"))))
            .andExpect(status().isBadRequest());
        mvc.perform(put("/api/v1/auth/users/shortuser/password")
            .cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("password","abcde"))))
            .andExpect(status().isOk());

        // Guest -> user and user -> admin require new, stronger passwords.
        mvc.perform(put("/api/v1/auth/users/nopassguest/role")
            .cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("role","user"))))
            .andExpect(status().isBadRequest());
        mvc.perform(put("/api/v1/auth/users/nopassguest/role")
            .cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("role","user","password","abcde"))))
            .andExpect(status().isOk());
        mvc.perform(put("/api/v1/auth/users/shortuser/role")
            .cookie(cookies).header("X-CSRF-Token",csrf)
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(java.util.Map.of("role","admin","password","abcde"))))
            .andExpect(status().isBadRequest());
        mvc.perform(put("/api/v1/auth/users/shortuser/role")
            .cookie(cookies).header("X-CSRF-Token",csrf)
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
}
