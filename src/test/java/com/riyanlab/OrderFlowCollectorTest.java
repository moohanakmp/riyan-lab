package com.riyanlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class OrderFlowCollectorTest {
    static final long M=60_000L,T0=Instant.parse("2026-11-24T07:00:00Z").toEpochMilli();
    final ObjectMapper json=new ObjectMapper();

    /** Fake exchange history: trade ids 1..n, newest first, paged below the requested id. */
    static String okxHistory(List<long[]> trades,String url){
        long after=Long.parseLong(url.replaceAll(".*after=(\\d+).*","$1"));
        var page=trades.stream().filter(t->t[0]<after).sorted((a,b)->Long.compare(b[0],a[0])).limit(100).toList();
        var sb=new StringBuilder("{\"code\":\"0\",\"data\":[");
        for(int i=0;i<page.size();i++){long[] t=page.get(i);if(i>0)sb.append(',');
            sb.append("{\"instId\":\"XAU-USDT-SWAP\",\"tradeId\":\"").append(t[0]).append("\",\"ts\":\"").append(t[1]).append("\",\"px\":\"").append(t[2]/100.0).append("\",\"sz\":\"").append(t[3]).append("\",\"side\":\"").append(t[4]==1?"buy":"sell").append("\"}");}
        return sb.append("]}").toString();
    }

    @Test void streamBuildsFootprintWithTakerSide()throws Exception{
        var c=new OrderFlowCollector(null,json,url->{throw new IllegalStateException("offline");});c.clock=()->T0+M;
        c.onOkx("{\"event\":\"subscribe\",\"arg\":{\"channel\":\"trades\",\"instId\":\"XAU-USDT-SWAP\"}}");
        c.onOkx("{\"arg\":{\"channel\":\"trades\",\"instId\":\"XAU-USDT-SWAP\"},\"data\":[{\"tradeId\":\"10\",\"px\":\"4000.12\",\"sz\":\"3\",\"side\":\"buy\",\"ts\":\""+(T0+1000)+"\"},{\"tradeId\":\"11\",\"px\":\"4000.10\",\"sz\":\"2\",\"side\":\"sell\",\"ts\":\""+(T0+2000)+"\"}]}");
        c.onOkx("{\"arg\":{\"channel\":\"trades\",\"instId\":\"XAU-USDT-SWAP\"},\"data\":[{\"tradeId\":\"12\",\"px\":\"4001\",\"sz\":\"5\",\"side\":\"buy\",\"ts\":\""+(T0+M+500)+"\"}]}");
        var view=c.view("XAUUSD","",0,T0+M+30_000);
        @SuppressWarnings("unchecked") var rows=(List<Map<String,Object>>)view.get("minutes");
        assertEquals(2,rows.size());
        var first=rows.get(0);
        assertEquals(4000.12,first.get("o"));assertEquals(4000.10,first.get("c"));
        assertEquals(3.0,first.get("buy"));assertEquals(2.0,first.get("sell"));assertEquals(true,first.get("final"));
        assertEquals(true,first.get("partial"),"first minute after connecting missed earlier trades until history fills it");
        assertEquals(false,rows.get(1).get("partial"),"later minutes are fully streamed");
        assertEquals(false,rows.get(1).get("final"),"forming minute");
        // Coinbase maker sell = taker buy.
        c.onCoinbase("{\"type\":\"subscriptions\"}");
        c.onCoinbase("{\"type\":\"match\",\"product_id\":\"BTC-USD\",\"trade_id\":5,\"price\":\"90000.4\",\"size\":\"0.5\",\"side\":\"sell\",\"time\":\""+Instant.ofEpochMilli(T0+M+1000)+"\"}");
        @SuppressWarnings("unchecked") var btc=(List<Map<String,Object>>)c.view("BTCUSD","",0,T0+M+30_000).get("minutes");
        assertEquals(0.5,btc.get(0).get("buy"));
        // Only changed minutes are sent once the browser has this boot id.
        long rev=((Number)view.get("rev")).longValue();
        c.onOkx("{\"arg\":{\"channel\":\"trades\",\"instId\":\"XAU-USDT-SWAP\"},\"data\":[{\"tradeId\":\"13\",\"px\":\"4001.5\",\"sz\":\"1\",\"side\":\"sell\",\"ts\":\""+(T0+M+900)+"\"}]}");
        @SuppressWarnings("unchecked") var delta=(List<Map<String,Object>>)c.view("XAUUSD",c.boot,rev,T0+M+30_000).get("minutes");
        assertEquals(1,delta.size());assertEquals(T0+M,delta.get(0).get("t"));
    }

    @Test void gapFillRebuildsMissedMinutesWithoutCountingTwice(){
        // Exchange history: one trade every 10 s for 10 minutes, ids 1..60.
        var history=new ArrayList<long[]>();
        for(int i=0;i<60;i++)history.add(new long[]{i+1,T0+i*10_000L+1,400000+i,1,i%2});
        var c=new OrderFlowCollector(null,json,url->okxHistory(history,url));c.pageDelayMs=0;c.clock=()->T0+10*M;
        var b=c.books.get("XAUUSD");
        long now=T0+10*M;
        // Streamed minutes 0-2, then the stream dropped (service asleep), reconnected in minute 7.
        synchronized(b){c.connected(b,T0-5000);}
        for(long[] t:history)if(t[0]<=18)c.onTrade(b,t[0],t[0],t[1],t[2]/100.0,t[3],t[4]==1);
        synchronized(b){c.disconnected(b,T0+3*M+5);}
        synchronized(b){c.connected(b,T0+7*M+30_000);}
        for(long[] t:history)if(t[0]>=46)c.onTrade(b,t[0],t[0],t[1],t[2]/100.0,t[3],t[4]==1);
        var before=c.view("XAUUSD","",0,now);
        @SuppressWarnings("unchecked") var gap=(List<Map<String,Object>>)before.get("minutes");
        assertTrue(gap.stream().noneMatch(r->((Number)r.get("t")).longValue()==T0+5*M),"minute 5 missing before fill");
        assertEquals(true,gap.stream().filter(r->((Number)r.get("t")).longValue()==T0+7*M).findFirst().orElseThrow().get("partial"));
        c.backfill(b);
        @SuppressWarnings("unchecked") var rows=(List<Map<String,Object>>)c.view("XAUUSD","",0,now).get("minutes");
        assertEquals(10,rows.size(),"every minute present");
        for(var r:rows){
            assertEquals(false,r.get("partial"),"minute "+r.get("t"));
            assertEquals(6,((Number)r.get("n")).intValue(),"six trades per minute, none doubled: "+r.get("t"));
            assertEquals(6.0,(double)r.get("buy")+(double)r.get("sell"),1e-9);
        }
        var m7=rows.stream().filter(r->((Number)r.get("t")).longValue()==T0+7*M).findFirst().orElseThrow();
        assertEquals(400042/100.0,m7.get("o"));assertEquals(400047/100.0,m7.get("c"));
    }

    @Test void failedHistoryKeepsMinutesPartialAndRetries(){
        var c=new OrderFlowCollector(null,json,url->{throw new IllegalStateException("HTTP 429");});c.clock=()->T0+M;
        var b=c.books.get("XAUUSD");
        synchronized(b){c.connected(b,T0);}
        c.onTrade(b,100,100,T0+30_000,4000,1,true);
        c.backfill(b);
        assertTrue(b.needBackfill);assertTrue(b.backfill.startsWith("retrying"));
        @SuppressWarnings("unchecked") var rows=(List<Map<String,Object>>)c.view("XAUUSD","",0,T0+M).get("minutes");
        assertEquals(true,rows.get(0).get("partial"));
    }

    @Test void closedMinuteIsResentAsFinalWithoutAnotherTrade(){
        long[] now={T0+30_000};
        var c=new OrderFlowCollector(null,json,url->{throw new IllegalStateException("offline");});c.clock=()->now[0];
        var b=c.books.get("XAUUSD");
        synchronized(b){c.connected(b,T0);}
        c.onTrade(b,1,1,T0+20_000,4000,1,true);
        var first=c.view("XAUUSD","",0,now[0]);
        long rev=((Number)first.get("rev")).longValue();
        @SuppressWarnings("unchecked") var rows=(List<Map<String,Object>>)first.get("minutes");
        assertEquals(false,rows.get(0).get("final"));
        now[0]=T0+M+5_000;c.tick();
        @SuppressWarnings("unchecked") var delta=(List<Map<String,Object>>)c.view("XAUUSD",c.boot,rev,now[0]).get("minutes");
        assertEquals(1,delta.size(),"closed minute is sent again");assertEquals(true,delta.get(0).get("final"));
    }

    @Test void keepAwakeCoversTheMetalsTradingWeekOnly(){
        assertTrue(KeepAwake.inWindow(Instant.parse("2026-11-24T06:30:00Z")));   // Tuesday 12:00 IST
        assertTrue(KeepAwake.inWindow(Instant.parse("2026-11-24T21:30:00Z")));  // Asian session overnight stays awake now
        assertTrue(KeepAwake.inWindow(Instant.parse("2026-11-24T22:30:00Z")));  // daily metals break (17:30 New York)
        assertFalse(KeepAwake.inWindow(Instant.parse("2026-11-28T10:00:00Z")));  // Saturday
        assertFalse(KeepAwake.inWindow(Instant.parse("2026-11-29T22:30:00Z")));  // Sunday 17:30 New York, before the open
        assertTrue(KeepAwake.inWindow(Instant.parse("2026-11-29T23:30:00Z")));   // Sunday 18:30 New York, market open
        assertTrue(KeepAwake.inWindow(Instant.parse("2026-11-27T22:15:00Z")));   // Friday 17:15 New York, last settlements
        assertFalse(KeepAwake.inWindow(Instant.parse("2026-11-27T22:45:00Z")));  // Friday 17:45 New York, week over
    }
}
