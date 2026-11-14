const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const PaperMath=require('../src/main/resources/static/trading-core.js');
const h=fs.readFileSync('src/main/resources/static/index.html','utf8');
function extract(start,end){
 const a=h.indexOf(start),b=h.indexOf(end,a+start.length);
 if(a<0||b<0)throw new Error('Function marker missing: '+start+' / '+end);
 return h.slice(a,b);
}
(async()=>{
 const block=extract('async function riyanSafeRecordId(type,id){','function riyanQueue(type,id,obj){');
 const ctx=vm.createContext({crypto:webcrypto,TextEncoder});
 vm.runInContext(block,ctx);
 const safe=vm.runInContext('riyanSafeRecordId',ctx);
 const original='USD|Core CPI m/m|1791981000000';
 const first=await safe('gold-calls',original);
 const second=await safe('gold-calls',original);
 assert.match(first,/^id-[a-f0-9]{64}$/);
 assert.equal(first,second,'hash must be stable');
 assert.equal(await safe('auto-signals','1791981000000'),'1791981000000');
 assert.notEqual(await safe('analysis',original),first,'type names are hash namespaces');
 assert(!/[| /%]/.test(first),'path ID cannot contain an encoded slash');
 const veryLong='news/important event'.repeat(100);
 assert.match(await safe('news-alerts',veryLong),/^id-[a-f0-9]{64}$/);
 const ownState=await safe('user-state','stateowner:low-profit-diagnostics-XAUUSD');
 const secondState=await safe('user-state','stateowner:low-profit-diagnostics-XAUUSD');
 assert.match(ownState,/^stateowner--id-[a-f0-9]{64}$/);
 assert.equal(ownState,secondState,'owned diagnostics must keep stable safe ID');
 assert(!/[| /:%]/.test(ownState),'owned diagnostics must be URL-safe');
 assert.match(await safe('user-state','anotheruser:activeSignals'),/^anotheruser--id-[a-f0-9]{64}$/);
 console.log('PASS URL-safe IDs, CPI/m/m regression, per-user diagnostics and deterministic hashes');

 const agg=extract('function aggMinutes(c,min){','async function scalpFetch(sym,lim){');
 const closedLine=h.match(/function kmrClosed\(arr\)\{[^\n]+\}/)?.[0];
 if(!closedLine)throw new Error('kmrClosed unavailable');
 const select=extract('function scalpClosed15m(sym,c5,now=Date.now()){','// ctx: {now, events, isMetal, marketOpen, spread, cfg, dec}');
 const now=Math.floor(1800000000000/300000)*300000;
 const bars=Array.from({length:300},(_,i)=>{
  const t=now-(300-i)*300000;
  return {t,o:100+i*.01,h:100.3+i*.01,l:99.8+i*.01,c:100.1+i*.01,v:12};
 });
 const context=vm.createContext({PaperMath,ohlcData:{XAUUSD:{'15m':[]}},Date,Math,Array,Object});
 vm.runInContext(closedLine+'\n'+agg+'\n'+select,context);
 const selector=vm.runInContext('scalpClosed15m',context);
 const fallback=selector('XAUUSD',bars,now);
 assert(fallback.length>=55,'derived 15m must have enough candle history');
 assert(fallback.every(x=>x.t+900000<=now-1000),'fallback only uses closed 15m bars');
 const synthetic=Array.from({length:90},(_,i)=>({
   t:now-3*3600000-(90-i)*900000,o:102,h:103,l:101,c:102,v:12
 }));
 context.ohlcData.XAUUSD['15m']=synthetic;
 // Provider 15m has correct scale but its last bar is stale.
 const stale=selector('XAUUSD',bars,now);
 assert(stale.length>=55,'stale 15m provider must recover from 5m');
 assert.equal(stale[stale.length-1].c,fallback[fallback.length-1].c);
 console.log('PASS Low Profit completed 15m fallback, stale-feed recovery and closed-candle gate');

 const evaluateCode=extract('function scalpEvaluate(sym){','async function scalpOpen(sym,scan,lv){');
 let opened=0, gatesOk=true,barT=now-300000;
 const evalContext=vm.createContext({
   Date,Math,console,paperReady:()=>true,freshQuote:()=>true,paperAccountRisk:()=>({ok:true}),
   basketDemo:{enabled:false,active:null},
   scalpState:{XAUUSD:{feedError:'',cooldown:0}},
   scalpData:{XAUUSD:bars},
   ohlcData:{XAUUSD:{'1h':[]}},
   prices:{XAUUSD:103.09},
   scalpCfg:{auto:true,assets:{XAUUSD:true},stopAtGoal:true,goal:10,dayStop:8},
   scalpHist:[],
   kmrClosed:x=>x,
   scalpClosed15m:()=>[],
   scalpCtx:()=>({}),
   scalpScan:()=>({dir:'BUY',gatesOk,barT,A:1,price:103.09}),
   scalpLevels:()=>({entry:103.09,tp:103.9,sl:102.5,lot:.01}),
   scalpToday:()=>({goalHit:false,stopHit:false}),
   scalpOpen:()=>{opened++}
 });
 vm.runInContext(evaluateCode,evalContext);
 const evaluate=vm.runInContext('scalpEvaluate',evalContext);
 evaluate('XAUUSD');
 assert.equal(opened,1,'valid setup must reach entry path');
 evaluate('XAUUSD');
 assert.equal(opened,1,'same closed candle cannot trigger twice');
 barT+=300000;
 evalContext.scalpState.XAUUSD.feedError='Feed unavailable';
 // feed error must always pause entries, even if cached candles still exist.
 vm.runInContext('scalpState.XAUUSD.handledBar=null',evalContext);
 // replace the test scanner closure to reference a newly closed candle
 evalContext.scalpScan=()=>({dir:'BUY',gatesOk,barT:now,A:1,price:103.09});
 evaluate('XAUUSD');
 assert.equal(opened,1,'failed data feed must prevent entries');
 evalContext.scalpState.XAUUSD.feedError='';
 gatesOk=false;
 evaluate('XAUUSD');
 assert.equal(opened,1,'failed trade safety gates must prevent entries');
 console.log('PASS Low Profit entry pipeline: eligible, duplicate candle, failed feed and failed risk gates');

 // Detailed real structure fixtures are covered by check-volume-trap and check-structure.
 const ctxCode=require('../src/main/resources/background/scanner.cjs').extract('scalpCtx');
 assert(!/calendarReady|kmrNewsEvents/.test(ctxCode),'Low Profit context must not read news');
 console.log('PASS Low Profit has no calendar or headline dependency');

})().catch(e=>{console.error(e);process.exitCode=1;});
