package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;

/** Admin-only broker linking API plus the token-authenticated endpoints the MT5 bridge EA polls. */
@RestController
@RequestMapping("/api/v1/broker")
public class BrokerController {
    private final AuthService auth;
    private final BrokerMirrorService broker;
    public BrokerController(AuthService auth,BrokerMirrorService broker){this.auth=auth;this.broker=broker;}

    // ── admin (session cookie + CSRF on writes, admin role only) ──
    @GetMapping("/account")
    public Map<String,Object> account(HttpServletRequest r){return broker.view(auth.admin(r,false).username());}

    @PutMapping("/account")
    public Map<String,Object> save(HttpServletRequest r,@RequestBody JsonNode body){
        var a=auth.admin(r,true);
        var out=broker.save(a.username(),body);
        auth.activity(a.username(),"BROKER_SETTINGS","broker_accounts",a.username(),"{}");
        return out;
    }

    @PostMapping("/account/token")
    public ResponseEntity<Map<String,Object>> token(HttpServletRequest r){
        var a=auth.admin(r,true);
        String token=broker.rotateToken(a.username());
        auth.activity(a.username(),"BROKER_TOKEN_ROTATED","broker_accounts",a.username(),"{}");
        // Shown once; only its hash is stored.
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL,"no-store").body(Map.of("token",token));
    }

    @PostMapping("/kill-switch")
    public Map<String,Object> kill(HttpServletRequest r,@RequestBody JsonNode body){
        var a=auth.admin(r,true);
        auth.activity(a.username(),"BROKER_KILL_SWITCH","broker_accounts",a.username(),"{\"on\":"+body.path("on").asBoolean()+"}");
        return broker.killSwitch(a.username(),body.path("on").asBoolean());
    }

    @PostMapping("/live-confirmation")
    public Map<String,Object> live(HttpServletRequest r,@RequestBody JsonNode body){
        var a=auth.admin(r,true);
        boolean confirm=body.path("confirm").asBoolean();
        auth.activity(a.username(),confirm?"BROKER_LIVE_CONFIRM":"BROKER_LIVE_REVOKE","broker_accounts",a.username(),"{}");
        return broker.confirmLive(a.username(),body.path("accountLogin").asText(""),confirm);
    }

    @PostMapping("/ping")
    public Map<String,Object> ping(HttpServletRequest r){return broker.ping(auth.admin(r,true).username());}

    @GetMapping("/orders")
    public List<Map<String,Object>> orders(HttpServletRequest r,@RequestParam(defaultValue="100") int limit){
        return broker.orders(auth.admin(r,false).username(),limit);
    }

    @GetMapping("/events")
    public List<Map<String,Object>> events(HttpServletRequest r,@RequestParam(required=false) Long orderId,
            @RequestParam(defaultValue="100") int limit){
        return broker.events(auth.admin(r,false).username(),orderId,limit);
    }

    // ── connector (MT5 bridge EA). Plain-text protocol so MQL5 needs no JSON parser. ──
    @PostMapping(value="/connector/poll",consumes=MediaType.APPLICATION_FORM_URLENCODED_VALUE,produces=MediaType.TEXT_PLAIN_VALUE)
    public ResponseEntity<String> poll(@RequestHeader(value="X-Riyan-Connector-Token",required=false) String token,
            @RequestParam Map<String,String> params){
        return text(broker.poll(token,params));
    }

    @PostMapping(value="/connector/report",consumes=MediaType.APPLICATION_FORM_URLENCODED_VALUE,produces=MediaType.TEXT_PLAIN_VALUE)
    public ResponseEntity<String> report(@RequestHeader(value="X-Riyan-Connector-Token",required=false) String token,
            @RequestParam Map<String,String> params){
        return text(broker.report(token,params));
    }

    private ResponseEntity<String> text(String body){
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL,"no-store").contentType(MediaType.TEXT_PLAIN).body(body);
    }

    /** server.error.include-message=never hides reasons; the Broker tab needs validation messages. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String,Object>> error(ResponseStatusException e){
        String reason=e.getStatusCode().value()==400?Objects.toString(e.getReason(),"Bad request"):"Request refused";
        return ResponseEntity.status(e.getStatusCode()).body(Map.of("reason",reason));
    }
}
