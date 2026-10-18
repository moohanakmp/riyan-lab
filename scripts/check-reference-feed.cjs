'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const PaperMath=require('../src/main/resources/static/trading-core.js');
const code=fs.readFileSync('src/main/resources/static/reference-feed.js','utf8');
const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
const now=Math.floor(Date.now()/14400000)*14400000;
function data(sym='GC=F',interval='15m',count=96,ms=900000){
 const q={open:[],high:[],low:[],close:[],volume:[]},timestamp=[];
 for(let i=0;i<count;i++){
  timestamp.push((now-(count-i)*ms)/1000);
  q.open.push(100+i/100);q.high.push(102+i/100);q.low.push(99+i/100);q.close.push(101+i/100);q.volume.push(100+i);
 }
 return {chart:{error:null,result:[{meta:{symbol:sym,instrumentType:'FUTURE',dataGranularity:interval},timestamp,indicators:{quote:[q]}}]}};
}
function feed(fetcher){const ctx=vm.createContext({PaperMath,Date,Map,Error,encodeURIComponent,liveFetch:fetcher});vm.runInContext(code,ctx);return ctx.ReferenceFeed;}
function extract(start,end){const a=html.indexOf(start),b=html.indexOf(end,a+start.length);assert(a>=0&&b>a,start);return html.slice(a,b);}
const F=feed(()=>{throw Error('Unexpected network')});
(async()=>{
 for(const sym of F.symbols){
  const spec=F.info(sym),bars=F.normalize(data(spec.ticker),sym,'15m',now+1001);
  assert.equal(bars.length,96,sym);assert(bars.every(PaperMath.valid));assert(bars.every(k=>k.analysisOnly));
  assert.equal(bars[0].v,100,'volume stays in futures contracts');
  if(spec.inverse){assert.equal(bars[0].h,1/99);assert.equal(bars[0].l,1/102);assert.equal(bars[0].c,1/101);}
 }
 assert.throws(()=>F.url('DOGEUSD','15m'));assert.throws(()=>F.url('XAUUSD','2m'));
 const raw=data(),r=raw.chart.result[0],q=r.indicators.quote[0];
 for(const p of ['open','high','low','close'])q[p][3]=null;
 q.volume[4]=null;q.volume[5]=0;
 const bars=F.normalize(raw,'XAUUSD','15m',now+1001);
 assert.equal(bars.length,95,'closed-market slots are not fabricated');
 assert.equal(bars.find(k=>k.t===r.timestamp[4]*1000).v,null,'unreported volume stays null');
 assert.equal(bars.find(k=>k.t===r.timestamp[5]*1000).v,0,'zero volume is real zero');
 const forming=data();forming.chart.result[0].timestamp[95]=now/1000;
 assert.equal(F.normalize(forming,'XAUUSD','15m',now+1001).length,95,'forming bars excluded');
 for(const mutate of [
  d=>d.chart.result[0].meta.symbol='SI=F',d=>d.chart.result[0].meta.dataGranularity='1d',
  d=>d.chart.result[0].indicators.quote[0].high[0]=1,
  d=>d.chart.result[0].indicators.quote[0].volume[0]=-1,
  d=>d.chart.result[0].indicators.quote[0].close.pop(),
  d=>d.chart.result[0].timestamp[0]=(now+120000)/1000,
  d=>d.chart.error={code:'Not Found'}
 ]){const bad=data();mutate(bad);assert.throws(()=>F.normalize(bad,'XAUUSD','15m',now+1001));}
 const fragment=data();fragment.chart.result[0].timestamp[0]+=1;assert.equal(F.normalize(fragment,'XAUUSD','15m',now+1001).length,95,'off-grid quote snapshots are not complete candles');
 const duplicate=data();duplicate.chart.result[0].timestamp[1]=duplicate.chart.result[0].timestamp[0];
 assert.throws(()=>F.normalize(duplicate,'XAUUSD','15m',now+1001),/Conflicting/);
 const hours=data('GC=F','60m',12,3600000);
 assert.equal(F.normalize(hours,'XAUUSD','4h',now+1001).length,3);
 for(const p of ['open','high','low','close'])hours.chart.result[0].indicators.quote[0][p][1]=null;
 assert.equal(F.normalize(hours,'XAUUSD','4h',now+1001).length,2,'incomplete aggregation dropped');
 assert(F.normalize(hours,'XAUUSD','4h',now+1001).every(k=>k.analysisOnly),'reference provenance survives aggregation');
 const day=data('GC=F','1d',3,86400000);day.chart.result[0].timestamp=day.chart.result[0].timestamp.map(t=>t-20*3600);
 assert.equal(F.normalize(day,'XAUUSD','1d',now+1001).length,3,'session-aligned daily bars supported');
 console.log('PASS four metals and seven major FX mappings, inverse OHLC, real volume, null slots, forming bars, malformed payloads and complete aggregation');
 let calls=0;
 const cacheFeed=feed(async()=>{calls++;return {ok:true,json:async()=>data()};});
 const [one,two]=await Promise.all([cacheFeed.candles('XAUUSD','15m',20),cacheFeed.candles('XAUUSD','15m',60)]);
 assert.equal(calls,1,'concurrent requests share provider fetch');assert.equal(one.length,20);assert.equal(two.length,60);
 one[0].c=999;assert.notEqual((await cacheFeed.candles('XAUUSD','15m',20))[0].c,999,'callers cannot corrupt cache');
 let fails=true;const recovery=feed(async()=>({ok:!fails,status:503,json:async()=>fails?{upstreamStatus:429}:data()}));
 await assert.rejects(recovery.candles('XAUUSD','15m'),/429/);fails=false;assert((await recovery.candles('XAUUSD','15m')).length>0);
 console.log('PASS request coalescing, isolated cache, HTTP errors and recovery');
 // Actual app data paths: all live providers fail; both metals must recover for all frames.
 const sourceBars=F.normalize(data(),'XAUUSD','15m',now+1001);
 const ctx=vm.createContext({PaperMath,Date,Math,console,ReferenceFeed:{info:sym=>({source:sym+' delayed futures'}),candles:async(sym,iv)=>sourceBars.map(k=>({...k,ms:iv==='5m'?300000:900000}))},
  ASSETS:{XAUUSD:{},XAGUSD:{},BTCUSD:{isCrypto:true}},CANDLE_LIMIT:700,
  ohlcData:{XAUUSD:{},XAGUSD:{},BTCUSD:{}},prices:{XAUUSD:4000,XAGUSD:50},dayOpen:{},
  scalpState:{XAUUSD:{},XAGUSD:{},BTCUSD:{}},BtcFeed:{candles:async()=>[{btc:true}]},
  fetchBinanceKlines:async()=>{throw Error('451');},liveFetch:async()=>({ok:false,status:503}),
  document:{getElementById:()=>null},SYMS:[],getCandles:sym=>ctx.ohlcData[sym]['15m']||[]});
 vm.runInContext(extract('function aggregate15m(', 'async function loadCandles(')+extract('const FAPI_SYM=', 'function buildMetalC('),ctx);
 for(const sym of ['XAUUSD','XAGUSD']){
  assert.equal(await vm.runInContext('fetchMetalOHLC',ctx)(sym),true);
  for(const iv of ['15m','1h','4h'])assert(ctx.ohlcData[sym][iv].length>0,iv);
  assert.equal(ctx.ohlcData[sym]['15m'][0].o,sourceBars[0].o,'reference must not be scaled to spot');
  const len=ctx.ohlcData[sym]['15m'].length;
  vm.runInContext('appendLiveTick',ctx)(sym,999);
  assert.equal(ctx.ohlcData[sym]['15m'].length,len,'spot ticks must not extend reference history');
 }
 vm.runInContext(extract('async function scalpFetch(', '// Use provider 15m'),ctx);
 for(const sym of ['XAUUSD','XAGUSD']){
  const low=await vm.runInContext('scalpFetch',ctx)(sym,300);assert(low.length>60);assert(low.every(k=>k.analysisOnly));
  assert.equal(ctx.scalpState[sym].referenceOnly,true);assert.match(ctx.scalpState[sym].feedSource,/delayed/);
 }
 vm.runInContext(extract('let flowFetchError={};','// Checks whether two'),ctx);
 for(const sym of ['XAUUSD','XAGUSD']){
  const sources=vm.runInContext('flowSources',ctx)(sym);
  const flow=await vm.runInContext('pagedKlines',ctx)(sources,'15m',3);
  assert(flow.candles.length>60);assert.match(flow.src,/delayed/);
 }
 const btcFlow=await vm.runInContext('pagedKlines',ctx)(vm.runInContext('flowSources',ctx)('BTCUSD'),'15m',1);
 assert(btcFlow.candles[0].btc,'BTC still uses Coinbase');
 console.log('PASS metal bootstrap, all timeframes, Low Profit, Flow/Research routing, no spot rebasing and unchanged BTC route');
 // Main/Manual must not confirm reference data, regardless of indicator score.
 Object.assign(ctx,{kmrClosed:PaperMath.closed,marketTrend:{},kmrScan:()=>({tier:'HIGH',gatesOk:true}),prices:{XAUUSD:101},KMR_VOL_SOURCE:{XAUUSD:"Reference futures"}});
 vm.runInContext(extract('function computeSignal(', '// ── Manual / Analytics'),ctx);
 const scan=vm.runInContext('computeSignal',ctx)('XAUUSD');assert.equal(scan.state,'WAIT');assert.equal(scan.referenceOnly,true);assert.equal(scan.lot,0);assert.equal(scan.smart.tier,null);
 vm.runInContext(extract('function runManualAnalysis(', '// ── Trader'),ctx);
 assert.equal(vm.runInContext('runManualAnalysis',ctx)('XAUUSD').ready,false);
 let opened=0;
 Object.assign(ctx,{scalpHist:[],scalpData:{XAUUSD:sourceBars},scalpCfg:{auto:true,assets:{XAUUSD:true},goal:10,dayStop:8},
  scalpScan:()=>({dir:'BUY',gatesOk:true,A:1,price:101,barT:now-300000}),scalpClosed15m:()=>[],scalpCtx:()=>({}),
  scalpLevels:()=>({}),scalpToday:()=>({}),paperReady:()=>true,freshQuote:()=>true,basketDemo:{enabled:false},scalpOpen:()=>opened++});
 vm.runInContext(extract('function scalpEvaluate(sym){','async function scalpOpen('),ctx);
 vm.runInContext('scalpEvaluate',ctx)('XAUUSD');assert.equal(opened,0);assert.match(ctx.scalpState.XAUUSD.block,/Delayed futures/);
 ctx.scalpData.XAUUSD=sourceBars.map(k=>({...k,analysisOnly:false}));ctx.ohlcData.XAUUSD={};
 vm.runInContext('scalpEvaluate',ctx)('XAUUSD');assert.equal(opened,1,'eligible original live scalp still opens');
 let settled=0;
 Object.assign(ctx,{scalpHist:[{status:'OPEN',sym:'XAUUSD',t:1,lastBar:0}],scalpData:{XAUUSD:sourceBars},scalpCheckRange:()=>settled++,saveScalpHist:()=>{}});
 vm.runInContext(extract('function scalpCandleCheck(){','async function scalpLoop(){'),ctx);
 vm.runInContext('scalpCandleCheck()',ctx);assert.equal(settled,0,'reference candles cannot alter actual paper P&L');
 ctx.scalpData.XAUUSD=[{...sourceBars[0],analysisOnly:false}];vm.runInContext('scalpCandleCheck()',ctx);assert.equal(settled,1,'existing live settlement still works');
 const basket=fs.readFileSync('src/main/resources/static/basket-demo.js','utf8');
 ctx.scalpData.XAUUSD=sourceBars;ctx.basketDemo.active={sym:'XAUUSD',dir:'BUY',createdAt:1,positions:[{openedAt:1,sl:1000}]};
 ctx.basketClose=()=>settled++;
 vm.runInContext(basket.slice(basket.indexOf('function basketCandleCheck(){'),basket.indexOf('function basketManage(){')),ctx);
 vm.runInContext('basketCandleCheck()',ctx);assert.equal(settled,1,'reference candles cannot close a basket');
 console.log('PASS reference auto/manual/scalp entry rejection, scalp/basket P&L isolation and preserved live entry/settlement');
})().catch(e=>{console.error(e);process.exitCode=1;});
