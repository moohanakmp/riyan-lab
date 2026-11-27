package com.riyanlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.nio.charset.StandardCharsets;
import java.security.Signature;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class PushNotificationsTest {
    final ObjectMapper json=new ObjectMapper();
    @Test void onlyBrowserPushServicesAreContacted(){
        assertTrue(PushNotifications.allowedEndpoint("https://fcm.googleapis.com/fcm/send/abc"));
        assertTrue(PushNotifications.allowedEndpoint("https://web.push.apple.com/QGx"));
        assertTrue(PushNotifications.allowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
        assertTrue(PushNotifications.allowedEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x"));
        for(String bad:List.of("http://fcm.googleapis.com/x","https://evil.com/fcm.googleapis.com","https://fcm.googleapis.com.evil.com/x",
            "https://localhost/x","https://user@fcm.googleapis.com/x","https://fcm.googleapis.com:8443/x","not a url",""))
            assertFalse(PushNotifications.allowedEndpoint(bad),bad);
    }
    @Test void vapidTokenIsAValidEs256SignatureForThePublishedKey()throws Exception{
        var jdbc=mock(JdbcTemplate.class);
        when(jdbc.queryForList(startsWith("SELECT public_key"))).thenReturn(List.of());
        when(jdbc.update(startsWith("INSERT INTO push_vapid"),any(),any())).thenReturn(1);
        var push=new PushNotifications(jdbc,json,mock(AuthService.class));
        String key=push.vapid();
        byte[] raw=Base64.getUrlDecoder().decode(key);
        assertEquals(65,raw.length);assertEquals(4,raw[0]);
        String jwt=push.jwt("https://fcm.googleapis.com",1_900_000_000L);
        String[] parts=jwt.split("\\.");assertEquals(3,parts.length);
        var claims=json.readTree(Base64.getUrlDecoder().decode(parts[1]));
        assertEquals("https://fcm.googleapis.com",claims.path("aud").asText());assertTrue(claims.path("sub").asText().startsWith("https://"));
        var verify=Signature.getInstance("SHA256withECDSAinP1363Format");verify.initVerify(PushNotifications.publicFromRaw(raw));
        verify.update((parts[0]+"."+parts[1]).getBytes(StandardCharsets.US_ASCII));
        assertTrue(verify.verify(Base64.getUrlDecoder().decode(parts[2])));
    }
    @Test void alertTextSaysPaperAndNeverClaimsProfit()throws Exception{
        var m=PushNotifications.message("auto-signals",json.readTree("{\"sym\":\"XAUUSD\",\"dir\":\"BUY\",\"price\":2650.1,\"sl\":2645,\"tp1\":2655}"));
        assertEquals("Paper signal: Gold BUY",m[0]);assertTrue(m[1].contains("Auto entry 2650.1, SL 2645, TP1 2655"));assertTrue(m[1].contains("Paper only"));
        var s=PushNotifications.message("low-profit",json.readTree("{\"sym\":\"XAGUSD\",\"dir\":\"SELL\",\"entry\":31.2,\"sl\":31.3,\"tp\":31.1}"));
        assertTrue(s[1].startsWith("Low Profit entry 31.2"));assertFalse((m[1]+s[1]).toLowerCase().contains("profit of"));
    }
}
