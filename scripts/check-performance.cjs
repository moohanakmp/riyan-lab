'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{performance}=require('node:perf_hooks');
const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
function extract(a,b){const i=html.indexOf(a),j=html.indexOf(b,i);assert(i>=0&&j>i);return html.slice(i,j);}
function fixture(){
 const values=new Map();let reads=0,writes=0;
 const ctx=vm.createContext({currentUser:{username:'bench',role:'user'},console:{warn(){}},riyanFingerprint:s=>s,
  localStorage:{getItem:k=>{reads++;return values.get(k)||null;},setItem:(k,v)=>{writes++;values.set(k,v);}}});
 vm.runInContext(extract('function riyanQueue(type,id,obj){','let riyanSyncing='),ctx);
 return {ctx,values,counts:()=>({reads,writes})};
}
(async()=>{
 const f=fixture(),items=Array.from({length:1000},(_,i)=>({type:'low-profit',id:String(i),obj:{id:i,status:'CLOSED',reason:'performance fixture',pnl:1}}));
 const t=performance.now();f.ctx.riyanQueueMany(items);const elapsed=performance.now()-t;
 assert.deepEqual(f.counts(),{reads:2,writes:1});
 assert.equal(Object.keys(JSON.parse(f.values.get('riyan_pending_bench'))).length,1000,'all records are durable before return');
 f.ctx.riyanQueueMany(items);assert.equal(f.counts().writes,1,'unchanged pending records do not rewrite storage');
 f.ctx.riyanQueue('low-profit','1',{id:1,status:'CLOSED',pnl:2});assert.equal(JSON.parse(f.values.get('riyan_pending_bench'))['low-profit|1'].value,'{"id":1,"status":"CLOSED","pnl":2}');
 const bad={};bad.self=bad;f.ctx.riyanQueueMany([{type:'analysis',id:'bad',obj:bad},{type:'analysis',id:'valid',obj:{ok:true}}]);
 assert(JSON.parse(f.values.get('riyan_pending_bench'))['analysis|valid'],'one malformed record must not discard other records');
 f.ctx.currentUser={username:'other',role:'user'};f.ctx.riyanQueue('analysis','own',{ok:true});
 assert.equal(Object.keys(JSON.parse(f.values.get('riyan_pending_other'))).length,1,'owners remain isolated');
 f.ctx.currentUser={username:'guest',role:'guest'};f.ctx.riyanQueueMany(items);assert(!f.values.has('riyan_pending_guest'));
 const sent=fixture();sent.values.set('riyan_sent_bench',JSON.stringify({'analysis|done':JSON.stringify({ok:true})}));
 sent.ctx.riyanQueue('analysis','done',{ok:true});assert.equal(sent.counts().writes,0,'acknowledged payload is not requeued');
 console.log('PASS 1,000 durable records: '+elapsed.toFixed(1)+' ms; 2 reads / 1 write; dedup, updates, malformed records, owner and guest isolation');
 for(const [start,end,name] of [
  ['let ohlcSyncPromise=null;','async function performOhlcSync(){','resyncOHLC'],
  ['let metalQuotePromise=null;','async function performMetalQuotes(){','fetchLiveMetals']]){
  let calls=0,release;
  const ctx=vm.createContext({performOhlcSync:()=>{calls++;return new Promise(r=>{release=r;});},performMetalQuotes:()=>{calls++;return new Promise(r=>{release=r;});}});
  vm.runInContext(extract(start,end),ctx);
  const a=ctx[name](),b=ctx[name]();assert.equal(a,b);assert.equal(calls,1);release();await a;
  const c=ctx[name]();assert.equal(calls,2);release();await c;
  // Failure must release the slot and permit recovery.
  ctx.performOhlcSync=ctx.performMetalQuotes=()=>Promise.reject(Error('offline'));
  await assert.rejects(ctx[name]());
  ctx.performOhlcSync=ctx.performMetalQuotes=()=>Promise.resolve();await ctx[name]();
 }
 let releaseNews,newsCalls=0;
 const a=vm.createContext({Date,analysisAsset:'XAUUSD',analysisCache:{},analysisLoading:{},ANALYSIS_CACHE_MS:60000,
  computeMTFTrend(){},renderAnalysis(){},fetchNews:()=>{newsCalls++;return new Promise(r=>{releaseNews=r;});},fetchEconCalendar:async()=>[],
  recordHeadlines(){},currentUser:null,console:{warn(){}}});
 vm.runInContext(extract('async function refreshAnalysis(force){','// ═══ P&L DASHBOARD'),a);
 const first=a.refreshAnalysis(false);await a.refreshAnalysis(false);assert.equal(newsCalls,1);releaseNews([]);await first;
 a.fetchNews=async()=>{throw Error('offline');};await a.refreshAnalysis(true);assert.equal(a.analysisLoading.XAUUSD,false);
 a.fetchNews=async()=>[];await a.refreshAnalysis(true);assert.equal(a.analysisLoading.XAUUSD,false);
 const events=[],pending=[];
 const boot=vm.createContext({Promise,fetchLiveCrypto:()=>{events.push('crypto');return Promise.resolve();},fetchLiveMetals:()=>{events.push('metals');return Promise.resolve();},
  loadCandles:()=>{events.push('history');return new Promise(r=>pending.push(r));},fetchMetalOHLC:()=>{events.push('history');return new Promise(r=>pending.push(r));},
  setSbar(){},calibrateMetal(){},Date,renderFeedStatus(){},SYMS:[],freshQuote:()=>false,signalHistory:[],evaluateSignals(){},document:{getElementById:()=>({style:{display:'none'}})}});
 vm.runInContext(extract('async function bootstrapAll(){','async function manualRefresh(){'),boot);
 const startup=boot.bootstrapAll();assert.deepEqual(events.slice(0,2),['crypto','metals'],'prices start before history completes');pending.forEach(r=>r());await startup;
 console.log('PASS shared refresh success/failure recovery, analysis request coalescing/retry and non-blocking quote startup');
})().catch(e=>{console.error(e);process.exitCode=1;});
