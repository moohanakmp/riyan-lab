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
}
