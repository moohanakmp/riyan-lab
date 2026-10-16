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
}
