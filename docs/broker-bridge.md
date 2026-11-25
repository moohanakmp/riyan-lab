# Broker bridge: mirror app entries to OctaFX MT5

Admin-only. Open the app as an admin and use the **Broker** tab.

## How it works

```
App signal saved (auto / manual)  ──►  broker_orders row (DRY_RUN | QUEUED | BLOCKED)
                                               │
MT5 terminal + RiyanLabBridge EA  ──poll──►  /api/v1/broker/connector/poll   (every 5 s)
          │      ◄── CMD lines (OPEN / MODIFY / CLOSE / PING)
          │
          └──report──►  /api/v1/broker/connector/report  (fill, rejection, retcode, ticket)
             positions + closed deals sent on every poll  ──►  reconciled into broker_orders
```

* OctaFX has no public trading API, so the app does not log in to OctaFX. The EA runs inside your own
  MT5 terminal and pulls work from the app. **Your MT5 password is never sent to or stored by the app.**
* Low Profit stays paper-only and is never mirrored. Basket positions are never mirrored.
* Only entries created **after** the account is linked are mirrored.
* Every order, every state change and every raw broker response is stored:
  * `broker_accounts`: the linked account, mode, limits and connector status (token stored as SHA-256 only).
  * `broker_orders`: one row per OPEN mirror, plus MODIFY (break-even) and CLOSE children, with ticket,
    fill price, retcode, broker message, close price and profit.
  * `broker_order_events`: append-only audit trail (who/what/when plus JSON details).

## Safety controls

| Control | Default | Where enforced |
|---|---|---|
| Mode | **DRY_RUN** (record only, never sent) | Server |
| Mirroring enabled | Off until you switch it on | Server |
| Kill switch | Off; when on, queued entries are blocked and no new entries are sent | Server |
| Max lot | 0.01 (cap 1.00) | Server and EA (`MaxLotHardCap`) |
| Daily loss limit | 20 USD, closed + floating, IST day | Server |
| Max open positions | 2 | Server |
| Max orders per day | 10 | Server |
| Max signal age | 90 s; older queued entries expire, never chased | Server |
| Max slippage | 0.15 % against the app's entry price (better prices accepted up to 5× that), and never more than 25 % of the stop distance (EA input `MaxSlipOfStop`); a price already past the SL is rejected | EA |
| Account identity | Terminal login/server must match the Broker tab | Server and EA (`ExpectedLogin`) |
| Real-money account | Refused | Server needs `RIYAN_BROKER_LIVE_ENABLED=true` **and** typed-login confirmation in the tab; EA needs `AllowRealAccount=true` |
| Duplicate protection | An order without a report becomes `UNKNOWN` and is never re-sent; it is resolved from the positions the terminal reports | Server and EA |

App closes the signal (WIN/LOSS/BE) → a CLOSE is queued for the broker position.
App moves the stop to break-even → a MODIFY moves the broker SL to the fill price.
The broker-side SL and final TP stay on the position as a backstop if the app is asleep.

## Setup (demo first)

1. **Broker tab → Account & limits**: enter the MT5 login and server (e.g. `OctaFX-Demo`), keep Mode = Dry-run,
   turn on *Mirroring enabled*, Save.
2. **Broker tab → Connector token → Generate token**. Copy it; it is shown once.
3. On the Windows PC (or VPS) running MT5 desktop:
   1. Copy `connector/mt5/RiyanLabBridge.mq5` to `MQL5/Experts/` (File → Open Data Folder), then compile it in MetaEditor (F7).
   2. Tools → Options → Expert Advisors: tick **Allow algorithmic trading** and **Allow WebRequest for listed URL**,
      add your app URL (e.g. `https://riyan-lab-staging.onrender.com`).
   3. Log in to the demo account, open any chart, drag **RiyanLabBridge** onto it. Inputs: `ServerUrl`,
      `ConnectorToken`, `ExpectedLogin`; leave `AllowRealAccount=false`, `MaxLotHardCap=0.01`.
4. Broker tab should show **EA online** and the demo account details. Tap **Test link**; the order list shows a
   PING with state DONE. Its message starts with `ALL SYMBOLS OK` or `SYMBOL PROBLEM` and lists each symbol:
   `XAUUSD=OK bid=… ask=… minLot=…`, or `MISSING` (wrong name/suffix: fix the broker symbol box), `TRADING_DISABLED`,
   `CLOSE_ONLY`, `NO_PRICE`, or `OK(stale/market closed)` at weekends.
   Run **one** EA on **one** chart; it trades all three symbols. Do not attach it to each symbol's chart.
5. Watch dry-run rows appear as the app gives entries. When satisfied, switch Mode to **Execute** (still demo).
   Each filled order shows the broker ticket and fill price; check them against the MT5 Trade/History tab.

The MT5 mobile app cannot run Expert Advisors. The PC/VPS must stay on with MT5 open for orders to mirror.
Each poll is also traffic to Render, which keeps the free instance awake while the EA runs; turn the EA
off outside the hours you want mirroring to avoid using up free instance hours.

## Going live (real money)

Do not do this until the demo has run cleanly. It needs all three:
1. Render env var `RIYAN_BROKER_LIVE_ENABLED=true` on the service.
2. Broker tab → Real-money trading: type the live login and confirm (cleared automatically if login/server change).
3. EA input `AllowRealAccount=true` on the live terminal.

## Connector protocol (for reference)

Header `X-Riyan-Connector-Token: <token>`; bodies are `application/x-www-form-urlencoded`; responses are text.

* Poll fields: `login, server, mode(demo|real|contest), company, currency, balance, equity, tradeAllowed, ea, build,
  positions` (`ticket|comment|symbol|BUY/SELL|volume|open|sl|tp|profit;…`), `closes` (`positionId|entryComment|closePrice|profit|utcTime;…`).
* Poll response: first line `OK|…`, `IDLE|…` or `HALT|reason`, then
  `CMD|id|clientId|OPEN/MODIFY/CLOSE/PING|symbol|side|volume|sl|tp|entryRef|maxSlipPct|parentTicket|END`.
* Report fields: `clientId, status(FILLED|REJECTED|DONE), ticket, price, volume, retcode, message, time, login, balance, equity`.

The EA has not been compiled in CI (no MetaTrader toolchain there). Compile it in MetaEditor and run it on demo first.
