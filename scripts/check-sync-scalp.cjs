const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
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
 const context=vm.createContext({ohlcData:{XAUUSD:{'15m':[]}},Date,Math,Array,Object});
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

 const evaluateCode=extract('function scalpEvaluate(sym){','function scalpOpen(sym,scan,lv){');
 let opened=0, gatesOk=true,barT=now-300000;
 const evalContext=vm.createContext({
   Date,Math,console,
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

 // Regression-test the *real* candidate engine with deterministic closed 5m
 // candles, not a fabricated BUY sent to the app/MT5. Original setups remain
 // active while the new continuation requires an explicit opt-in.
 const realScanCode=extract('function scalpScan(sym,c5,c15,h1,ctx){',
                            'function scalpLevels(sym,dir,entry,scan,c5,cfg){');
 const levelCode=extract('function scalpLevels(sym,dir,entry,scan,c5,cfg){',
                         'function scalpCtx(sym,now){');
 const bars5=Array.from({length:75},(_,i)=>({
   t:now-(75-i)*300000,o:101.05,h:101.15,l:100.90,c:101.05,v:10
 }));
 bars5[74]={t:now-300000,o:100.95,h:101.35,l:100.90,c:101.30,v:12};
 const bars15=Array.from({length:60},(_,i)=>({
   t:now-(60-i)*900000,o:101.05,h:101.3,l:100.8,c:101.1,v:30
 }));
 const market=vm.createContext({
  Math,Date,Array,Object,
  SPREAD:{XAUUSD:0.1},
  ASSETS:{XAUUSD:{contractSz:100}},
  atr:()=>1,
  emaSeries:(candles,period)=>Array(candles.length).fill(period===9?101:100),
  rsi:closes=>closes.length===75?60:55,
  ema:(closes,period)=>period===20?101:100,
  kmrAdx:()=>({adx:25}),
  kmrTfBias:()=>null,
  bbAt:()=>({l:95,m:100,u:105}),
  kmrIstHour:()=>9,
  fmtP:(symbol,val)=>val.toFixed(2),
  ev2txt:()=>"(event in progress)"
 });
 vm.runInContext(realScanCode+'\n'+levelCode,market);
 const realScan=vm.runInContext('scalpScan',market);
 const liveCtx={now,events:[],isMetal:true,marketOpen:true,spread:0.1,dec:2,continuation:false};
 const disabled=realScan('XAUUSD',bars5,bars15,null,liveCtx);
 assert.equal(disabled.dir,null,'continuation disabled must not invent a trade');
 assert.equal(disabled.watch.dir,'BUY','trend watch should show conditional BUY only');
 assert(disabled.watch.level>101,'candidate must have a trigger level');
 const enabled=realScan('XAUUSD',bars5,bars15,null,{...liveCtx,continuation:true});
 assert.equal(enabled.dir,'BUY','retested EMA9 closed-candle continuation must qualify');
 assert.match(enabled.setup,/EMA9 continuation/);
 assert.equal(enabled.gatesOk,true,'preexisting news/spread/staleness gates still apply');
 const blockedNews=realScan('XAUUSD',bars5,bars15,null,
    {...liveCtx,continuation:true,events:[{ts:now,title:'High impact release'}]});
 assert.equal(blockedNews.dir,'BUY','indicator pattern still exists during news');
 assert.equal(blockedNews.gatesOk,false,'news gate must prohibit issuing an entry');
 const levels=vm.runInContext('scalpLevels',market);
 const rejected=levels('XAUUSD','BUY',101.3,enabled,bars5,
    {target:1,maxLoss:.5});
 assert(rejected.reject,'0.01 lot must be rejected when loss exceeds user max');
 const allowed=levels('XAUUSD','BUY',101.3,enabled,bars5,
    {target:1,maxLoss:4});
 assert(!allowed.reject && allowed.slUsd<=4,'valid setup must respect full max loss');
 assert(allowed.slDist<1,'experimental continuation stop can use actual local swing + buffer');
 const standard=levels('XAUUSD','BUY',101.3,{...enabled,strategyVersion:'v28-original'},bars5,
    {target:1,maxLoss:4});
 assert(!standard.reject && standard.slDist>=1,'original setup must retain its ATR stop model');
 const capped=levels('XAUUSD','BUY',101.3,enabled,bars5,{target:1,maxLoss:.7});
 assert(!capped.reject && capped.slUsd<=.7,'structural swing may fit strict max loss');
 const originalBlocked=levels('XAUUSD','BUY',101.3,{...enabled,strategyVersion:'v28-original'},bars5,
    {target:1,maxLoss:.7});
 assert(originalBlocked.reject,'original ATR stop cannot silently exceed strict loss cap');
 console.log('PASS closed-candle continuation opt-in, watch-only levels, news block, strict max loss and structural stop');

})().catch(e=>{console.error(e);process.exitCode=1;});
