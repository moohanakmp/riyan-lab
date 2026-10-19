'use strict';
// Execute selected, unchanged browser strategy functions in a DOM-free runtime.
// No network, credentials, execution connectors, or outbound notification clients.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=process.env.SCANNER_STATIC||path.resolve(__dirname,'../static');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function extract(name,kind='function'){
  const pattern=kind==='function'?new RegExp('^(?:async )?function '+name+'\\(','gm'):new RegExp('^(?:const|let|var) '+name+'\\s*=','gm');
  const found=[...html.matchAll(pattern)].at(-1);if(!found)throw Error('Shared strategy missing: '+name);
  const start=found.index;
  for(let end=start;end<html.length;end++){
    if(html[end]!== (kind==='function'?'}':';'))continue;
    const source=html.slice(start,end+1);
    try{new vm.Script(kind==='function'?'('+source+')':source);return source;}catch(e){}
  }
  throw Error('Cannot parse shared strategy '+name);
}
const names=['ema','rsi','atr','swingLevels','emaSeries','macd','kmrAdx','kmrPivots','kmrStructure','kmrVolumePressure','kmrSweep','kmrTfBias','kmrSmartScan','ev2txt','kmrTradePlan','kmrClosed','kmrIstHour','kmrNewsEvents','calendarReady','kmrScan','getCandles','computeSignal','orderBlocks','calcPos','computeVolSpike','marketEvidenceSnapshot','paperAccountRisk','autoEntryCheck','evaluateSignals','recordSignal','checkOutcome','isMetalsMarketOpen','istDayKey','scalpToday','bbAt','aggMinutes','scalpClosed15m','kmrLevelZones','kmrLevelSetup','kmrLevelPlan','scalpScan','scalpLevels','scalpCtx','scalpEvaluate','scalpOpen','scalpClose','scalpCheckRange','scalpCandleCheck','scalpManageAll','fmtP','freshQuote'];
const paper=fs.readFileSync(path.join(root,'paper-engine.js'),'utf8');
const source=fs.readFileSync(path.join(root,'trading-core.js'),'utf8')+'\n'+
 fs.readFileSync(path.join(root,'market-context.js'),'utf8')+'\n'+
 ['ASSETS','ICONS','SIG_TUNE','SPREAD','SCALP_DEF'].map(n=>extract(n,'const')).join('\n')+'\n'+
 names.filter(n=>n!=='freshQuote').map(n=>extract(n)).join('\n')+'\n'+paper.match(/function freshQuote\([^\n]+/)[0];
function normalize(raw,ms,now,coinbase){
  if(!Array.isArray(raw))return [];
  const rows=raw.map(r=>coinbase?{t:+r[0]*1000,ms,l:+r[1],h:+r[2],o:+r[3],c:+r[4],v:+r[5]}:{t:+r[0],ms,o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]});
  rows.sort((a,b)=>a.t-b.t);const unique=new Map();
  for(const k of rows){if(!Number.isFinite(k.t)||k.t%ms||!['o','h','l','c'].every(p=>Number.isFinite(k[p])&&k[p]>0)||!Number.isFinite(k.v)||k.v<0||k.h<Math.max(k.o,k.c,k.l)||k.l>Math.min(k.o,k.c,k.h))return [];
    if(unique.has(k.t)&&JSON.stringify(unique.get(k.t))!==JSON.stringify(k))return [];
    if(k.t+ms<=now)unique.set(k.t,k);
  }
  return [...unique.values()];
}
async function scan(job){
 job=JSON.parse(JSON.stringify(job));
 const before=new Map(job.history.map(x=>[x.type+'|'+x.id,JSON.stringify(x.record)]));
 const now=job.now||Date.now(),changes=new Map(),pending=[],diagnostics={},errors=[];
 const FixedDate=class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 const context=vm.createContext({Date:FixedDate,Intl,console:{warn:()=>{}},job,diagnostics,errors,
  document:{getElementById:()=>({style:{display:'none'}})},
  showToast:()=>{},fireAlert:()=>{},fireOutcome:()=>{},scalpNotify:()=>{},recordHourSample:()=>{},saveSigMeta:()=>{},renderSignals:()=>{},renderHistory:()=>{},sendTelegram:()=>{},sendEmailAlert:()=>{},claimAlertOnce:async()=>false,
  paperReady:()=>true,
  dbPut:async(_,r)=>save(r.manual?'manual-signals':'auto-signals',r.id,r),
  saveSignal:async r=>save(r.manual?'manual-signals':'auto-signals',r.id,r),
  saveScalpHist:()=>{},
  paperSaveEntry:async(type,id,r)=>{r.generator='server-background';save(type,id,r);return true;},
  __track:p=>{pending.push(p);return p;},__save:save});
 function save(type,id,r){changes.set(type+'|'+id,{type,id:String(id),record:JSON.parse(JSON.stringify(r))});}
 vm.runInContext(source+`\n
 const SYMS=Object.keys(ASSETS),CAPITAL=100,LOT_HIGH=.02,LOT_MED=.01,SIGNAL_COOLDOWN_MS=180000;
 let currentUser={username:job.username,role:job.role},alertsEnabled=false;
 let prices={},quoteAt={},ohlcData={},scalpData={},scalpState={},marketTrend={},volSpike={},mtfTrend={};
 let calendarCache=job.calendar||null,calendarCacheAt=job.calendarAt||0,calendarHealth={expiresAt:job.expiresAt||calendarCacheAt+30*60e3};
 let signalHistory=job.history.filter(x=>x.type!=='low-profit').map(x=>x.record),scalpHist=job.history.filter(x=>x.type==='low-profit').map(x=>x.record);
 let scalpCfg={...SCALP_DEF,...job.config,assets:{...SCALP_DEF.assets,...job.config?.assets}};
 const basketDemo={enabled:!!job.basketEnabled,active:job.basketActive||null};
 let activeSignals={},sigCooldown={},lastSigCandleTs={},lastGuardToast={},signalEntryPending={},signalEntryStatus={};
 for(const r of signalHistory){if(r.outcome==='OPEN')activeSignals[r.sym]=r.id;else sigCooldown[r.sym]=Math.max(sigCooldown[r.sym]||0,(r.closedAt||0)+SIGNAL_COOLDOWN_MS);}
 for(const sym of SYMS){
  const f=job.feeds[sym]||{};prices[sym]=f.price;quoteAt[sym]=f.quoteAt||0;ohlcData[sym]=f.bars||{};scalpData[sym]=f.five||[];
  const closed=scalpHist.filter(r=>r.sym===sym&&r.status!=='OPEN');
  scalpState[sym]={feedSource:f.source||'Unavailable',feedError:f.error||'',cooldown:closed.reduce((n,r)=>Math.max(n,(r.closedAt||0)+(r.pnl<0?15:5)*60000),0)};
 }
 function computeMTFTrend(sym){return {'1h':kmrTfBias(kmrClosed(ohlcData[sym]['1h']||[])),'4h':kmrTfBias(kmrClosed(ohlcData[sym]['4h']||[]))};}
 // Entries retain the exact existing evaluateSignals/scalpEvaluate paths.
 const originalRecordSignal=recordSignal;recordSignal=(...a)=>__track(originalRecordSignal(...a));
 const originalScalpOpen=scalpOpen;scalpOpen=(...a)=>__track(originalScalpOpen(...a));
 `,context,{timeout:5000});
 await vm.runInContext(`(async()=>{
  for(const sym of SYMS)await checkOutcome(sym,prices[sym]);
  scalpCandleCheck();scalpManageAll();if(job.allowEntries!==false)evaluateSignals();
  for(const sym of SYMS){if(job.allowEntries!==false)scalpEvaluate(sym);else scalpState[sym].block="Open the app once to synchronize your strategy and risk settings";const st=scalpState[sym],s=computeSignal(sym);diagnostics[sym]={auto:s.reason||s.wait||s.state,lowProfit:st.block||st.note||st.scan?.gates?.find(g=>!g.ok)?.label||st.scan?.look||'Waiting for confirmed setup',source:st.feedSource,quoteAt:quoteAt[sym]||0,last15m:ohlcData[sym]['15m']?.at(-1)?.t||0,last5m:scalpData[sym]?.at(-1)?.t||0};}
 })()`,context,{timeout:5000});
 await Promise.all(pending);
 vm.runInContext(`for(const r of scalpHist)__save('low-profit',r.id||r.t,r);`,context,{timeout:2000});
 return {username:job.username,changes:[...changes.values()].filter(x=>JSON.stringify(x.record)!==before.get(x.type+'|'+x.id)),diagnostics,checkedAt:now};
}
module.exports={scan,normalize,extract};
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;if(input.length>12000000)throw Error('Scanner input too large');});process.stdin.on('end',async()=>{try{const j=JSON.parse(input);process.stdout.write(JSON.stringify(await scan(j)));}catch(e){process.stderr.write(e.stack+'\n');process.exitCode=1;}});}
