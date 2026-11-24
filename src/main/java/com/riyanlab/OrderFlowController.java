package com.riyanlab;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.Map;

/** Server-collected footprint minutes for the Volume Trap chart (display only). */
@RestController
@RequestMapping("/api/v1/market")
public class OrderFlowController {
    private final AuthService auth;private final OrderFlowCollector collector;
    OrderFlowController(AuthService auth,OrderFlowCollector collector){this.auth=auth;this.collector=collector;}
    @GetMapping("/order-flow")
    public Map<String,Object> orderFlow(@RequestParam String symbol,@RequestParam(defaultValue="") String boot,
            @RequestParam(defaultValue="0") long rev,HttpServletRequest req){
        auth.require(req,false);
        if(!OrderFlowCollector.SYMBOLS.contains(symbol)||boot.length()>16)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Unsupported order flow request");
        return collector.view(symbol,boot,rev,System.currentTimeMillis());
    }
}
