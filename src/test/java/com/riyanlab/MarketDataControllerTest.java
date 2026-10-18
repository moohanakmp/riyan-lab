package com.riyanlab;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class MarketDataControllerTest {
    @Test @SuppressWarnings({"unchecked","rawtypes"})
    void rateLimitPausesOtherTimeframesWithoutBlockingOtherProviders() throws Exception {
        var client=org.mockito.Mockito.mock(java.net.http.HttpClient.class);
        var upstream=org.mockito.Mockito.mock(java.net.http.HttpResponse.class);
        org.mockito.Mockito.when(upstream.statusCode()).thenReturn(429);
        org.mockito.Mockito.when(upstream.headers()).thenReturn(java.net.http.HttpHeaders.of(java.util.Map.of(),(a,b)->true));
        org.mockito.Mockito.when(client.send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class))).thenReturn(upstream);
        var controller=new MarketDataController(org.mockito.Mockito.mock(AuthService.class),client);
        var req=new org.springframework.mock.web.MockHttpServletRequest();
        assertEquals(503,controller.data("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=15m&range=1mo",req).getStatusCode().value());
        assertEquals(503,controller.data("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=5m&range=1mo",req).getStatusCode().value());
        org.mockito.Mockito.verify(client,org.mockito.Mockito.times(1)).send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class));
        org.mockito.Mockito.when(upstream.statusCode()).thenReturn(200);
        org.mockito.Mockito.when(upstream.body()).thenReturn("{}");
        assertEquals(200,controller.data("https://api.exchange.coinbase.com/products/BTC-USD/ticker",req).getStatusCode().value());
    }
    @Test @SuppressWarnings({"unchecked","rawtypes"})
    void concurrentTabsShareOneUpstreamRequest() throws Exception {
        var client=org.mockito.Mockito.mock(java.net.http.HttpClient.class);
        var upstream=org.mockito.Mockito.mock(java.net.http.HttpResponse.class);
        org.mockito.Mockito.when(upstream.statusCode()).thenReturn(200);
        org.mockito.Mockito.when(upstream.body()).thenReturn("{}");
        var entered=new java.util.concurrent.CountDownLatch(1);
        var release=new java.util.concurrent.CountDownLatch(1);
        org.mockito.Mockito.when(client.send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class))).thenAnswer(call->{
            entered.countDown();assertTrue(release.await(5,java.util.concurrent.TimeUnit.SECONDS));return upstream;
        });
        var controller=new MarketDataController(org.mockito.Mockito.mock(AuthService.class),client);
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            java.util.concurrent.Callable<Integer> fetch=()->controller.data("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=15m&range=1mo",new org.springframework.mock.web.MockHttpServletRequest()).getStatusCode().value();
            var first=pool.submit(fetch);assertTrue(entered.await(5,java.util.concurrent.TimeUnit.SECONDS));
            var second=pool.submit(fetch);release.countDown();
            assertEquals(200,first.get(5,java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(200,second.get(5,java.util.concurrent.TimeUnit.SECONDS));
        } finally {release.countDown();}
        org.mockito.Mockito.verify(client,org.mockito.Mockito.times(1)).send(org.mockito.ArgumentMatchers.any(java.net.http.HttpRequest.class),org.mockito.ArgumentMatchers.any(java.net.http.HttpResponse.BodyHandler.class));
    }

    @Test void providerCooldownHonorsRetryAfterAndBoundsUntrustedValues(){
        for(var example:java.util.Map.of("120",120000L,"0",60000L,"-5",60000L,"999999",3600000L,"invalid",60000L).entrySet()) {
            var headers=java.net.http.HttpHeaders.of(java.util.Map.of("Retry-After",java.util.List.of(example.getKey())),(a,b)->true);
            assertEquals(example.getValue().longValue(),MarketDataController.retryDelay(headers));
        }
        assertEquals(60000,MarketDataController.retryDelay(java.net.http.HttpHeaders.of(java.util.Map.of(),(a,b)->true)));
    }

    @Test void referenceHistoryIsBoundedToKnownMetalsAndMajorFxFutures(){
        String base="https://query1.finance.yahoo.com/v8/finance/chart/";
        for(String symbol:new String[]{"GC","SI","PL","PA","6E","6B","6J","6A","6C","6S","6N"})
            assertNotNull(MarketDataController.allowed(base+symbol+"%3DF?interval=15m&range=1mo"));
        for(String query:new String[]{"interval=1m&range=5d","interval=5m&range=1mo","interval=30m&range=1mo","interval=60m&range=1y","interval=1d&range=5y"})
            assertNotNull(MarketDataController.allowed(base+"GC%3DF?"+query));
        for(String url:new String[]{base+"AAPL?interval=15m&range=1mo",base+"GC%3DF?interval=1m&range=max",
            base+"GC%3DF?interval=15m&range=5y",base+"GC%3DF?interval=15m&range=1mo&callback=evil",
            base+"GC%3DF?interval=15m&range=1mo&interval=1d",base+"GC%3DF?range=1mo",base+"GC%3DF",
            base+"GC%253DF?interval=15m&range=1mo","https://query1.finance.yahoo.com.evil.test/v8/finance/chart/GC%3DF?interval=15m&range=1mo",
            "https://query1.finance.yahoo.com:443/v8/finance/chart/GC%3DF?interval=15m&range=1mo",
            "https://evil@query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=15m&range=1mo",
            base+"GC%3DF?interval=15m&range=1mo#fragment"})
            assertThrows(org.springframework.web.server.ResponseStatusException.class,()->MarketDataController.allowed(url));
    }
    @Test void onlyFixedPublicDataEndpointsAreAllowed(){
        assertNotNull(MarketDataController.allowed("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1000"));
        assertNotNull(MarketDataController.allowed("https://api.gold-api.com/price/XAU"));
        assertNotNull(MarketDataController.allowed("https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22%5D"));
        for(String url:new String[]{"http://localhost/", "https://api.binance.com.evil.test/api/v3/klines", "https://api.binance.com/api/v3/order", "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1001", "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1&url=http://localhost"})
            assertThrows(org.springframework.web.server.ResponseStatusException.class,()->MarketDataController.allowed(url));
    }
    @Test void coinbaseAllowsOnlyBoundedBtcPublicRequests(){
        String base="https://api.exchange.coinbase.com/products/BTC-USD/";
        assertNotNull(MarketDataController.allowed(base+"ticker"));
        assertNotNull(MarketDataController.allowed(base+"stats"));
        assertNotNull(MarketDataController.allowed(base+"candles?granularity=900&start=2025-01-01T00:00:00.000Z&end=2025-01-03T23:59:59.000Z"));
        for(String url:new String[]{base+"ticker?extra=true",base+"orders",base+"candles?granularity=1800&start=2025-01-01T00:00:00Z&end=2025-01-02T00:00:00Z",base+"candles?granularity=60&start=2025-01-01T00:00:00Z&end=2025-01-02T00:00:00Z",base+"candles?granularity=60&start=2025-01-02T00:00:00Z&end=2025-01-01T00:00:00Z",base+"candles?granularity=60&start=2099-01-01T00:00:00Z&end=2099-01-01T00:01:00Z","https://api.exchange.coinbase.com/products/ETH-USD/ticker",base+"candles?granularity=60&granularity=900&start=2025-01-01T00:00:00Z&end=2025-01-01T01:00:00Z"})
            assertThrows(org.springframework.web.server.ResponseStatusException.class,()->MarketDataController.allowed(url));
    }
}
