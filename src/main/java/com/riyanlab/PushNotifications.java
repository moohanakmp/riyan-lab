package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.interfaces.ECPublicKey;
import java.security.spec.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Web Push for new paper signals, sent by the server so the phone or laptop is told even when the
 * app is closed. Pushes carry no payload (so no message encryption is needed): the service worker
 * wakes, fetches /api/v1/push/inbox with the signed-in session and shows the alert text.
 * The VAPID key pair is generated once and kept in the database (private key sealed with
 * RIYAN_TOKEN_KEY when it is set). Only the browsers' own push services are contacted.
 */
@RestController
@RequestMapping("/api/v1/push")
public class PushNotifications {
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final AuthService auth;private final HttpClient client;
    private final AtomicBoolean busy=new AtomicBoolean();
    static TokenCipher cipher=TokenCipher.fromEnv();
    @Value("${RENDER_EXTERNAL_URL:https://riyan-lab.onrender.com}") String site="https://riyan-lab.onrender.com";
    private volatile KeyPair keys;private volatile String publicKey;
    @org.springframework.beans.factory.annotation.Autowired
    public PushNotifications(JdbcTemplate jdbc,ObjectMapper json,AuthService auth){this(jdbc,json,auth,HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build());}
    PushNotifications(JdbcTemplate jdbc,ObjectMapper json,AuthService auth,HttpClient client){this.jdbc=jdbc;this.json=json;this.auth=auth;this.client=client;}

    private AuthService.Identity user(HttpServletRequest request,boolean write){
        var u=auth.require(request,write);
        if(!Set.of("admin","user").contains(u.role()))throw new ResponseStatusException(HttpStatus.FORBIDDEN,"Alerts need a user account");
        return u;
    }
    @GetMapping("/key") public Map<String,Object> key(HttpServletRequest request){user(request,false);return Map.of("publicKey",vapid());}
    @GetMapping("/status") public Map<String,Object> status(HttpServletRequest request){
        var u=user(request,false);
        var devices=jdbc.queryForList("SELECT device,failures,last_error AS \"lastError\",extract(epoch FROM last_sent_at)*1000 AS \"lastSentAt\" FROM push_subscriptions WHERE username=? ORDER BY id",u.username());
        var sent=jdbc.queryForObject("SELECT count(*) FROM push_alerts WHERE username=? AND sent_at>now()-interval '1 day'",Long.class,u.username());
        return Map.of("devices",devices,"sent24h",sent);
    }
    @PostMapping("/subscribe") public Map<String,Object> subscribe(HttpServletRequest request,@RequestBody JsonNode input){
        var u=user(request,true);
        String endpoint=input.path("endpoint").asText(""),device=input.path("device").asText("").replaceAll("[^\\w .,()/+-]","");
        if(!allowedEndpoint(endpoint))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Unsupported push service");
        if(jdbc.queryForObject("SELECT count(*) FROM push_subscriptions WHERE username=?",Long.class,u.username())>=10)
            jdbc.update("DELETE FROM push_subscriptions WHERE id=(SELECT id FROM push_subscriptions WHERE username=? ORDER BY id LIMIT 1)",u.username());
        jdbc.update("""
            INSERT INTO push_subscriptions(username,endpoint,device) VALUES(?,?,?)
            ON CONFLICT(endpoint) DO UPDATE SET username=EXCLUDED.username,device=EXCLUDED.device,failures=0,last_error=''
            """,u.username(),endpoint,device.substring(0,Math.min(80,device.length())));
        return Map.of("saved",true);
    }
    @PostMapping("/unsubscribe") public Map<String,Object> unsubscribe(HttpServletRequest request,@RequestBody JsonNode input){
        var u=user(request,true);
        return Map.of("removed",jdbc.update("DELETE FROM push_subscriptions WHERE username=? AND endpoint=?",u.username(),input.path("endpoint").asText("")));
    }
    @PostMapping("/test") public Map<String,Object> test(HttpServletRequest request){
        var u=user(request,true);
        if(jdbc.queryForObject("SELECT count(*) FROM push_subscriptions WHERE username=?",Long.class,u.username())==0)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Turn on alerts on this device first");
        jdbc.update("INSERT INTO push_alerts(username,record_type,source_id,title,body) VALUES(?,'test',?,?,?)",u.username(),UUID.randomUUID().toString(),"KMR alerts are on","This device will be told about new paper signals from the server scan, even with the app closed.");
        return Map.of("sent",sendFor(u.username()));
    }
    /** Read by the service worker after a push. Cookie session; only the account's own recent alerts. */
    @GetMapping("/inbox") public List<Map<String,Object>> inbox(HttpServletRequest request){
        var u=user(request,false);
        return jdbc.queryForList("SELECT id,title,body,extract(epoch FROM created_at)*1000 AS at FROM push_alerts WHERE username=? AND created_at>now()-interval '30 minutes' ORDER BY id DESC LIMIT 5",u.username());
    }

    static boolean allowedEndpoint(String endpoint){
        try{
            if(endpoint.length()>1000)return false;
            var uri=URI.create(endpoint);String host=Objects.toString(uri.getHost(),"").toLowerCase(Locale.ROOT);
            if(!"https".equals(uri.getScheme())||uri.getPort()!=-1&&uri.getPort()!=443||uri.getUserInfo()!=null)return false;
            return host.equals("fcm.googleapis.com")||host.equals("updates.push.services.mozilla.com")||host.endsWith(".push.services.mozilla.com")
                ||host.endsWith(".push.apple.com")||host.endsWith(".notify.windows.com");
        }catch(RuntimeException e){return false;}
    }

    // ── Queue and send ───────────────────────────────────────────────────────────
    @Scheduled(initialDelay=20000,fixedDelay=15000) public void deliver(){
        if(!busy.compareAndSet(false,true))return;
        try{
            queue();
            jdbc.update("DELETE FROM push_alerts WHERE created_at<now()-interval '7 days'");
            var users=jdbc.queryForList("SELECT DISTINCT username FROM push_alerts WHERE sent_at IS NULL AND created_at>now()-interval '30 minutes'");
            for(var row:users)sendFor((String)row.get("username"));
            // Alerts nobody can receive (no device left, or too old) are dropped, not left waiting.
            jdbc.update("DELETE FROM push_alerts a WHERE sent_at IS NULL AND (created_at<=now()-interval '30 minutes' OR NOT EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.username=a.username))");
        }catch(Exception e){org.slf4j.LoggerFactory.getLogger(PushNotifications.class).warn("Push cycle failed: {}",e.getClass().getSimpleName());}
        finally{busy.set(false);}
    }
    /** New accepted paper entries from the last hour, for accounts with at least one device. */
    void queue(){
        for(var entry:Map.of("auto-signals","auto_signals","manual-signals","manual_signals","low-profit","low_profit_signals").entrySet()){
            var rows=jdbc.queryForList("""
                SELECT r.created_by AS username,r.source_id,r.payload::text AS payload FROM %s r
                JOIN auth_users u ON u.username=r.created_by AND u.active AND u.role IN ('admin','user')
                WHERE r.payload->>'accountingVersion'='2' AND r.created_at>now()-interval '1 hour'
                  AND r.created_at>=(SELECT min(s.created_at) FROM push_subscriptions s WHERE s.username=r.created_by)
                  AND NOT EXISTS(SELECT 1 FROM push_alerts a WHERE a.username=r.created_by AND a.record_type=? AND a.source_id=r.source_id)
                LIMIT 50
                """.formatted(entry.getValue()),entry.getKey());
            for(var r:rows){
                try{
                    var p=json.readTree((String)r.get("payload"));var text=message(entry.getKey(),p);
                    jdbc.update("INSERT INTO push_alerts(username,record_type,source_id,title,body) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",r.get("username"),entry.getKey(),r.get("source_id"),text[0],text[1]);
                }catch(Exception ignored){/* unreadable record: skipped */}
            }
        }
    }
    static String[] message(String type,JsonNode r){
        boolean scalp=type.equals("low-profit");
        String name=LeadAgent.NAMES.getOrDefault(r.path("sym").asText(),r.path("sym").asText());
        String kind=scalp?"Low Profit":type.equals("manual-signals")?"Manual":"Auto";
        String title=LeadAgent.clip("Paper signal: "+name+" "+r.path("dir").asText(),120);
        StringBuilder b=new StringBuilder(kind).append(" entry ").append(r.path(scalp?"entry":"price").asText()).append(", SL ").append(r.path("sl").asText());
        if(scalp)b.append(", TP ").append(r.path("tp").asText());else if(r.hasNonNull("tp1"))b.append(", TP1 ").append(r.path("tp1").asText());
        b.append(". Paper only. Check the app before acting.");
        return new String[]{title,LeadAgent.clip(b.toString(),400)};
    }
    int sendFor(String username){
        var subs=jdbc.queryForList("SELECT id,endpoint FROM push_subscriptions WHERE username=?",username);
        int ok=0;
        for(var s:subs){
            long id=((Number)s.get("id")).longValue();int code=send((String)s.get("endpoint"));
            if(code>=200&&code<300){ok++;jdbc.update("UPDATE push_subscriptions SET failures=0,last_error='',last_sent_at=now() WHERE id=?",id);}
            else if(code==404||code==410)jdbc.update("DELETE FROM push_subscriptions WHERE id=?",id);
            else jdbc.update("UPDATE push_subscriptions SET failures=failures+1,last_error=? WHERE id=?",code<0?"Push service unreachable":"Push service HTTP "+code,id);
        }
        jdbc.update("DELETE FROM push_subscriptions WHERE username=? AND failures>=20",username);
        if(ok>0)jdbc.update("UPDATE push_alerts SET sent_at=now() WHERE username=? AND sent_at IS NULL",username);
        return ok;
    }
    int send(String endpoint){
        if(!allowedEndpoint(endpoint))return 410;
        try{
            var uri=URI.create(endpoint);
            String jwt=jwt(uri.getScheme()+"://"+uri.getHost(),Instant.now().getEpochSecond()+12*3600);
            var request=HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(10)).header("TTL","600").header("Urgency","high")
                .header("Authorization","vapid t="+jwt+", k="+vapid()).POST(HttpRequest.BodyPublishers.noBody()).build();
            return client.send(request,HttpResponse.BodyHandlers.discarding()).statusCode();
        }catch(Exception e){if(e instanceof InterruptedException)Thread.currentThread().interrupt();return -1;}
    }

    // ── VAPID (RFC 8292) ─────────────────────────────────────────────────────────
    static final Base64.Encoder B64=Base64.getUrlEncoder().withoutPadding();
    String jwt(String audience,long exp)throws Exception{
        vapid();
        String sub=site!=null&&site.startsWith("https://")?site:"https://riyan-lab.onrender.com";
        String head=B64.encodeToString("{\"typ\":\"JWT\",\"alg\":\"ES256\"}".getBytes(StandardCharsets.UTF_8));
        String body=B64.encodeToString(json.writeValueAsBytes(Map.of("aud",audience,"exp",exp,"sub",sub)));
        var sig=Signature.getInstance("SHA256withECDSAinP1363Format");sig.initSign(keys.getPrivate());
        sig.update((head+"."+body).getBytes(StandardCharsets.US_ASCII));
        return head+"."+body+"."+B64.encodeToString(sig.sign());
    }
    synchronized String vapid(){
        if(publicKey!=null)return publicKey;
        try{
            Boolean stored=load();
            if(Boolean.TRUE.equals(stored))return publicKey;
            // The sealing key changed: old subscriptions are bound to the old public key.
            if(stored==null){jdbc.update("DELETE FROM push_subscriptions");jdbc.update("DELETE FROM push_vapid");}
            var gen=KeyPairGenerator.getInstance("EC");gen.initialize(new ECGenParameterSpec("secp256r1"));var pair=gen.generateKeyPair();
            String pub=B64.encodeToString(raw((ECPublicKey)pair.getPublic()));
            int inserted=jdbc.update("INSERT INTO push_vapid(id,public_key,private_key) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING",pub,cipher.seal(Base64.getEncoder().encodeToString(pair.getPrivate().getEncoded())));
            // Another instance won the insert: use its keys so every subscription matches one key.
            if(inserted==0&&Boolean.TRUE.equals(load()))return publicKey;
            keys=pair;publicKey=pub;return pub;
        }catch(GeneralSecurityException e){throw new IllegalStateException("Push keys unavailable",e);}
    }
    /** true = stored keys loaded, false = none stored, null = stored but unreadable. */
    private Boolean load()throws GeneralSecurityException{
        var rows=jdbc.queryForList("SELECT public_key,private_key FROM push_vapid WHERE id=1");
        if(rows.isEmpty())return false;
        String priv=cipher.open((String)rows.getFirst().get("private_key"));if(priv==null)return null;
        var pk=KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(priv)));
        String pub=(String)rows.getFirst().get("public_key");
        keys=new KeyPair(publicFromRaw(Base64.getUrlDecoder().decode(pub)),pk);publicKey=pub;return true;
    }
    static byte[] raw(ECPublicKey k){
        byte[] out=new byte[65];out[0]=4;
        copy(k.getW().getAffineX(),out,1);copy(k.getW().getAffineY(),out,33);return out;
    }
    private static void copy(BigInteger v,byte[] out,int at){byte[] b=v.toByteArray();int n=Math.min(32,b.length);System.arraycopy(b,b.length-n,out,at+32-n,n);}
    static PublicKey publicFromRaw(byte[] raw)throws GeneralSecurityException{
        var params=AlgorithmParameters.getInstance("EC");params.init(new ECGenParameterSpec("secp256r1"));
        var spec=params.getParameterSpec(ECParameterSpec.class);
        var point=new ECPoint(new BigInteger(1,Arrays.copyOfRange(raw,1,33)),new BigInteger(1,Arrays.copyOfRange(raw,33,65)));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point,spec));
    }
}
