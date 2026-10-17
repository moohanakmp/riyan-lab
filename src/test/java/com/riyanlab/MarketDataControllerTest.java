package com.riyanlab;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class MarketDataControllerTest {
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
