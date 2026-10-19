package com.riyanlab;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;

/** Real exchange candles, shared by the browser and background paper engines. */
@RestController
@RequestMapping("/api/v1/market")
public class MetalHistory {
    private final AuthService auth;
    private final MarketDataController market;
    private final ObjectMapper json;
    private static final Map<String,String> FRAMES=Map.of("1m","1m","5m","5m","15m","15m","30m","30m","1h","1H","4h","4H","1d","1Dutc");
    private static final Map<String,Long> MILLIS=Map.of("1m",60000L,"5m",300000L,"15m",900000L,"30m",1800000L,"1h",3600000L,"4h",14400000L,"1d",86400000L);
    public MetalHistory(AuthService auth,MarketDataController market,ObjectMapper json){this.auth=auth;this.market=market;this.json=json;}
    @GetMapping("/metals")
    public ArrayNode data(@RequestParam String symbol,@RequestParam String interval,
            @RequestParam(defaultValue="700") int limit,HttpServletRequest req){
        auth.require(req,false);
        return candles(symbol,interval,limit);
    }
    public ArrayNode candles(String symbol,String interval,int limit){
        if(!Set.of("XAUUSD","XAGUSD").contains(symbol)||!FRAMES.containsKey(interval)||limit<1||limit>1500)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Unsupported metal candle request");
        String instrument=(symbol.equals("XAUUSD")?"XAU":"XAG")+"-USDT-SWAP";
        ArrayNode raw=json.createArrayNode();long cursor=Long.MAX_VALUE;
        // Up to 1,440 recent exchange bars. Never synthesize gaps or forming bars.
        for(int page=0;page<5&&raw.size()<limit+1;page++){
            String url="https://www.okx.com/api/v5/market/candles?instId="+instrument+"&bar="+FRAMES.get(interval)+"&limit=300"+(page==0?"":"&after="+cursor);
            var response=market.publicData(url);
            if(!response.getStatusCode().is2xxSuccessful())throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"OKX metal candles unavailable: "+response.getBody());
            try{
                JsonNode value=json.readTree(response.getBody());
                if(!value.path("code").asText().equals("0")||!value.path("data").isArray())throw new IllegalArgumentException("Provider rejected candles");
                JsonNode rows=value.path("data");if(rows.isEmpty())break;
                long oldest=Long.MAX_VALUE;
                for(JsonNode row:rows){if(!row.isArray()||row.size()!=9)throw new IllegalArgumentException("Malformed candle");oldest=Math.min(oldest,Long.parseLong(row.get(0).asText()));raw.add(row);}
                if(oldest>=cursor)throw new IllegalArgumentException("History pagination did not advance");
                cursor=oldest;if(rows.size()<300)break;
            }catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Invalid OKX metal history",e);}
        }
        try{
            ArrayNode all=normalize(raw,MILLIS.get(interval),System.currentTimeMillis(),instrument,json),out=json.createArrayNode();
            for(int i=Math.max(0,all.size()-limit);i<all.size();i++)out.add(all.get(i));
            if(out.isEmpty())throw new IllegalArgumentException("No completed candles");
            return out;
        }catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Invalid completed metal candles",e);}
    }
    static ArrayNode normalize(JsonNode rows,long ms,long now,String source,ObjectMapper json){
        var sorted=new TreeMap<Long,ObjectNode>();
        for(JsonNode r:rows){
            if(!r.isArray()||r.size()!=9||!Set.of("0","1").contains(r.get(8).asText()))throw new IllegalArgumentException("Malformed candle");
            long t=Long.parseLong(r.get(0).asText());
            double o=Double.parseDouble(r.get(1).asText()),h=Double.parseDouble(r.get(2).asText()),l=Double.parseDouble(r.get(3).asText()),c=Double.parseDouble(r.get(4).asText()),v=Double.parseDouble(r.get(6).asText());
            if(t<=0||t%ms!=0||t>now+5000||!Double.isFinite(o)||!Double.isFinite(h)||!Double.isFinite(l)||!Double.isFinite(c)||!Double.isFinite(v)||l<=0||o<l||o>h||c<l||c>h||v<0)throw new IllegalArgumentException("Invalid OHLCV");
            if(!r.get(8).asText().equals("1")||t+ms>now)continue;
            ObjectNode k=json.createObjectNode().put("t",t).put("ms",ms).put("o",o).put("h",h).put("l",l).put("c",c).put("v",v).put("complete",true).put("source","OKX "+source).put("volumeType","metal units");
            ObjectNode previous=sorted.put(t,k);
            if(previous!=null&&!previous.equals(k))throw new IllegalArgumentException("Conflicting duplicate candles");
        }
        ArrayNode out=json.createArrayNode();sorted.values().forEach(out::add);return out;
    }
}
