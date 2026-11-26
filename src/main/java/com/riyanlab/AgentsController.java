package com.riyanlab;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

/** Read-only view of ATLAS's briefing, the day's tasks and the background status. */
@RestController
@RequestMapping("/api/v1/agents")
public class AgentsController {
    private final AuthService auth;private final LeadAgent lead;
    AgentsController(AuthService auth,LeadAgent lead){this.auth=auth;this.lead=lead;}
    @GetMapping("/lead") public Map<String,Object> lead(HttpServletRequest request){return lead.view(auth.require(request,false));}
}
