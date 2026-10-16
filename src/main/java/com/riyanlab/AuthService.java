package com.riyanlab;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.regex.Pattern;
import java.util.HexFormat;
import java.sql.Timestamp;

@Service
public class AuthService {
    public record Identity(long id, String username, String role) {}
    private static final Pattern USERNAME = Pattern.compile("[a-zA-Z0-9_-]{3,48}");
    private static final Set<String> ROLES = Set.of("admin", "user", "guest");
    private static final long SESSION_SECONDS = 7 * 24 * 3600;
    private final JdbcTemplate jdbc;
    private final BCryptPasswordEncoder hasher = new BCryptPasswordEncoder(12);
    private final SecureRandom random = new SecureRandom();

    @Value("${RIYAN_BOOTSTRAP_ADMIN_USER:}")
    private String bootstrapUser;
    @Value("${RIYAN_BOOTSTRAP_ADMIN_PASSWORD:}")
    private String bootstrapPassword;

    public AuthService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @EventListener(ApplicationReadyEvent.class)
    public void bootstrapAdmin() {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM riyan_lab.auth_users", Integer.class);
        if (count != null && count > 0) return;
        if (!validUsername(bootstrapUser) || bootstrapPassword == null || bootstrapPassword.length() < 12) {
            System.err.println("Riyan Lab: configure RIYAN_BOOTSTRAP_ADMIN_USER and RIYAN_BOOTSTRAP_ADMIN_PASSWORD (12+ chars) to create the first admin.");
            return;
        }
        jdbc.update("INSERT INTO riyan_lab.auth_users(username,password_hash,role) VALUES(?,?,'admin') ON CONFLICT(username) DO NOTHING",
            bootstrapUser, hasher.encode(bootstrapPassword));
        activity(bootstrapUser, "BOOTSTRAP_ADMIN", "auth_users", bootstrapUser, "{}");
    }

    private boolean validUsername(String u) { return u != null && USERNAME.matcher(u).matches(); }
    private String randomSecret() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
    private String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    private String cookie(HttpServletRequest request, String name) {
        if (request.getCookies() == null) return null;
        for (Cookie cookie : request.getCookies())
            if (name.equals(cookie.getName())) return cookie.getValue();
        return null;
    }

    public String sessionCookie(String token, boolean secure) {
        return ResponseCookie.from("RIYAN_SESSION", token).httpOnly(true).secure(secure)
            .sameSite("Strict").path("/api/v1").maxAge(SESSION_SECONDS).build().toString();
    }
    public String csrfCookie(String token, boolean secure) {
        return ResponseCookie.from("RIYAN_CSRF", token).httpOnly(false).secure(secure)
            .sameSite("Strict").path("/").maxAge(SESSION_SECONDS).build().toString();
    }
    public String expireSessionCookie(boolean secure) {
        return ResponseCookie.from("RIYAN_SESSION", "").httpOnly(true).secure(secure)
            .sameSite("Strict").path("/api/v1").maxAge(0).build().toString();
    }
    public String expireCsrfCookie(boolean secure) {
        return ResponseCookie.from("RIYAN_CSRF", "").httpOnly(false).secure(secure)
            .sameSite("Strict").path("/").maxAge(0).build().toString();
    }

    public Map<String,Object> login(String username, String password, HttpServletRequest request) {
        if (username == null || password == null || password.length() > 1024)
            throw unauthorized();
        var rows = jdbc.queryForList(
          "SELECT id, username, password_hash, role, active, failed_logins, locked_until FROM riyan_lab.auth_users WHERE username=?",
          username);
        if (rows.isEmpty()) throw unauthorized();
        var row = rows.get(0);
        boolean active = Boolean.TRUE.equals(row.get("active"));
        Timestamp until = (Timestamp) row.get("locked_until");
        if (!active || (until != null && until.toInstant().isAfter(Instant.now()))) throw unauthorized();
        long id = ((Number)row.get("id")).longValue();
        if (!hasher.matches(password, (String)row.get("password_hash"))) {
            jdbc.update("UPDATE riyan_lab.auth_users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=?",id);
            activity(username,"LOGIN_FAILED","auth_users",username,"{}");
            throw unauthorized();
        }
        jdbc.update("UPDATE riyan_lab.auth_users SET failed_logins=0,locked_until=NULL WHERE id=?",id);
        String token = randomSecret(), csrf = randomSecret();
        jdbc.update("INSERT INTO riyan_lab.auth_sessions(token_hash,user_id,csrf_hash,expires_at) VALUES(?,?,?,?)",
            digest(token),id,digest(csrf),Timestamp.from(Instant.now().plus(SESSION_SECONDS, ChronoUnit.SECONDS)));
        activity(username, "LOGIN", "auth_sessions", null, "{}");
        return Map.of("username",username,"role",row.get("role"),"token",token,"csrf",csrf,"permissions",permissions());
    }

    private ResponseStatusException unauthorized() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials or session");
    }
    public Identity require(HttpServletRequest request, boolean mutation) {
        String token = cookie(request,"RIYAN_SESSION");
        if (token == null || token.isBlank()) throw unauthorized();
        var rows = jdbc.queryForList("""
            SELECT u.id,u.username,u.role,s.csrf_hash
            FROM riyan_lab.auth_sessions s
            JOIN riyan_lab.auth_users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>now() AND u.active=true
            """,digest(token));
        if (rows.isEmpty()) throw unauthorized();
        if (mutation) {
            String csrfHeader = request.getHeader("X-CSRF-Token");
            String csrfCookie = cookie(request, "RIYAN_CSRF");
            String expected = (String)rows.get(0).get("csrf_hash");
            if (csrfHeader == null || csrfCookie == null ||
                !MessageDigest.isEqual(csrfHeader.getBytes(StandardCharsets.UTF_8),csrfCookie.getBytes(StandardCharsets.UTF_8)) ||
                !MessageDigest.isEqual(digest(csrfHeader).getBytes(StandardCharsets.UTF_8),expected.getBytes(StandardCharsets.UTF_8)))
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "CSRF check failed");
        }
        var row=rows.get(0);
        return new Identity(((Number)row.get("id")).longValue(),(String)row.get("username"),(String)row.get("role"));
    }
    public Identity admin(HttpServletRequest request, boolean mutation) {
        Identity identity = require(request,mutation);
        if (!"admin".equals(identity.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        return identity;
    }
    public void mayRead(Identity identity,String type) {
        if ("guest".equals(identity.role()) && !Set.of("auto-signals","low-profit","news-alerts").contains(type))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }
    public void mayWrite(Identity identity,String type) {
        if ("guest".equals(identity.role())) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        if (!"admin".equals(identity.role()) && "tab-state".equals(type))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }
    public void logout(HttpServletRequest req,Identity identity) {
        String token=cookie(req,"RIYAN_SESSION");
        if(token!=null)jdbc.update("DELETE FROM riyan_lab.auth_sessions WHERE token_hash=?",digest(token));
        activity(identity.username(),"LOGOUT","auth_sessions",null,"{}");
    }

    public void activity(String username,String action,String type,String id,String json) {
        jdbc.update("INSERT INTO riyan_lab.user_activity(username,action,entity_type,entity_id,details) VALUES(?,?,?,?,?::jsonb)",
            username,action,type,id,json == null ? "{}":json);
    }
    public Map<String,Map<String,Boolean>> permissions() {
        Map<String,Map<String,Boolean>> result=new LinkedHashMap<>();
        result.put("user",new LinkedHashMap<>());result.put("guest",new LinkedHashMap<>());
        jdbc.query("SELECT role,feature,allowed FROM riyan_lab.app_permissions",rs->{
            result.computeIfAbsent(rs.getString("role"),x->new LinkedHashMap<>())
                .put(rs.getString("feature"),rs.getBoolean("allowed"));
        });
        return result;
    }
    public void setPermission(Identity actor,String role,String feature,boolean allowed) {
        if (!Set.of("user","guest").contains(role) ||
            !Set.of("dashboard","prices","chart","signals","historyHigh","historyMed","historyOverall","analysis","session","flow","manual","research","analytics","pnlReport","info").contains(feature))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        jdbc.update("""
          INSERT INTO riyan_lab.app_permissions(role,feature,allowed,changed_by) VALUES(?,?,?,?)
          ON CONFLICT(role,feature) DO UPDATE SET allowed=excluded.allowed, changed_by=excluded.changed_by,changed_at=now()
        """,role,feature,allowed,actor.username());
        activity(actor.username(),"UPDATE_PERMISSION","app_permissions",role+":"+feature,"{}");
    }
    public List<Map<String,Object>> users() {
        return jdbc.queryForList("SELECT username,role,active,created_at,updated_at FROM riyan_lab.auth_users ORDER BY username");
    }
    public void createUser(Identity actor,String username,String password,String role) {
        if (!validUsername(username) || password == null || password.length()<12 || password.length()>256 || !ROLES.contains(role))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Username, role or password invalid (minimum 12 chars)");
        jdbc.update("INSERT INTO riyan_lab.auth_users(username,password_hash,role) VALUES(?,?,?)",
            username,hasher.encode(password),role);
        activity(actor.username(),"CREATE_USER","auth_users",username,"{}");
    }
    public void changeRole(Identity actor,String username,String role) {
        if (!ROLES.contains(role) || !validUsername(username) || actor.username().equals(username))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        if(jdbc.update("UPDATE riyan_lab.auth_users SET role=?,updated_at=now() WHERE username=?",role,username)==0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        activity(actor.username(),"CHANGE_ROLE","auth_users",username,"{}");
    }
    public void resetPassword(Identity actor,String username,String password) {
        if (!validUsername(username) || password==null || password.length()<12 || password.length()>256)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        if(jdbc.update("UPDATE riyan_lab.auth_users SET password_hash=?,failed_logins=0,locked_until=NULL,updated_at=now() WHERE username=?",
            hasher.encode(password),username)==0)throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        jdbc.update("DELETE FROM riyan_lab.auth_sessions WHERE user_id=(SELECT id FROM riyan_lab.auth_users WHERE username=?)",username);
        activity(actor.username(),"RESET_PASSWORD","auth_users",username,"{}");
    }
    public void changeOwnPassword(Identity identity,String oldPassword,String password) {
        if(password==null || password.length()<12 || password.length()>256)throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        String hash=jdbc.queryForObject("SELECT password_hash FROM riyan_lab.auth_users WHERE id=?",String.class,identity.id());
        if(!hasher.matches(oldPassword==null?"":oldPassword,hash))throw unauthorized();
        resetPassword(identity,identity.username(),password);
    }
}
