# Order flow footprint and real-time delta: 19 November 2026

## Why delta and trade volume lagged 1 to 2 minutes
- The "Delta & traded-volume" charts and the trade volume table use **closed** candles only. At 10:02:50 the newest row is the 10:01 candle, so it always looks 1 to 2 minutes old (5 to 10 minutes on the 5m view).
- The 1m history is re-fetched over REST at most every 15 s, and the page re-renders every 5 s, which adds up to about 20 s more.
- Delta there is an estimate from candle shape, not real trades.

## Changes (display only, never places or approves entries)
- `order-flow.js`: builds a footprint from the live trade streams already used by the live panel (OKX XAU/XAG-USDT perpetual trades, Coinbase BTC-USD matches). Each trade has the real taker side, so buy and sell volume at every price, delta and CVD are measured. Updates every second, including the forming candle.
- Volume Trap shows a footprint (sell left in red, buy right in green, darker = more volume), absorption candidates boxed in yellow, delta bars and CVD, with a 1m / 5m switch. All existing Volume Trap sections stay.
- Popup alert on state change, using closed candles only (no flicker inside a candle): HEALTHY buy/sell trend (price and delta agree), WARNING (price makes new highs/lows but delta shrinks for 3 candles, or absorption), ACT (delta flips + to − = sell trend, − to + = buy trend). The same alert does not repeat within 3 candles. Toggle on the card.
- Closed 1m candles from the live stream are appended to the delta/trade-volume tables as soon as they close instead of waiting for the next REST poll.
- After Volume Trap is opened once, the stream keeps running while the app is on screen (any tab) so alerts can pop up. It stops when the app is in the background. Turning alerts off restores the old behaviour.

## Limits
- Latency is the exchange WebSocket latency (normally under a second). No server or Render tier change is involved.
- Footprint history starts when the stream connects; no free source gives past trades in bulk. Candles that missed trades are marked partial and are not used for alerts.
- Metals footprint is OKX perpetual volume (converted from contracts to metal units), not broker spot volume.
- Alerts run only while the app is open in the foreground.
