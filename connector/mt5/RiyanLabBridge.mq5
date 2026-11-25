//+------------------------------------------------------------------+
//| RiyanLabBridge.mq5                                               |
//| Pull-based bridge between Riyan Lab and an MT5 terminal.         |
//|                                                                  |
//| - Polls <ServerUrl>/api/v1/broker/connector/poll every few secs. |
//| - Executes OPEN / MODIFY / CLOSE / PING commands from the app.   |
//| - Reports every fill, rejection, open position and closed deal   |
//|   back so the app database holds broker-side evidence.           |
//| - Your MT5 password never leaves this terminal.                  |
//|                                                                  |
//| Safety: refuses real-money accounts unless AllowRealAccount=true |
//| (the server separately refuses unless live is confirmed there).  |
//| Refuses a terminal whose login differs from ExpectedLogin.       |
//| Caps every order at MaxLotHardCap and checks slippage first.     |
//+------------------------------------------------------------------+
#property copyright "Riyan Lab"
#property version   "1.10"
#property strict

#include <Trade/Trade.mqh>

input string ServerUrl        = "https://riyan-lab-staging.onrender.com"; // App URL (add it under Tools > Options > Expert Advisors > Allow WebRequest)
input string ConnectorToken   = "";      // Token from the app's Broker tab
input long   ExpectedLogin    = 0;       // Your MT5 login; EA stops if the terminal is on another account
input bool   AllowRealAccount = false;   // Keep false for demo. Real money also needs server-side confirmation
input double MaxLotHardCap    = 0.01;    // Absolute per-order cap enforced in the terminal
input int    PollSeconds      = 5;       // Poll interval
input int    SlippagePoints   = 50;      // Max deviation passed to the broker on market orders
input double MaxSlipOfStop    = 0.25;    // Reject if price moved against the entry by more than this share of the stop distance
input long   MagicNumber      = 260301;  // Identifies Riyan Lab positions
input int    HttpTimeoutMs    = 8000;    // Render free tier may need a cold start; failed polls simply retry

CTrade trade;
const string EA_VERSION = "RiyanLabBridge/1.10";
datetime lastHaltLog = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   if(StringLen(ConnectorToken) < 20) { Alert("RiyanLabBridge: set ConnectorToken from the Broker tab"); return INIT_PARAMETERS_INCORRECT; }
   if(ExpectedLogin <= 0)            { Alert("RiyanLabBridge: set ExpectedLogin to your MT5 login"); return INIT_PARAMETERS_INCORRECT; }
   if(!SafeAccount(true)) return INIT_FAILED;
   trade.SetExpertMagicNumber((ulong)MagicNumber);
   trade.SetDeviationInPoints((ulong)SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   EventSetTimer(MathMax(2, PollSeconds));
   Print("RiyanLabBridge started for login ", AccountInfoInteger(ACCOUNT_LOGIN), " (", AccountMode(), ")");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer() { Poll(); }

//+------------------------------------------------------------------+
string AccountMode()
{
   long m = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(m == ACCOUNT_TRADE_MODE_DEMO)    return "demo";
   if(m == ACCOUNT_TRADE_MODE_CONTEST) return "contest";
   return "real";
}

bool SafeAccount(bool alert)
{
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string why = "";
   if(login != ExpectedLogin) why = "terminal login " + IntegerToString(login) + " is not ExpectedLogin";
   else if(AccountMode() == "real" && !AllowRealAccount) why = "real-money account and AllowRealAccount=false";
   if(why == "") return true;
   if(alert) Alert("RiyanLabBridge refused: ", why);
   else Print("RiyanLabBridge refused: ", why);
   return false;
}

string UrlEncode(string s)
{
   uchar bytes[]; int n = StringToCharArray(s, bytes, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   string out = "";
   for(int i = 0; i < n; i++)
   {
      uchar c = bytes[i];
      if((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~')
         out += CharToString(c);
      else out += StringFormat("%%%02X", c);
   }
   return out;
}

string Clean(string s) { StringReplace(s, "|", " "); StringReplace(s, ";", " "); StringReplace(s, "\n", " "); return s; }

bool Post(string path, string body, string &response)
{
   char data[], result[]; string resultHeaders;
   StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   string headers = "Content-Type: application/x-www-form-urlencoded\r\nX-Riyan-Connector-Token: " + ConnectorToken + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", ServerUrl + path, headers, HttpTimeoutMs, data, result, resultHeaders);
   if(code == -1) { Print("RiyanLabBridge: WebRequest failed (", GetLastError(), "). Is ", ServerUrl, " in the allowed URL list?"); return false; }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code != 200) { Print("RiyanLabBridge: HTTP ", code, " on ", path, " ", StringSubstr(response, 0, 200)); return false; }
   return true;
}

// Broker server time -> UTC unix seconds (offset rounded to 30 minutes).
// Uses today's server offset. A close is reported on the first poll after it happens, so the stored time is
// right unless the EA was offline across a DST switch; the server also never stores a close time in the future.
long ToUtc(datetime serverTime)
{
   long offset = (long)(TimeTradeServer() - TimeGMT());
   offset = (long)MathRound(offset / 1800.0) * 1800;
   return (long)serverTime - offset;
}

string PositionsField()
{
   string out = "";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      string type = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL";
      double profit = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      out += StringFormat("%I64u|%s|%s|%s|%.2f|%s|%s|%s|%.2f;", ticket, Clean(PositionGetString(POSITION_COMMENT)),
             PositionGetString(POSITION_SYMBOL), type, PositionGetDouble(POSITION_VOLUME),
             DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 8), DoubleToString(PositionGetDouble(POSITION_SL), 8),
             DoubleToString(PositionGetDouble(POSITION_TP), 8), profit);
   }
   return out;
}

// Closed Riyan Lab positions in the last 2 days, keyed by position id with the ENTRY deal's comment
// (brokers often rewrite the closing deal comment, e.g. "[sl 2345.10]").
string ClosesField()
{
   if(!HistorySelect(TimeCurrent() - 7 * 86400, TimeCurrent() + 60)) return ""; // 7 days so the entry deal of a 2-day-old close is included
   int total = HistoryDealsTotal();
   ulong ids[]; string comments[]; int n = 0;
   for(int i = 0; i < total; i++)
   {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0 || HistoryDealGetInteger(d, DEAL_MAGIC) != MagicNumber || HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
      ArrayResize(ids, n + 1); ArrayResize(comments, n + 1);
      ids[n] = (ulong)HistoryDealGetInteger(d, DEAL_POSITION_ID); comments[n] = HistoryDealGetString(d, DEAL_COMMENT); n++;
   }
   string out = ""; int sent = 0; ulong done[]; int nd = 0;
   for(int i = total - 1; i >= 0 && sent < 50; i--)
   {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0 || HistoryDealGetInteger(d, DEAL_MAGIC) != MagicNumber) continue;
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      ulong pos = (ulong)HistoryDealGetInteger(d, DEAL_POSITION_ID);
      if(PositionSelectByTicket(pos)) continue; // partially closed, still open
      bool seen = false;
      for(int k = 0; k < nd; k++) if(done[k] == pos) { seen = true; break; }
      if(seen) continue; // the newest OUT deal already reported this position
      ArrayResize(done, nd + 1); done[nd++] = pos;
      string comment = "";
      for(int k = 0; k < n; k++) if(ids[k] == pos) { comment = comments[k]; break; }
      // Net result of the whole position: every deal (entry commission, partial closes, swap, fees), not only the last exit.
      double profit = 0;
      for(int j = 0; j < total; j++)
      {
         ulong x = HistoryDealGetTicket(j);
         if(x == 0 || (ulong)HistoryDealGetInteger(x, DEAL_POSITION_ID) != pos) continue;
         profit += HistoryDealGetDouble(x, DEAL_PROFIT) + HistoryDealGetDouble(x, DEAL_SWAP)
                 + HistoryDealGetDouble(x, DEAL_COMMISSION) + HistoryDealGetDouble(x, DEAL_FEE);
      }
      out += StringFormat("%I64u|%s|%s|%.2f|%I64d;", pos, Clean(comment), DoubleToString(HistoryDealGetDouble(d, DEAL_PRICE), 8),
             profit, ToUtc((datetime)HistoryDealGetInteger(d, DEAL_TIME)));
      sent++;
   }
   return out;
}

//+------------------------------------------------------------------+
void Poll()
{
   string body = "login=" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))
      + "&server=" + UrlEncode(AccountInfoString(ACCOUNT_SERVER))
      + "&mode=" + AccountMode()
      + "&company=" + UrlEncode(AccountInfoString(ACCOUNT_COMPANY))
      + "&currency=" + UrlEncode(AccountInfoString(ACCOUNT_CURRENCY))
      + "&balance=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2)
      + "&equity=" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2)
      + "&tradeAllowed=" + (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED) ? "true" : "false")
      + "&ea=" + UrlEncode(EA_VERSION)
      + "&build=" + IntegerToString(TerminalInfoInteger(TERMINAL_BUILD))
      + "&positions=" + UrlEncode(PositionsField())
      + "&closes=" + UrlEncode(ClosesField());
   string response;
   if(!Post("/api/v1/broker/connector/poll", body, response)) return;
   string lines[]; int count = StringSplit(response, '\n', lines);
   if(count < 1) return;
   if(StringFind(lines[0], "HALT|") == 0 && TimeCurrent() - lastHaltLog > 300) { Print("RiyanLabBridge: server halted commands: ", lines[0]); lastHaltLog = TimeCurrent(); }
   for(int i = 1; i < count; i++)
   {
      if(StringFind(lines[i], "CMD|") != 0) continue;
      string f[]; if(StringSplit(lines[i], '|', f) < 13 || f[12] != "END") continue;
      Execute(f);
   }
}

void Report(string clientId, string status, string ticket, double price, double volume, uint retcode, string message)
{
   string body = "clientId=" + UrlEncode(clientId) + "&status=" + status + "&ticket=" + UrlEncode(ticket)
      + "&price=" + DoubleToString(price, 8) + "&volume=" + DoubleToString(volume, 2)
      + "&retcode=" + IntegerToString(retcode) + "&message=" + UrlEncode(message)
      + "&time=" + IntegerToString((long)TimeGMT())
      + "&login=" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))
      + "&balance=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2)
      + "&equity=" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   string response;
   for(int attempt = 0; attempt < 3; attempt++) if(Post("/api/v1/broker/connector/report", body, response)) return;
   Print("RiyanLabBridge: report for ", clientId, " not delivered; the server will reconcile from positions");
}

ulong FindPositionByComment(string clientId)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t != 0 && PositionGetInteger(POSITION_MAGIC) == MagicNumber && PositionGetString(POSITION_COMMENT) == clientId) return t;
   }
   return 0;
}

// One symbol's readiness for the link test: exists, trading enabled, live price, volume limits.
string RiyanSymbolCheck(string sym)
{
   if(!SymbolSelect(sym, true)) return sym + "=MISSING(check name/suffix in Broker tab)";
   long tm = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   if(tm == SYMBOL_TRADE_MODE_DISABLED) return sym + "=TRADING_DISABLED";
   if(tm == SYMBOL_TRADE_MODE_CLOSEONLY) return sym + "=CLOSE_ONLY";
   MqlTick tick;
   if(!SymbolInfoTick(sym, tick) || tick.bid <= 0) return sym + "=NO_PRICE";
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   string age = TimeCurrent() - tick.time > 300 ? "(stale/market closed)" : "";
   return StringFormat("%s=OK%s bid=%s ask=%s minLot=%.2f", sym, age, DoubleToString(tick.bid, digits), DoubleToString(tick.ask, digits),
          SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN));
}

// f: CMD|id|clientId|action|symbol|side|volume|sl|tp|entryRef|maxSlipPct|parentTicket|END
void Execute(string &f[])
{
   string clientId = f[2], action = f[3], symbol = f[4], side = f[5];
   double volume = StringToDouble(f[6]), sl = StringToDouble(f[7]), tp = StringToDouble(f[8]);
   double entryRef = StringToDouble(f[9]), maxSlip = StringToDouble(f[10]);
   ulong parent = (ulong)StringToInteger(f[11]);

   if(action == "PING")
   {
      string msg = StringFormat("login=%I64d server=%s mode=%s balance=%.2f equity=%.2f %s",
             AccountInfoInteger(ACCOUNT_LOGIN), AccountInfoString(ACCOUNT_SERVER), AccountMode(),
             AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY), AccountInfoString(ACCOUNT_CURRENCY));
      bool allOk = true;
      if(StringLen(symbol) > 0)
      {
         string syms[]; int ns = StringSplit(symbol, ',', syms);
         for(int i = 0; i < ns; i++) { string r = RiyanSymbolCheck(syms[i]); if(StringFind(r, "=OK") < 0) allOk = false; msg += " " + r; }
      }
      // DONE means the terminal answered; the symbol results are in the message.
      Report(clientId, "DONE", "", 0, 0, 0, (allOk ? "ALL SYMBOLS OK " : "SYMBOL PROBLEM ") + msg);
      return;
   }
   if(!SafeAccount(false)) { Report(clientId, "REJECTED", "", 0, 0, 0, "EA safety refused this account"); return; }

   if(action == "OPEN")
   {
      ulong existing = FindPositionByComment(clientId);
      if(existing != 0 && PositionSelectByTicket(existing))
      {  // Already executed (e.g. a lost report) - never open twice.
         Report(clientId, "FILLED", IntegerToString((long)existing), PositionGetDouble(POSITION_PRICE_OPEN), PositionGetDouble(POSITION_VOLUME), 0, "Existing position");
         return;
      }
      if(!SymbolSelect(symbol, true)) { Report(clientId, "REJECTED", "", 0, 0, 0, "Unknown symbol " + symbol); return; }
      double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP), vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
      volume = MathMin(volume, MaxLotHardCap);
      if(step > 0) volume = MathFloor(volume / step + 1e-9) * step;
      if(volume < vmin) { Report(clientId, "REJECTED", "", 0, 0, 0, "Volume below symbol minimum"); return; }
      MqlTick tick; if(!SymbolInfoTick(symbol, tick)) { Report(clientId, "REJECTED", "", 0, 0, 0, "No price for " + symbol); return; }
      double price = side == "BUY" ? tick.ask : tick.bid;
      // Slippage limit applies to adverse moves only; a better price is accepted unless it is so far off
      // (over 5x the limit) that the broker and app prices probably do not match.
      double movePct = entryRef > 0 ? (side == "BUY" ? price - entryRef : entryRef - price) / entryRef * 100.0 : 0;
      if(entryRef > 0 && maxSlip > 0 && (movePct > maxSlip || -movePct > 5 * maxSlip))
      { Report(clientId, "REJECTED", "", price, 0, 0, StringFormat("Price moved %.3f%% %s app entry; limit %.3f%%", MathAbs(movePct), movePct > 0 ? "against" : "in favour of", maxSlip)); return; }
      // Risk check in price terms: a % limit alone can exceed a tight gold stop and double the planned loss.
      if(sl > 0 && ((side == "BUY" && price <= sl) || (side == "SELL" && price >= sl)))
      { Report(clientId, "REJECTED", "", price, 0, 0, StringFormat("Price %.5f already past stop %.5f", price, sl)); return; }
      double adverse = side == "BUY" ? price - entryRef : entryRef - price, stopDist = MathAbs(entryRef - sl);
      if(entryRef > 0 && sl > 0 && MaxSlipOfStop > 0 && adverse > MaxSlipOfStop * stopDist)
      { Report(clientId, "REJECTED", "", price, 0, 0, StringFormat("Price moved %.5f against entry; limit %.0f%% of %.5f stop", adverse, MaxSlipOfStop * 100.0, stopDist)); return; }
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      sl = sl > 0 ? NormalizeDouble(sl, digits) : 0; tp = tp > 0 ? NormalizeDouble(tp, digits) : 0;
      trade.SetTypeFillingBySymbol(symbol);
      bool sent = side == "BUY" ? trade.Buy(volume, symbol, 0, sl, tp, clientId) : trade.Sell(volume, symbol, 0, sl, tp, clientId);
      uint rc = trade.ResultRetcode();
      if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL || rc == TRADE_RETCODE_PLACED))
      {
         ulong pos = FindPositionByComment(clientId);
         string ticket = IntegerToString((long)(pos != 0 ? pos : trade.ResultOrder()));
         Report(clientId, "FILLED", ticket, trade.ResultPrice(), trade.ResultVolume(), rc, trade.ResultRetcodeDescription());
      }
      else Report(clientId, "REJECTED", "", trade.ResultPrice(), 0, rc, trade.ResultRetcodeDescription());
      return;
   }

   if(!PositionSelectByTicket(parent) || PositionGetInteger(POSITION_MAGIC) != MagicNumber)
   { Report(clientId, "REJECTED", "", 0, 0, 0, "Position not open"); return; }

   if(action == "MODIFY")
   {
      int digits = (int)SymbolInfoInteger(PositionGetString(POSITION_SYMBOL), SYMBOL_DIGITS);
      double newSl = NormalizeDouble(sl > 0 ? sl : PositionGetDouble(POSITION_PRICE_OPEN), digits);
      bool ok = trade.PositionModify(parent, newSl, PositionGetDouble(POSITION_TP));
      Report(clientId, ok && trade.ResultRetcode() == TRADE_RETCODE_DONE ? "DONE" : "REJECTED", IntegerToString((long)parent), newSl, 0,
             trade.ResultRetcode(), trade.ResultRetcodeDescription());
      return;
   }
   if(action == "CLOSE")
   {
      bool ok = trade.PositionClose(parent);
      uint rc = trade.ResultRetcode();
      Report(clientId, ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL) ? "DONE" : "REJECTED", IntegerToString((long)parent),
             trade.ResultPrice(), trade.ResultVolume(), rc, trade.ResultRetcodeDescription());
      return;
   }
   Report(clientId, "REJECTED", "", 0, 0, 0, "Unknown action " + action);
}
//+------------------------------------------------------------------+
