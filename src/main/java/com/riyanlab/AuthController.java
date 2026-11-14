package com.riyanlab;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import java.util.*;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {
    private final AuthService auth;
    public AuthController(AuthService auth) { this.auth = auth; }

    private String csrfCookie(HttpServletRequest req) {
        if(req.getCookies()==null)return null;
        for(var c:req.getCookies())if("RIYAN_CSRF".equals(c.getName()))return c.getValue();
        return null;
    }
    @PostMapping("/login")
    public ResponseEntity<Map<String,Object>> login(@RequestBody Map<String,String> body,HttpServletRequest request) {
        Map<String,Object> session=auth.login(body.get("username"),body.get("password"),request);
        String token=(String)session.get("token"),csrf=(String)session.get("csrf");
        Map<String,Object> result=new LinkedHashMap<>(session);
        result.remove("token");
        return ResponseEntity.ok()
            .header(HttpHeaders.SET_COOKIE,auth.sessionCookie(token,request.isSecure()),
                auth.csrfCookie(csrf,request.isSecure()))
            .header(HttpHeaders.CACHE_CONTROL,"no-store")
            .body(result);
    }
    @GetMapping("/me")
    public Map<String,Object> me(HttpServletRequest request) {
        var identity=auth.require(request,false);
        String csrf=csrfCookie(request);
        if(csrf==null)throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return Map.of("username",identity.username(),"role",identity.role(),"csrf",csrf,
            "permissions",auth.permissions());
    }
    @PostMapping("/logout")
    public ResponseEntity<Void> logout(HttpServletRequest request) {
        var identity=auth.require(request,true);
        auth.logout(request,identity);
        return ResponseEntity.noContent()
            .header(HttpHeaders.SET_COOKIE,auth.expireSessionCookie(request.isSecure()),
                auth.expireCsrfCookie(request.isSecure())).build();
    }
    @GetMapping("/users")
    public List<Map<String,Object>> users(HttpServletRequest req){
        auth.admin(req,false);return auth.users();
    }
    @PostMapping("/users")
    public Map<String,Boolean> newUser(@RequestBody Map<String,String> body,HttpServletRequest req){
        var actor=auth.admin(req,true);
        auth.createUser(actor,body.get("username"),body.get("password"),body.get("role"));
        return Map.of("created",true);
    }
    @PutMapping("/users/{username}/role")
    public Map<String,Boolean> role(@PathVariable String username,@RequestBody Map<String,String> body,HttpServletRequest req){
        var actor=auth.admin(req,true);
        auth.changeRole(actor,username,body.get("role"),body.get("password"));
        return Map.of("updated",true);
    }
    @PutMapping("/users/{username}/password")
    public Map<String,Boolean> password(@PathVariable String username,@RequestBody Map<String,String> body,HttpServletRequest req){
        var actor=auth.admin(req,true);
        auth.resetPassword(actor,username,body.get("password"));
        return Map.of("updated",true);
    }
    @PostMapping("/change-password")
    public Map<String,Boolean> changeOwn(@RequestBody Map<String,String> body,HttpServletRequest req){
        var actor=auth.require(req,true);
        auth.changeOwnPassword(actor,body.get("oldPassword"),body.get("password"));
        return Map.of("updated",true);
    }
    @PutMapping("/permissions")
    public Map<String,Boolean> permissions(@RequestBody Map<String,Object> body,HttpServletRequest req){
        var actor=auth.admin(req,true);
        auth.setPermission(actor,(String)body.get("role"),(String)body.get("feature"),Boolean.TRUE.equals(body.get("allowed")));
        return Map.of("updated",true);
    }

}
