package com.riyanlab;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

@RestController
@RequestMapping("/api/v1/market")
public class MarketDataController {
    private final AuthService auth;
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4))
        .followRedirects(HttpClient.Redirect.NEVER).build();
    private record Cached(String body,int status,long until) {}
    private final Map<String,Cached> cache=new ConcurrentHashMap<>();
    private final Semaphore permits=new Semaphore(6);
    public MarketDataController(AuthService auth){this.auth=auth;}
    // Fixed public instruments and paths only: this is not a general-purpose proxy.
    static URI allowed(String raw) {
        try {
            URI u=URI.create(raw.replace("[","%5B").replace("]","%5D").replace("\"","%22"));
            if(!"https".equals(u.getScheme())||u.getPort()!=-1||u.getUserInfo()!=null||u.getFragment()!=null)throw new IllegalArgumentException();
            if("api.gold-api.com".equals(u.getHost())&&Set.of("/price/XAU","/price/XAG").contains(u.getPath())&&u.getQuery()==null)return u;
            if("query1.finance.yahoo.com".equals(u.getHost())){
                // Delayed futures reference history, never a broker/execution price feed.
                if(!Set.of("GC=F","SI=F","PL=F","PA=F","6E=F","6B=F","6J=F","6A=F","6C=F","6S=F","6N=F")
                    .stream().anyMatch(symbol->u.getPath().equals("/v8/finance/chart/"+symbol)))throw new IllegalArgumentException();
                Map<String,String> q=new HashMap<>();
                for(String item:u.getQuery().split("&")){
                    String[] kv=item.split("=",-1);
                    if(kv.length!=2||q.put(kv[0],kv[1])!=null)throw new IllegalArgumentException();
                }
                if(!q.keySet().equals(Set.of("interval","range")))throw new IllegalArgumentException();
                String range=Map.of("1m","5d","5m","1mo","15m","1mo","30m","1mo","60m","1y","1d","5y").get(q.get("interval"));
                if(range==null||!range.equals(q.get("range")))throw new IllegalArgumentException();
                return u;
            }
            if("api.exchange.coinbase.com".equals(u.getHost())){
                if(Set.of("/products/BTC-USD/ticker","/products/BTC-USD/stats").contains(u.getPath())&&u.getQuery()==null)return u;
                if(!"/products/BTC-USD/candles".equals(u.getPath())||u.getQuery()==null)throw new IllegalArgumentException();
                Map<String,String> q=new HashMap<>();
                for(String item:u.getQuery().split("&")){
                    String[] kv=item.split("=",-1);
                    if(kv.length!=2||q.put(kv[0],kv[1])!=null)throw new IllegalArgumentException();
                }
                if(!q.keySet().equals(Set.of("granularity","start","end")))throw new IllegalArgumentException();
                int seconds=Integer.parseInt(q.get("granularity"));
                if(!Set.of(60,300,900,3600,21600,86400).contains(seconds))throw new IllegalArgumentException();
                long start=java.time.Instant.parse(q.get("start")).toEpochMilli(),end=java.time.Instant.parse(q.get("end")).toEpochMilli();
                if(start<0||end<start||end-start>=300L*seconds*1000||end>System.currentTimeMillis()+60000)throw new IllegalArgumentException();
                return u;
            }
            boolean spot="api.binance.com".equals(u.getHost()),future="fapi.binance.com".equals(u.getHost());
            if(!spot&&!future)throw new IllegalArgumentException();
            if(spot&&"/api/v3/ticker/24hr".equals(u.getPath())&&"symbols=[\"BTCUSDT\"]".equals(u.getQuery()))return u;
            if(!(spot?"/api/v3/klines":"/fapi/v1/klines").equals(u.getPath()))throw new IllegalArgumentException();
            Map<String,String> q=new HashMap<>();
            for(String item:u.getQuery().split("&")){
                String[] kv=item.split("=",-1);
                if(kv.length!=2||q.put(kv[0],kv[1])!=null)throw new IllegalArgumentException();
            }
            if(!Set.of("symbol","interval","limit","endTime").containsAll(q.keySet())||
               !(spot?Set.of("BTCUSDT","PAXGUSDT"):Set.of("XAUUSDT","XAGUSDT")).contains(q.get("symbol"))||
               !Set.of("1m","5m","15m","30m","1h","4h","1d","1w","1M").contains(q.get("interval")))throw new IllegalArgumentException();
            int limit=Integer.parseInt(q.get("limit"));
            if(limit<1||limit>(spot?1000:1500))throw new IllegalArgumentException();
            if(q.containsKey("endTime")){
                long end=Long.parseLong(q.get("endTime"));
                if(end<0||end>System.currentTimeMillis()+60000)throw new IllegalArgumentException();
            }
            return u;
        }catch(RuntimeException e){throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Unsupported public market request");}
    }
    @GetMapping("/data")
    ResponseEntity<String> data(@RequestParam String url,HttpServletRequest request) {
        auth.require(request,false);
        URI uri=allowed(url);long now=System.currentTimeMillis();
        Cached saved=cache.get(uri.toString());
        if(saved!=null&&saved.until>now)return response(saved);
        if(!permits.tryAcquire())throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Market feed busy");
        try{
            var upstream=client.send(java.net.http.HttpRequest.newBuilder(uri).header("User-Agent","RiyanLab/1.0 public-market-data").timeout(Duration.ofSeconds(8)).GET().build(),HttpResponse.BodyHandlers.ofString());
            int status=upstream.statusCode();
            // Preserve bans/rate limits as unavailable. Never switch hosts to bypass them.
            long ttl=status==200?(uri.getPath().contains("/chart/")?60000:(uri.getPath().contains("klines")||uri.getPath().endsWith("/candles"))?30000:uri.getPath().endsWith("/stats")?60000:3000):60000;
            String body=status==200?upstream.body():"{\"error\":\"Market provider unavailable\",\"upstreamStatus\":"+status+"}";
            if(body.length()>2_000_000)throw new IllegalStateException("Oversized market response");
            Cached result=new Cached(body,status==200?200:503,now+ttl);
            if(cache.size()>256)cache.clear();cache.put(uri.toString(),result);
            return response(result);
        }catch(InterruptedException e){Thread.currentThread().interrupt();throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Market request interrupted");}
        catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Market feed timed out or unavailable");}
        finally{permits.release();}
    }
    private ResponseEntity<String> response(Cached value){
        return ResponseEntity.status(value.status).cacheControl(CacheControl.noStore())
            .contentType(MediaType.APPLICATION_JSON).body(value.body);
    }
}
