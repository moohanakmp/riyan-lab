package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;

@RestController
@RequestMapping("/api/v1/paper/background")
public class BackgroundController {
    private final AuthService auth;private final BackgroundScanner scanner;private final JdbcTemplate jdbc;
    BackgroundController(AuthService auth,BackgroundScanner scanner,JdbcTemplate jdbc){this.auth=auth;this.scanner=scanner;this.jdbc=jdbc;}
    @GetMapping("/status") public Map<String,Object> status(HttpServletRequest req){var u=auth.require(req,false);auth.mayWrite(u,"low-profit");return scanner.status(u.username());}
    @PostMapping("/settings") public Map<String,Object> settings(HttpServletRequest req,@RequestBody JsonNode input){
        var u=auth.require(req,true);auth.mayWrite(u,"low-profit");
        if(!input.isObject()||!input.path("enabled").isBoolean()||!input.path("scalp").isObject()||input.toString().length()>5000)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid scanner settings");
        ObjectNode config=((ObjectNode)input).deepCopy();var scalp=config.path("scalp");
        for(String field:List.of("maxLoss","dayStop","target","goal","timeStopMin")){
            double n=scalp.path(field).asDouble(Double.NaN);
            if(!Double.isFinite(n)||n<=0||n>10000||(field.equals("maxLoss")&&n>4)||(field.equals("dayStop")&&n>8))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid paper risk settings");
        }
        for(String key:List.of("auto","stopAtGoal","continuation"))if(!scalp.path(key).isBoolean())throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid strategy switch");
        for(String sym:List.of("XAUUSD","XAGUSD","BTCUSD"))if(!scalp.path("assets").path(sym).isBoolean())throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid asset switch");
        jdbc.update("""
            INSERT INTO background_scanner_settings(username,enabled,config) VALUES(?,?,?::jsonb)
            ON CONFLICT(username) DO UPDATE SET enabled=EXCLUDED.enabled,config=EXCLUDED.config,updated_at=now()
            WHERE background_scanner_settings.enabled IS DISTINCT FROM EXCLUDED.enabled OR background_scanner_settings.config IS DISTINCT FROM EXCLUDED.config
            """,u.username(),input.path("enabled").asBoolean(),config.toString());
        return Map.of("saved",true,"enabled",input.path("enabled").asBoolean());
    }
}
