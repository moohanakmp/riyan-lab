package com.riyanlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class LeadAgentTest {
    final ObjectMapper json=new ObjectMapper();
    ArrayNode bars(int n,double start,double step,double range){
        var a=json.createArrayNode();double c=start;
        for(int i=0;i<n;i++){c+=step;a.addObject().put("t",i*3600_000L).put("o",c-step).put("h",c+range/2).put("l",c-range/2).put("c",c);}
        return a;
    }
    @Test void trendAndVolatilityComeFromRealBars(){
        assertEquals("up",LeadAgent.trend(bars(120,2000,2,4)));
        assertEquals("down",LeadAgent.trend(bars(120,2000,-2,4)));
        assertEquals("sideways",LeadAgent.trend(bars(120,2000,0,4)));
        assertEquals("unknown",LeadAgent.trend(bars(10,2000,1,4)));
        var calm=bars(120,2000,0,4);assertEquals(1.0,LeadAgent.volatility(calm),0.01);
        var wild=bars(120,2000,0,4);for(int i=106;i<120;i++){((ObjectNode)wild.get(i)).put("h",2010).put("l",1990);}
        assertTrue(LeadAgent.volatility(wild)>3,"recent wide bars raise the volatility ratio");
        assertEquals(Double.NaN,LeadAgent.volatility(bars(20,1,0,1)));
        assertEquals(48.0/2012*100,LeadAgent.change24h(bars(30,2000,2,4)),1e-9);
    }
    @Test void metalsWeekAndSessions(){
        assertTrue(LeadAgent.metalsOpen(Instant.parse("2026-11-24T10:00:00Z")));
        assertFalse(LeadAgent.metalsOpen(Instant.parse("2026-11-28T10:00:00Z")),"Saturday");
        assertFalse(LeadAgent.metalsOpen(Instant.parse("2026-11-24T22:30:00Z")),"daily break 17:00 New York");
        assertEquals("Asia",LeadAgent.session(Instant.parse("2026-11-24T03:00:00Z")));
        assertEquals("New York",LeadAgent.session(Instant.parse("2026-11-24T18:00:00Z")));
    }
    @Test void reviewNotesAndPlanUseOnlyTheSnapshotAndCalendar(){
        var lead=new LeadAgent(mock(JdbcTemplate.class),json,mock(BackgroundScanner.class),mock(BackgroundFeeds.class));
        Instant now=Instant.parse("2026-11-24T10:00:00Z");
        var snap=json.createObjectNode();
        var gold=snap.putObject("XAUUSD");gold.put("price",2650).put("quoteAt",now.toEpochMilli()-5000);
        var wild=bars(120,2000,0,4);for(int i=106;i<120;i++){((ObjectNode)wild.get(i)).put("h",2010).put("l",1990);}
        gold.putObject("bars").set("1h",wild);((ObjectNode)gold.path("bars")).set("4h",bars(120,2000,0,4));
        var cal=json.createArrayNode();
        cal.addObject().put("title","CPI m/m").put("country","USD").put("impact","High").put("date","2026-11-24T13:30:00Z");
        cal.addObject().put("title","Retail Sales").put("country","EUR").put("impact","High").put("date","2026-11-24T09:00:00Z");
        cal.addObject().put("title","Jobless Claims").put("country","USD").put("impact","Medium").put("date","2026-11-24T13:30:00Z");
        var market=lead.review(snap,Map.of("ready",true,"calendar",cal),now);
        var g=market.path("instruments").get(0);
        assertEquals("XAUUSD",g.path("sym").asText());assertTrue(g.path("volatility").asDouble()>1.5);assertTrue(g.path("quoteFresh").asBoolean());
        assertEquals("No market data yet",market.path("instruments").get(1).path("view").asText(),"missing data is said plainly, never invented");
        assertEquals(1,market.path("highImpactToday").size(),"only high-impact USD news");
        assertEquals("19:00",market.path("highImpactToday").get(0).path("ist").asText());
        var yesterday=json.createObjectNode();yesterday.putArray("instruments").addObject().put("sym","XAUUSD").put("trend4h","up");
        var notes=lead.notes(market,yesterday).toString();
        assertTrue(notes.contains("4h trend changed from up yesterday to sideways"));
        assertTrue(notes.contains("High-impact news at 19:00 IST: CPI m/m"));
        assertFalse(notes.toLowerCase().contains("profit will"),"no profit forecasts");
        var plan=LeadAgent.plan(market);
        assertTrue(plan.stream().anyMatch(t->t.key().equals("focus-XAUUSD")&&t.agent().equals("HUNTER")));
        assertTrue(plan.stream().anyMatch(t->t.key().startsWith("news-")&&t.agent().equals("SCOUT")));
        assertEquals(plan.size(),new HashSet<>(plan.stream().map(t->t.agent()+t.key()).toList()).size(),"task keys unique per agent");
        for(var t:plan)assertFalse(t.title().matches("(?i).*\\b(buy|sell|place|close)\\b.*order.*"),"tasks never trade: "+t.title());
    }
}
