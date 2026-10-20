'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {extract}=require('../src/main/resources/background/scanner.cjs');
const now=Date.now(),bar=Math.floor(now/900000)*900000-900000;
const gates=['htf','vol','adx','ext','spike','rsi','news','roll','volm','value','trigger','struct'].map(key=>({key,ok:true,label:key}));
const smart={dir:'SELL',tier:'MED',gatesOk:true,score:83,price:4146.6,atrV:2,e20:4147.31,structure:{H:[{p:4149}],L:[{p:4135}]},gates};
const sig={state:'SELL',confidence:'MED',lot:.01,price:4146.6,atrVal:2,smart,conditions:[],score:5,total:8,candles:[{t:bar}],sr:{H:[],L:[]}};
(async()=>{
 const limits=vm.createContext({});vm.runInContext(extract('CAPITAL','const'),limits);assert.equal(vm.runInContext('MAX_RISK_USD',limits),4,'Manual risk caption matches the server account limit');
 const c=vm.createContext({Date,Math,console,SYMS:['XAUUSD'],currentUser:{username:'u',role:'user'},prices:{XAUUSD:4146.6},
  signalHistory:[],scalpHist:[],basketDemo:{enabled:false,active:null},paperEngine:{reason:'Paper engine active'},paperReady:()=>true,freshQuote:()=>true,calendarReady:()=>true,isMetalsMarketOpen:()=>true,
  activeSignals:{},sigCooldown:{},lastSigCandleTs:{},lastGuardToast:{},signalEntryPending:{},signalEntryStatus:{},
  computeSignal:()=>sig,getCandles:()=>[],PaperMath:{closed:x=>x},volSpike:{},computeVolSpike:()=>null,recordHourSample(){},saveSigMeta(){},atr:()=>2,
  calcPos:()=>({volLevel:'green',atrPct:.1}),showToast(){},CAPITAL:100});
 vm.runInContext(['ASSETS','SPREAD'].map(n=>extract(n,'const')).join('\n')+'\n'+['fmtP','istDayKey','kmrTradePlan','paperAccountRisk','autoEntryCheck','evaluateSignals','signalQuality','qualityMeterHtml','riyanRepairManualPlans'].map(n=>extract(n)).join('\n'),c);
 const approval=c.autoEntryCheck('XAUUSD',sig);assert(approval.ok);assert(approval.risk.planned<=4);assert.equal(approval.plan.sl,4149.6);
 const quality=c.signalQuality(sig,'XAUUSD');assert.equal(quality.score,83);assert.equal(quality.gatesOk,true);assert.equal(quality.chips.length,13,'all 12 gates and direction are visible');
 for(const label of ['RSI','STRUCTURE','NO SPIKE','ROLLOVER','VOLATILITY'])assert(quality.chips.some(x=>x[0]===label));
 const wide={...sig,smart:{...smart,atrV:5,structure:{H:[{p:4156}],L:[]}}};
 const rejected=c.autoEntryCheck('XAUUSD',wide);assert(!rejected.ok);assert.match(rejected.reason,/Structural stop needs.*account limit/);assert(rejected.plan.sl>4156,'wide structural stop is never clipped');
 const badGate={...sig,smart:{...smart,gatesOk:false,tier:null,gates:gates.map(g=>g.key==='rsi'?{...g,ok:false}:g)}};
 assert.equal(c.signalQuality(badGate,'XAUUSD').gatesOk,false);
 let requests=0,release;
 c.recordSignal=()=>{requests++;return new Promise(r=>release=r);};
 c.evaluateSignals();c.evaluateSignals();assert.equal(requests,1,'in-flight entry cannot duplicate');assert.equal(c.lastSigCandleTs.XAUUSD,undefined,'candle is not consumed before acceptance');
 release(false);await new Promise(r=>setImmediate(r));assert.equal(c.lastSigCandleTs.XAUUSD,undefined);
 c.evaluateSignals();assert.equal(requests,2,'same valid candle retries after failed submission');release(true);await new Promise(r=>setImmediate(r));
 assert.equal(c.lastSigCandleTs.XAUUSD,bar);c.evaluateSignals();assert.equal(requests,2,'accepted candle stays deduplicated');
 c.signalHistory=[{sym:'XAUUSD',dir:'BUY',price:4100,sl:4098,posUnits:1,outcome:'OPEN'}];
 assert.match(c.autoEntryCheck('XAUUSD',{...sig,candles:[{t:bar+1}]}).reason,/Combined open risk/);
 c.signalHistory=[{sym:'XAUUSD',outcome:'LOSS',closedAt:now,pnlUsd:-8}];assert.match(c.autoEntryCheck('XAUUSD',{...sig,candles:[{t:bar+1}]}).reason,/daily loss/);
 c.signalHistory=[];c.paperReady=()=>false;assert.equal(c.autoEntryCheck('XAUUSD',sig).ok,false);
 // Preserve read-only plans while repairing this exact historical queue bug; real trades stay trades.
 const records=new Map(),payload=JSON.stringify({source:'manual-analysis',ready:true,plan:{entry:4146,sl:4150}}),trade=JSON.stringify({source:'manual-analysis',accountingVersion:2,status:'OPEN'});
 records.set('riyan_pending_u',JSON.stringify({plan:{type:'manual-signals',id:'old-plan',value:payload},trade:{type:'manual-signals',id:'real-trade',value:trade}}));
 records.set('riyan_failed_u',JSON.stringify({plan2:{type:'manual-signals',id:'failed-plan',value:payload,error:'HTTP 409'}}));
 c.localStorage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v)};c.riyanRepairManualPlans('u');
 const pending=JSON.parse(records.get('riyan_pending_u')),failed=JSON.parse(records.get('riyan_failed_u'));
 assert.equal(Object.values(pending).filter(r=>r.type==='manual-plans').length,2);assert.equal(pending.trade.value,trade);assert.equal(Object.keys(failed).length,0);
 assert(Object.values(pending).filter(r=>r.type==='manual-plans').every(r=>r.value===payload&&r.id.startsWith('u:')));c.riyanRepairManualPlans('u');assert.equal(Object.keys(JSON.parse(records.get('riyan_pending_u'))).length,3,'repair is idempotent');
 // Accepted server record survives optional UI/notification errors.
 c.console={warn(){}};c.paperReady=()=>true;c.paperSaveEntry=async()=>true;c.saveSignal=async()=>{};c.saveSigMeta=async()=>{};c.fireAlert=()=>{throw Error('optional alert failure');};c.marketEvidenceSnapshot=()=>null;c.ICONS={XAUUSD:'Gold'};
 vm.runInContext(extract('recordSignal'),c);assert.equal(await c.recordSignal('XAUUSD',sig,{sl:4149.6,tp:4137,tp1:4143.6,tp2:4140.6,tp3:4137,posUnits:1,lot:.01},false),true);assert(c.activeSignals.XAUUSD);
 // Periodic refresh must preserve expanded pattern/structure panels and keyboard focus.
 const detail=(sym,key,open)=>({dataset:{evidenceSymbol:sym,evidenceSection:key},open,querySelector:()=>({focus:()=>{focused=true;}})});
 let focused=false,live=[detail('XAUUSD','patterns',true),detail('BTCUSD','patterns',false)];
 let chart={scrollLeft:0,scrollWidth:960,clientWidth:300};
 const previous=live[0],el={querySelectorAll:q=>q==='.delta-chart-scroll'?[chart]:live,set innerHTML(v){chart={scrollLeft:0,scrollWidth:980,clientWidth:300};live=[detail('XAUUSD','patterns',false),detail('BTCUSD','patterns',true)];}};
 c.document={activeElement:{closest:()=>previous}};vm.runInContext(extract('setEvidenceHtml'),c);c.setEvidenceHtml(el,'fresh quotes');
 assert.equal(chart.scrollLeft,0,'manual history scroll survives refresh');chart.scrollLeft=680;c.setEvidenceHtml(el,'next');assert.equal(chart.scrollLeft,980,'latest view remains pinned right');
 assert.equal(live[0].open,true);assert.equal(live[1].open,false);assert.equal(focused,true);
 console.log('PASS 83/100 technical setup, all 12 gates, exact risk blockers, preserved structural stops, account limits, in-flight dedup, rejected-candle retry, accepted-only consumption, manual-plan queue preservation and post-acceptance alert failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
