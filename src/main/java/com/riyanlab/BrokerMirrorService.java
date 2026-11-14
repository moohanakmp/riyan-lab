package com.riyanlab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

/**
 * Mirrors app signal entries to the admin's linked MT5 account through a pull-based bridge EA.
 *
 * Safety model:
 *  - Default mode is DRY_RUN: every intended order is recorded, nothing is dispatched.
 *  - EXECUTE dispatches only to a terminal whose reported login/server match the linked account.
 *  - A REAL (non-demo) terminal is refused unless RIYAN_BROKER_LIVE_ENABLED=true on the server
 *    AND the admin confirmed live trading by typing the account login in the Broker tab.
 *  - Kill switch, max lot, max open positions, max orders/day, daily loss and stale-signal expiry
 *    are enforced both when an order is queued and again right before it is handed to the EA.
 *  - Nothing is ever re-dispatched automatically: an order without a broker report becomes UNKNOWN
 *    and is resolved from the positions the terminal reports, so a slow network cannot double-fill.
 *  - The broker password never reaches this server. Only a SHA-256 hash of the connector token is stored.
 */
@Service
public class BrokerMirrorService {
    static final Set<String> MIRRORED_TYPES=Set.of("auto-signals","manual-signals");
    private static final Set<String> SYMBOLS=Set.of("XAUUSD","XAGUSD","BTCUSD");
    private static final String IST_TODAY="date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'";
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final SecureRandom random=new SecureRandom();
    private final boolean liveEnabledByEnv;

    public BrokerMirrorService(JdbcTemplate jdbc,ObjectMapper json,PlatformTransactionManager txManager,
            @Value("${RIYAN_BROKER_LIVE_ENABLED:false}") boolean liveEnabledByEnv) {
        this.jdbc=jdbc;this.json=json;this.liveEnabledByEnv=liveEnabledByEnv;
        this.tx=new TransactionTemplate(txManager);
        this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    // ───────────────────────── signal hook ─────────────────────────

    /** Called from the audited record write path; runs after that transaction commits so a broker issue never blocks a signal. */
    public void afterSignalSaved(String owner,String type,String sourceId,String previousRaw,String nextRaw) {
        if(!MIRRORED_TYPES.contains(type))return;
        Runnable work=()->{
            try{tx.executeWithoutResult(s->onSignal(owner,type,sourceId,previousRaw,nextRaw));}
            catch(RuntimeException e){System.err.println("Broker mirror skipped for "+type+"/"+sourceId+": "+e.getClass().getSimpleName());}
        };
        if(TransactionSynchronizationManager.isSynchronizationActive())
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization(){
                @Override public void afterCommit(){work.run();}
            });
        else work.run();
    }

    void onSignal(String owner,String type,String sourceId,String previousRaw,String nextRaw) {
        var accounts=jdbc.queryForList("SELECT * FROM broker_accounts WHERE owner_username=? AND enabled=true FOR UPDATE",owner);
        if(accounts.isEmpty())return;
        Map<String,Object> acct=accounts.getFirst();
        if("auto-signals".equals(type)&&!bool(acct,"mirror_auto"))return;
        if("manual-signals".equals(type)&&!bool(acct,"mirror_manual"))return;
        long accountId=num(acct,"id").longValue();
        JsonNode next=parse(nextRaw),prev=previousRaw==null?null:parse(previousRaw);
        String status=signalStatus(next);
        var existing=jdbc.queryForList("SELECT * FROM broker_orders WHERE account_id=? AND signal_type=? AND signal_source_id=? AND action='OPEN' FOR UPDATE",
            accountId,type,sourceId);
        if(existing.isEmpty()) {
            // Only fresh entries are mirrored; signals that existed before linking stay app-only.
            if(prev!=null||!"OPEN".equals(status))return;
            createOpen(acct,type,sourceId,owner,next);
            return;
        }
        Map<String,Object> order=existing.getFirst();
        long orderId=num(order,"id").longValue();
        String state=(String)order.get("state");
        if(!"OPEN".equals(status)) {
            switch(state) {
                case "QUEUED","BLOCKED" -> {
                    setState(orderId,"CANCELLED","App signal closed ("+status+") before dispatch");
                    event(orderId,accountId,"CANCELLED","app",Map.of("signalStatus",status));
                }
                case "FILLED","DISPATCHED","UNKNOWN" -> queueChild(acct,order,"CLOSE",null,"App signal closed ("+status+")");
                default -> event(orderId,accountId,"SIGNAL_CLOSED","app",Map.of("signalStatus",status,"orderState",state));
            }
            return;
        }
        boolean beNow=next.path("beMoved").asBoolean(false),beBefore=prev!=null&&prev.path("beMoved").asBoolean(false);
        if(beNow&&!beBefore) {
            if("FILLED".equals(state)) {
                BigDecimal be=order.get("fill_price")!=null?(BigDecimal)order.get("fill_price"):(BigDecimal)order.get("entry_ref");
                queueChild(acct,order,"MODIFY",be,"App moved stop to break-even");
            } else event(orderId,accountId,"SIGNAL_BREAKEVEN","app",Map.of("orderState",state));
        }
    }

    private void createOpen(Map<String,Object> acct,String type,String sourceId,String owner,JsonNode s) {
        long accountId=num(acct,"id").longValue();
        String sym=s.path("sym").asText(s.path("symbol").asText("")),dir=s.path("dir").asText(s.path("direction").asText(""));
        BigDecimal entry=decimal(s,"entry","price"),sl=decimal(s,"sl","stopLoss");
        BigDecimal tp=decimal(s,"tp3");if(tp==null)tp=decimal(s,"tp","tp2","tp1");
        BigDecimal lot=decimal(s,"lot");if(lot==null)lot=new BigDecimal("0.01");
        BigDecimal volume=lot.min((BigDecimal)acct.get("max_lot")).setScale(2,RoundingMode.DOWN);
        String brokerSymbol=mapSymbol(acct,sym);
        long id=jdbc.queryForObject("SELECT nextval(pg_get_serial_sequence('broker_orders','id'))",Long.class);
        String clientId="RL-"+id;
        String state,reason;
        String invalid=validatePlan(acct,sym,dir,entry,sl,tp,volume);
        if(invalid!=null){state="BLOCKED";reason=invalid;}
        else if("DRY_RUN".equals(acct.get("mode"))){state="DRY_RUN";reason="Dry-run mode: recorded only, not sent to broker";}
        else{reason=gate(acct,null,null);state=reason==null?"QUEUED":"BLOCKED";}
        jdbc.update("""
            INSERT INTO broker_orders(id,account_id,client_order_id,action,signal_type,signal_source_id,signal_owner,symbol,broker_symbol,
                side,volume,entry_ref,stop_loss,take_profit,state,state_reason)
            VALUES(?,?,?,'OPEN',?,?,?,?,?,?,?,?,?,?,?,?)
            """,id,accountId,clientId,type,sourceId,owner,sym,brokerSymbol,
            Set.of("BUY","SELL").contains(dir)?dir:null,volume,entry,sl,tp,state,reason);
        var d=new LinkedHashMap<String,Object>();
        d.put("signal",type+"/"+sourceId);d.put("symbol",sym);d.put("side",dir);d.put("volume",volume);
        d.put("entryRef",entry);d.put("sl",sl);d.put("tp",tp);d.put("state",state);if(reason!=null)d.put("reason",reason);
        event(id,accountId,"ORDER_CREATED","app",d);
    }

    private String validatePlan(Map<String,Object> acct,String sym,String dir,BigDecimal entry,BigDecimal sl,BigDecimal tp,BigDecimal volume) {
        if(!SYMBOLS.contains(sym))return "Unsupported symbol "+sym;
        if(!allowedSymbols(acct).contains(sym))return sym+" is not in the allowed symbol list";
        if(!Set.of("BUY","SELL").contains(dir))return "Invalid direction";
        if(entry==null||sl==null||entry.signum()<=0||sl.signum()<=0)return "Entry and stop loss are required";
        int sign="BUY".equals(dir)?1:-1;
        if(entry.subtract(sl).signum()*sign<=0)return "Stop loss is on the wrong side of entry";
        if(tp!=null&&tp.subtract(entry).signum()*sign<=0)return "Take profit is on the wrong side of entry";
        if(volume.compareTo(new BigDecimal("0.01"))<0)return "Volume below broker minimum 0.01";
        return null;
    }

    /** Risk gate for a new OPEN. floating/openPositions come from the terminal when known. */
    private String gate(Map<String,Object> acct,BigDecimal floating,Integer openPositions) {
        long accountId=num(acct,"id").longValue();
        if(!bool(acct,"enabled"))return "Mirroring disabled";
        if(bool(acct,"kill_switch"))return "Kill switch is ON";
        BigDecimal closedToday=jdbc.queryForObject("SELECT COALESCE(SUM(profit_usd),0) FROM broker_orders WHERE account_id=? AND action='OPEN' AND closed_at>="+IST_TODAY,
            BigDecimal.class,accountId);
        BigDecimal dayNet=closedToday.add(floating==null?BigDecimal.ZERO:floating);
        if(dayNet.compareTo(((BigDecimal)acct.get("max_daily_loss_usd")).negate())<=0)
            return "Daily loss limit reached (today "+dayNet.setScale(2,RoundingMode.HALF_UP)+" USD)";
        int open=jdbc.queryForObject("SELECT count(*) FROM broker_orders WHERE account_id=? AND action='OPEN' AND state IN ('DISPATCHED','UNKNOWN','FILLED')",Integer.class,accountId);
        if(openPositions!=null)open=Math.max(open,openPositions);
        if(open>=num(acct,"max_open_positions").intValue())return "Max open positions reached ("+open+")";
        int today=jdbc.queryForObject("SELECT count(*) FROM broker_orders WHERE account_id=? AND action='OPEN' AND state IN ('DISPATCHED','UNKNOWN','FILLED','CLOSED','REJECTED') AND created_at>="+IST_TODAY,
            Integer.class,accountId);
        if(today>=num(acct,"max_orders_per_day").intValue())return "Max orders per day reached ("+today+")";
        return null;
    }

    private void queueChild(Map<String,Object> acct,Map<String,Object> parent,String action,BigDecimal sl,String reason) {
        long accountId=num(acct,"id").longValue(),parentId=num(parent,"id").longValue();
        Integer dup=jdbc.queryForObject("SELECT count(*) FROM broker_orders WHERE parent_id=? AND action=? AND state NOT IN ('REJECTED','CANCELLED')",Integer.class,parentId,action);
        if(dup!=null&&dup>0&&"CLOSE".equals(action))return;
        long id=jdbc.queryForObject("SELECT nextval(pg_get_serial_sequence('broker_orders','id'))",Long.class);
        int n=jdbc.update("""
            INSERT INTO broker_orders(id,account_id,client_order_id,parent_id,action,signal_type,signal_source_id,signal_owner,symbol,broker_symbol,
                side,volume,stop_loss,state,state_reason)
            SELECT ?,account_id,?,id,?,signal_type,signal_source_id,signal_owner,symbol,broker_symbol,side,volume,?,'QUEUED',?
            FROM broker_orders WHERE id=? ON CONFLICT DO NOTHING
            """,id,"RL-"+id,action,sl,reason,parentId);
        if(n>0)event(id,accountId,action+"_QUEUED","app",Map.of("parent",parent.get("client_order_id"),"reason",reason));
    }

    // ───────────────────────── connector (EA) protocol ─────────────────────────

    public String poll(String token,Map<String,String> p) {
        return tx.execute(s->doPoll(token,p));
    }

    private String doPoll(String token,Map<String,String> p) {
        Map<String,Object> acct=accountByToken(token);
        long accountId=num(acct,"id").longValue();
        String login=clip(p.get("login"),32),server=clip(p.get("server"),80),mode=clip(p.getOrDefault("mode",""),12).toLowerCase(Locale.ROOT);
        ObjectNode info=json.createObjectNode();
        info.put("login",login).put("server",server).put("mode",mode).put("currency",clip(p.get("currency"),8))
            .put("company",clip(p.get("company"),80)).put("balance",clip(p.get("balance"),24)).put("equity",clip(p.get("equity"),24))
            .put("ea",clip(p.get("ea"),24)).put("build",clip(p.get("build"),12)).put("tradeAllowed",clip(p.get("tradeAllowed"),5));
        List<String[]> positions=rows(p.get("positions"),9);
        BigDecimal floating=BigDecimal.ZERO;int ours=0;
        for(String[] r:positions){if(r[1].startsWith("RL-")){ours++;floating=floating.add(dec(r[8]));}}
        info.put("openPositions",ours).put("floatingUsd",floating);
        jdbc.update("UPDATE broker_accounts SET connector_last_seen=now(),connector_info=?::jsonb WHERE id=?",info.toString(),accountId);

        // 1) Reconcile what the terminal actually holds (the only execution evidence we trust).
        for(String[] r:positions) {
            if(!r[1].startsWith("RL-"))continue;
            int n=jdbc.update("""
                UPDATE broker_orders SET state='FILLED',broker_ticket=?,fill_price=COALESCE(fill_price,?),fill_volume=COALESCE(fill_volume,?),
                    fill_time=COALESCE(fill_time,now()),state_reason='Position found in terminal',updated_at=now()
                WHERE account_id=? AND client_order_id=? AND action='OPEN' AND state IN ('QUEUED','DISPATCHED','UNKNOWN')
                """,clip(r[0],40),decOrNull(r[5]),decOrNull(r[4]),accountId,r[1]);
            if(n>0)event(orderIdByClient(accountId,r[1]),accountId,"RECONCILED_FILLED","connector",Map.of("ticket",r[0],"openPrice",r[5],"volume",r[4]));
        }
        for(String[] r:rows(p.get("closes"),5)) {
            // Brokers may rewrite the closing deal comment (e.g. "[sl ...]"), so match the position ticket too.
            String ticket=clip(r[0],40);
            var ids=jdbc.queryForList("""
                UPDATE broker_orders SET state='CLOSED',broker_ticket=COALESCE(broker_ticket,?),close_price=?,profit_usd=?,
                    closed_at=COALESCE(to_timestamp(?::bigint),now()),updated_at=now()
                WHERE account_id=? AND action='OPEN' AND state IN ('DISPATCHED','UNKNOWN','FILLED')
                  AND (client_order_id=? OR (broker_ticket IS NOT NULL AND broker_ticket=?)) RETURNING id
                """,ticket,decOrNull(r[2]),decOrNull(r[3]),longOrNull(r[4]),accountId,r[1],ticket);
            for(var row:ids){
                long oid=num(row,"id").longValue();
                event(oid,accountId,"BROKER_CLOSED","connector",Map.of("ticket",r[0],"closePrice",r[2],"profitUsd",r[3],"time",r[4]));
                jdbc.update("UPDATE broker_orders SET state='CANCELLED',state_reason='Position already closed at broker',updated_at=now() WHERE parent_id=? AND state='QUEUED'",oid);
            }
        }
        // 2) Never re-send: a dispatch without a report becomes UNKNOWN until positions resolve it.
        for(var r:jdbc.queryForList("UPDATE broker_orders SET state='UNKNOWN',state_reason='No broker report within 120s; awaiting terminal reconciliation',updated_at=now() WHERE account_id=? AND state='DISPATCHED' AND dispatched_at<now()-interval '120 seconds' RETURNING id",accountId))
            event(num(r,"id").longValue(),accountId,"UNKNOWN","server",Map.of());
        for(var r:jdbc.queryForList("UPDATE broker_orders SET state='EXPIRED',state_reason='Signal older than max signal age; not chased',updated_at=now() WHERE account_id=? AND action='OPEN' AND state='QUEUED' AND created_at<now()-make_interval(secs=>?::double precision) RETURNING id",
                accountId,num(acct,"max_signal_age_seconds").intValue()))
            event(num(r,"id").longValue(),accountId,"EXPIRED","server",Map.of());

        // 3) Decide whether this terminal may receive commands at all.
        String halt=null;
        String linkedLogin=(String)acct.get("account_login"),linkedServer=(String)acct.get("account_server");
        if(linkedLogin==null||linkedLogin.isBlank())halt="Account login not set in Broker tab";
        else if(!linkedLogin.equals(login))halt="Terminal login does not match the linked account";
        else if(linkedServer!=null&&!linkedServer.isBlank()&&!linkedServer.equalsIgnoreCase(server))halt="Terminal server does not match the linked account";
        else if(!Set.of("demo","real","contest").contains(mode))halt="Terminal did not report its account type";
        else if("real".equals(mode)&&!liveAllowed(acct))halt="Real-money account refused: live trading not confirmed";
        StringBuilder out=new StringBuilder();
        var queued=jdbc.queryForList("""
            SELECT o.*,p.broker_ticket AS parent_ticket FROM broker_orders o LEFT JOIN broker_orders p ON p.id=o.parent_id
            WHERE o.account_id=? AND o.state='QUEUED' ORDER BY o.id LIMIT 5 FOR UPDATE OF o SKIP LOCKED
            """,accountId);
        boolean execute="EXECUTE".equals(acct.get("mode"))&&bool(acct,"enabled");
        int openNow=ours;
        for(var o:queued) {
            long oid=num(o,"id").longValue();String action=(String)o.get("action");
            boolean ping="PING".equals(action);
            if(halt!=null&&!ping)continue;
            if(!ping&&!execute)continue;
            if("OPEN".equals(action)) {
                String reason=gate(acct,floating,openNow);
                if(reason!=null){setState(oid,"BLOCKED",reason);event(oid,accountId,"BLOCKED","server",Map.of("reason",reason));continue;}
                openNow++;
            }
            if(Set.of("CLOSE","MODIFY").contains(action)&&o.get("parent_ticket")==null){
                setState(oid,"CANCELLED","Parent has no broker ticket");event(oid,accountId,"CANCELLED","server",Map.of());continue;
            }
            jdbc.update("UPDATE broker_orders SET state='DISPATCHED',dispatched_at=now(),account_mode=?,updated_at=now() WHERE id=?",mode,oid);
            event(oid,accountId,"DISPATCHED","server",Map.of("accountMode",mode,"login",login));
            out.append(String.join("|","CMD",String.valueOf(oid),(String)o.get("client_order_id"),action,
                s(o.get("broker_symbol")),s(o.get("side")),s(o.get("volume")),s(o.get("stop_loss")),s(o.get("take_profit")),
                s(o.get("entry_ref")),s(acct.get("max_slippage_pct")),s(o.get("parent_ticket")),"END")).append('\n');
        }
        String head=halt!=null?"HALT|"+halt:!execute?"IDLE|"+(bool(acct,"enabled")?"Dry-run mode":"Mirroring disabled")
            :bool(acct,"kill_switch")?"OK|Kill switch ON: no new entries":"OK|Ready";
        return head+"|"+System.currentTimeMillis()+"\n"+out;
    }

    public String report(String token,Map<String,String> p) {
        return tx.execute(s->{
            Map<String,Object> acct=accountByToken(token);
            long accountId=num(acct,"id").longValue();
            String clientId=clip(p.get("clientId"),40),status=clip(p.get("status"),12).toUpperCase(Locale.ROOT);
            var rows=jdbc.queryForList("SELECT * FROM broker_orders WHERE account_id=? AND client_order_id=? FOR UPDATE",accountId,clientId);
            if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Unknown order");
            var o=rows.getFirst();long oid=num(o,"id").longValue();String action=(String)o.get("action"),state=(String)o.get("state");
            var raw=new LinkedHashMap<String,Object>();
            for(String k:List.of("status","ticket","price","volume","retcode","message","time","login","balance","equity"))
                if(p.containsKey(k))raw.put(k,clip(p.get(k),200));
            event(oid,accountId,"BROKER_REPORT","connector",raw);
            if(!Set.of("DISPATCHED","UNKNOWN").contains(state))return "OK|ignored "+state+"\n";
            String retcode=clip(p.get("retcode"),20),message=clip(p.get("message"),500);
            if("OPEN".equals(action)&&"FILLED".equals(status)) {
                jdbc.update("""
                    UPDATE broker_orders SET state='FILLED',broker_ticket=?,fill_price=?,fill_volume=?,fill_time=COALESCE(to_timestamp(?::bigint),now()),
                        broker_retcode=?,broker_message=?,state_reason='Broker confirmed fill',updated_at=now() WHERE id=?
                    """,clip(p.get("ticket"),40),decOrNull(p.get("price")),decOrNull(p.get("volume")),longOrNull(p.get("time")),retcode,message,oid);
            } else if("REJECTED".equals(status)) {
                jdbc.update("UPDATE broker_orders SET state='REJECTED',broker_retcode=?,broker_message=?,state_reason='Broker or EA rejected',updated_at=now() WHERE id=?",retcode,message,oid);
            } else if("DONE".equals(status)&&!"OPEN".equals(action)) {
                jdbc.update("UPDATE broker_orders SET state='DONE',broker_retcode=?,broker_message=?,state_reason='Confirmed by terminal',updated_at=now() WHERE id=?",retcode,message,oid);
                if("MODIFY".equals(action))jdbc.update("UPDATE broker_orders SET stop_loss=?,updated_at=now() WHERE id=?",o.get("stop_loss"),o.get("parent_id"));
            } else throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Invalid status for "+action);
            return "OK\n";
        });
    }

    private Map<String,Object> accountByToken(String token) {
        if(token==null||token.length()<20||token.length()>200)throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        var rows=jdbc.queryForList("SELECT * FROM broker_accounts WHERE connector_token_hash=? FOR UPDATE",sha256(token));
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return rows.getFirst();
    }

    // ───────────────────────── admin operations ─────────────────────────

    public Map<String,Object> view(String owner) {
        var out=new LinkedHashMap<String,Object>();
        out.put("liveEnabledByServer",liveEnabledByEnv);
        var rows=jdbc.queryForList("""
            SELECT id,broker,platform,account_login,account_server,mode,enabled,kill_switch,mirror_auto,mirror_manual,max_lot,max_daily_loss_usd,
                   max_open_positions,max_orders_per_day,max_signal_age_seconds,max_slippage_pct,allowed_symbols,symbol_map::text AS symbol_map,
                   live_confirmed_by,live_confirmed_at,connector_token_hash IS NOT NULL AS token_set,connector_token_created_at,
                   connector_last_seen,connector_info::text AS connector_info,
                   connector_last_seen>now()-interval '30 seconds' AS connector_online,updated_at
            FROM broker_accounts WHERE owner_username=?""",owner);
        if(rows.isEmpty()){out.put("account",null);return out;}
        var a=rows.getFirst();long id=num(a,"id").longValue();
        out.put("account",a);
        out.put("liveAllowed",liveEnabledByEnv&&a.get("live_confirmed_at")!=null);
        out.put("todayClosedUsd",jdbc.queryForObject("SELECT COALESCE(SUM(profit_usd),0) FROM broker_orders WHERE account_id=? AND action='OPEN' AND closed_at>="+IST_TODAY,BigDecimal.class,id));
        out.put("ordersToday",jdbc.queryForObject("SELECT count(*) FROM broker_orders WHERE account_id=? AND action='OPEN' AND created_at>="+IST_TODAY,Integer.class,id));
        var counts=new LinkedHashMap<String,Object>();
        jdbc.query("SELECT state,count(*) FROM broker_orders WHERE account_id=? AND action='OPEN' GROUP BY state",rs->{counts.put(rs.getString(1),rs.getLong(2));},id);
        out.put("stateCounts",counts);
        return out;
    }

    public Map<String,Object> save(String owner,JsonNode b) {
        return tx.execute(s->{
            jdbc.update("INSERT INTO broker_accounts(owner_username) VALUES(?) ON CONFLICT(owner_username) DO NOTHING",owner);
            var acct=jdbc.queryForList("SELECT * FROM broker_accounts WHERE owner_username=? FOR UPDATE",owner).getFirst();
            long id=num(acct,"id").longValue();
            String login=b.has("accountLogin")?b.path("accountLogin").asText("").trim():(String)acct.get("account_login");
            String server=b.has("accountServer")?b.path("accountServer").asText("").trim():(String)acct.get("account_server");
            if(login!=null&&!login.isEmpty()&&!login.matches("\\d{4,20}"))throw bad("Account login must be the numeric MT5 login");
            if(server!=null&&!server.isEmpty()&&!server.matches("[A-Za-z0-9._ -]{3,80}"))throw bad("Invalid server name");
            String mode=b.has("mode")?b.path("mode").asText():(String)acct.get("mode");
            if(!Set.of("DRY_RUN","EXECUTE").contains(mode))throw bad("Mode must be DRY_RUN or EXECUTE");
            if("EXECUTE".equals(mode)&&(login==null||login.isEmpty()||acct.get("connector_token_hash")==null))
                throw bad("Set the account login and generate a connector token before EXECUTE");
            BigDecimal maxLot=b.has("maxLot")?new BigDecimal(b.path("maxLot").asText()).setScale(2,RoundingMode.DOWN):(BigDecimal)acct.get("max_lot");
            if(maxLot.compareTo(new BigDecimal("0.01"))<0||maxLot.compareTo(BigDecimal.ONE)>0)throw bad("Max lot must be between 0.01 and 1.00");
            BigDecimal maxLoss=b.has("maxDailyLossUsd")?new BigDecimal(b.path("maxDailyLossUsd").asText()):(BigDecimal)acct.get("max_daily_loss_usd");
            if(maxLoss.signum()<=0||maxLoss.compareTo(new BigDecimal("100000"))>0)throw bad("Daily loss limit must be positive");
            int maxOpen=b.has("maxOpenPositions")?b.path("maxOpenPositions").asInt():num(acct,"max_open_positions").intValue();
            int maxDay=b.has("maxOrdersPerDay")?b.path("maxOrdersPerDay").asInt():num(acct,"max_orders_per_day").intValue();
            int maxAge=b.has("maxSignalAgeSeconds")?b.path("maxSignalAgeSeconds").asInt():num(acct,"max_signal_age_seconds").intValue();
            BigDecimal slip=b.has("maxSlippagePct")?new BigDecimal(b.path("maxSlippagePct").asText()):(BigDecimal)acct.get("max_slippage_pct");
            if(maxOpen<1||maxOpen>20||maxDay<1||maxDay>200||maxAge<10||maxAge>3600||slip.signum()<=0||slip.compareTo(new BigDecimal("5"))>0)
                throw bad("A limit is out of range");
            String symbols=b.has("allowedSymbols")?b.path("allowedSymbols").asText():(String)acct.get("allowed_symbols");
            List<String> symList=new ArrayList<>();
            for(String x:symbols.split(","))if(!x.isBlank()){String t=x.trim().toUpperCase(Locale.ROOT);if(!SYMBOLS.contains(t))throw bad("Unsupported symbol "+t);symList.add(t);}
            String symbolMap=acct.get("symbol_map").toString();
            if(b.has("symbolMap")) {
                if(!b.path("symbolMap").isObject())throw bad("Symbol map must be an object");
                b.path("symbolMap").fields().forEachRemaining(e->{if(!SYMBOLS.contains(e.getKey())||!e.getValue().asText().matches("[A-Za-z0-9._#-]{1,40}"))throw bad("Invalid symbol map entry");});
                symbolMap=b.path("symbolMap").toString();
            }
            boolean identityChanged=!Objects.equals(login,acct.get("account_login"))||!Objects.equals(server,acct.get("account_server"));
            jdbc.update("""
                UPDATE broker_accounts SET account_login=?,account_server=?,mode=?,enabled=?,mirror_auto=?,mirror_manual=?,max_lot=?,max_daily_loss_usd=?,
                  max_open_positions=?,max_orders_per_day=?,max_signal_age_seconds=?,max_slippage_pct=?,allowed_symbols=?,symbol_map=?::jsonb,
                  live_confirmed_by=CASE WHEN ? THEN NULL ELSE live_confirmed_by END,live_confirmed_at=CASE WHEN ? THEN NULL ELSE live_confirmed_at END,
                  updated_at=now() WHERE id=?""",
                emptyToNull(login),emptyToNull(server),mode,b.has("enabled")?b.path("enabled").asBoolean():bool(acct,"enabled"),
                b.has("mirrorAuto")?b.path("mirrorAuto").asBoolean():bool(acct,"mirror_auto"),
                b.has("mirrorManual")?b.path("mirrorManual").asBoolean():bool(acct,"mirror_manual"),
                maxLot,maxLoss,maxOpen,maxDay,maxAge,slip,String.join(",",symList),symbolMap,identityChanged,identityChanged,id);
            var d=new LinkedHashMap<String,Object>();d.put("mode",mode);d.put("maxLot",maxLot);d.put("maxDailyLossUsd",maxLoss);
            d.put("maxOpenPositions",maxOpen);d.put("maxOrdersPerDay",maxDay);d.put("allowedSymbols",symList);
            d.put("accountLogin",emptyToNull(login));d.put("accountServer",emptyToNull(server));if(identityChanged)d.put("liveConfirmationCleared",true);
            event(null,id,"SETTINGS_CHANGED",owner,d);
            return view(owner);
        });
    }

    public String rotateToken(String owner) {
        String token="rlc_"+Base64.getUrlEncoder().withoutPadding().encodeToString(bytes(32));
        tx.executeWithoutResult(s->{
            jdbc.update("INSERT INTO broker_accounts(owner_username) VALUES(?) ON CONFLICT(owner_username) DO NOTHING",owner);
            jdbc.update("UPDATE broker_accounts SET connector_token_hash=?,connector_token_created_at=now(),updated_at=now() WHERE owner_username=?",sha256(token),owner);
            event(null,accountId(owner),"CONNECTOR_TOKEN_ROTATED",owner,Map.of());
        });
        return token;
    }

    public Map<String,Object> killSwitch(String owner,boolean on) {
        return tx.execute(s->{
            long id=accountId(owner);
            jdbc.update("UPDATE broker_accounts SET kill_switch=?,updated_at=now() WHERE id=?",on,id);
            int blocked=on?jdbc.update("UPDATE broker_orders SET state='BLOCKED',state_reason='Kill switch is ON',updated_at=now() WHERE account_id=? AND action='OPEN' AND state='QUEUED'",id):0;
            event(null,id,on?"KILL_SWITCH_ON":"KILL_SWITCH_OFF",owner,Map.of("blockedQueued",blocked));
            return view(owner);
        });
    }

    public Map<String,Object> confirmLive(String owner,String typedLogin,boolean confirm) {
        return tx.execute(s->{
            var acct=jdbc.queryForList("SELECT * FROM broker_accounts WHERE owner_username=? FOR UPDATE",owner);
            if(acct.isEmpty())throw bad("Link an account first");
            long id=num(acct.getFirst(),"id").longValue();
            if(confirm) {
                if(!liveEnabledByEnv)throw bad("Live trading is disabled on the server (RIYAN_BROKER_LIVE_ENABLED is not true)");
                String login=(String)acct.getFirst().get("account_login");
                if(login==null||!login.equals(typedLogin==null?"":typedLogin.trim()))throw bad("Typed login does not match the linked account");
                jdbc.update("UPDATE broker_accounts SET live_confirmed_by=?,live_confirmed_at=now(),updated_at=now() WHERE id=?",owner,id);
            } else jdbc.update("UPDATE broker_accounts SET live_confirmed_by=NULL,live_confirmed_at=NULL,updated_at=now() WHERE id=?",id);
            event(null,id,confirm?"LIVE_CONFIRMED":"LIVE_REVOKED",owner,Map.of());
            return view(owner);
        });
    }

    public Map<String,Object> ping(String owner) {
        return tx.execute(s->{
            long id=accountId(owner);
            long oid=jdbc.queryForObject("SELECT nextval(pg_get_serial_sequence('broker_orders','id'))",Long.class);
            jdbc.update("INSERT INTO broker_orders(id,account_id,client_order_id,action,state,state_reason) VALUES(?,?,?,'PING','QUEUED','Link test requested')",oid,id,"RL-"+oid);
            event(oid,id,"PING_QUEUED",owner,Map.of());
            return Map.of("clientOrderId","RL-"+oid);
        });
    }

    public List<Map<String,Object>> orders(String owner,int limit) {
        return jdbc.queryForList("""
            SELECT o.id,o.client_order_id,o.parent_id,o.action,o.signal_type,o.signal_source_id,o.symbol,o.broker_symbol,o.side,o.volume,
                   o.entry_ref,o.stop_loss,o.take_profit,o.state,o.state_reason,o.broker_ticket,o.fill_price,o.fill_time,o.broker_retcode,
                   o.broker_message,o.close_price,o.profit_usd,o.closed_at,o.account_mode,o.dispatched_at,o.created_at,o.updated_at
            FROM broker_orders o JOIN broker_accounts a ON a.id=o.account_id WHERE a.owner_username=?
            ORDER BY o.id DESC LIMIT ?""",owner,Math.max(1,Math.min(limit,500)));
    }

    public List<Map<String,Object>> events(String owner,Long orderId,int limit) {
        if(orderId!=null)return jdbc.queryForList("""
            SELECT e.id,e.order_id,e.event,e.actor,e.details::text AS details,e.created_at FROM broker_order_events e
            JOIN broker_accounts a ON a.id=e.account_id WHERE a.owner_username=? AND e.order_id=? ORDER BY e.id""",owner,orderId);
        return jdbc.queryForList("""
            SELECT e.id,e.order_id,e.event,e.actor,e.details::text AS details,e.created_at FROM broker_order_events e
            JOIN broker_accounts a ON a.id=e.account_id WHERE a.owner_username=? ORDER BY e.id DESC LIMIT ?""",owner,Math.max(1,Math.min(limit,500)));
    }

    // ───────────────────────── helpers ─────────────────────────

    boolean liveAllowed(Map<String,Object> acct){return liveEnabledByEnv&&acct.get("live_confirmed_at")!=null;}
    private long accountId(String owner){
        var ids=jdbc.queryForList("SELECT id FROM broker_accounts WHERE owner_username=?",Long.class,owner);
        if(ids.isEmpty())throw bad("Link an account first");
        return ids.getFirst();
    }
    private long orderIdByClient(long accountId,String clientId){
        return jdbc.queryForObject("SELECT id FROM broker_orders WHERE account_id=? AND client_order_id=?",Long.class,accountId,clientId);
    }
    private void setState(long id,String state,String reason){
        jdbc.update("UPDATE broker_orders SET state=?,state_reason=?,updated_at=now() WHERE id=?",state,reason,id);
    }
    private void event(Long orderId,long accountId,String event,String actor,Map<String,?> details){
        try{jdbc.update("INSERT INTO broker_order_events(order_id,account_id,event,actor,details) VALUES(?,?,?,?,?::jsonb)",
            orderId,accountId,event,actor,json.writeValueAsString(details));}
        catch(com.fasterxml.jackson.core.JsonProcessingException e){throw new IllegalStateException(e);}
    }
    private Set<String> allowedSymbols(Map<String,Object> acct){
        Set<String> out=new HashSet<>();for(String x:((String)acct.get("allowed_symbols")).split(","))if(!x.isBlank())out.add(x.trim());return out;
    }
    private String mapSymbol(Map<String,Object> acct,String sym){
        String mapped=parse(acct.get("symbol_map").toString()).path(sym).asText("");
        return mapped.isEmpty()?sym:mapped;
    }
    static String signalStatus(JsonNode n){
        String v=n.hasNonNull("outcome")?n.path("outcome").asText():n.path("status").asText("OPEN");
        return v.toUpperCase(Locale.ROOT);
    }
    private JsonNode parse(String raw){try{return json.readTree(raw);}catch(Exception e){throw new IllegalArgumentException("Invalid JSON");}}
    private static BigDecimal decimal(JsonNode n,String... keys){
        for(String k:keys){JsonNode v=n.path(k);if(v.isNumber()||v.isTextual()){try{BigDecimal d=new BigDecimal(v.asText());if(d.signum()>0)return d;}catch(NumberFormatException ignored){}}}
        return null;
    }
    private static List<String[]> rows(String raw,int fields){
        List<String[]> out=new ArrayList<>();if(raw==null||raw.isBlank())return out;
        for(String row:raw.split(";")){if(out.size()>=200)break;String[] f=row.split("\\|",-1);if(f.length>=fields)out.add(f);}
        return out;
    }
    private static BigDecimal dec(String v){BigDecimal d=decOrNull(v);return d==null?BigDecimal.ZERO:d;}
    private static BigDecimal decOrNull(String v){if(v==null||v.isBlank())return null;try{return new BigDecimal(v.trim());}catch(NumberFormatException e){return null;}}
    private static Long longOrNull(String v){if(v==null||v.isBlank())return null;try{return Long.parseLong(v.trim());}catch(NumberFormatException e){return null;}}
    private static String clip(String v,int max){if(v==null)return "";v=v.replaceAll("[\\r\\n|;]"," ").trim();return v.length()>max?v.substring(0,max):v;}
    private static String s(Object o){if(o==null)return "";if(o instanceof BigDecimal d)return d.stripTrailingZeros().toPlainString();return o.toString();}
    private static String emptyToNull(String v){return v==null||v.isBlank()?null:v;}
    private static boolean bool(Map<String,Object> m,String k){return Boolean.TRUE.equals(m.get(k));}
    private static Number num(Map<String,Object> m,String k){return (Number)m.get(k);}
    private static ResponseStatusException bad(String m){return new ResponseStatusException(HttpStatus.BAD_REQUEST,m);}
    private byte[] bytes(int n){byte[] b=new byte[n];random.nextBytes(b);return b;}
    static String sha256(String v){
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(v.getBytes(StandardCharsets.UTF_8)));}
        catch(Exception e){throw new IllegalStateException(e);}
    }
}
