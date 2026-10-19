'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const P=require('../src/main/resources/static/trading-core.js');
(async()=>{
 const engine=fs.readFileSync('src/main/resources/static/paper-engine.js','utf8');let time=100000,leases=0,releaseRestore,restores=0,basket=0;
 const ctx=vm.createContext({crypto:webcrypto,PaperMath:P,Date:{now:()=>time},prices:{},currentUser:{username:'recovery',role:'user'},
  riyanApi:async(path)=>{if(path.includes('/lease')){leases++;return{owned:true};}return[];},
  riyanProcessQueue:async()=>({pending:0}),localStorage:{getItem:()=>null},
  riyanRestore:()=>{restores++;return new Promise(r=>releaseRestore=r);},basketDbRestore:async()=>{basket++;return true;}});
 vm.runInContext(engine,ctx);
 const ready=ctx.paperHeartbeat();await new Promise(r=>setImmediate(r));assert.equal(restores,1);assert.equal(ctx.paperReady(),false);
 time+=11000;await ctx.paperHeartbeat();assert.equal(leases,2,'lease must renew while ledger restoration is stalled');
 assert.equal(restores,1,'no duplicate concurrent restorations');
 releaseRestore(true);await ready;assert.equal(ctx.paperReady(),true);assert.equal(basket,1);
 time+=31000;assert.equal(ctx.paperReady(),false,'readiness still expires');
 // Complete paginated owner snapshot is shared by signal and basket restoration.
 let calls=0;ctx.riyanApi=async()=>{calls++;return[{record_type:'low-profit',source_id:'one',payload:'{}'}];};
 ctx.paperLedgerCache=null;const [one,two]=await Promise.all([ctx.paperReadLedger(),ctx.paperReadLedger()]);assert.equal(calls,1);assert.equal(one,two);assert.equal(one['low-profit'].length,1);
 ctx.currentUser={username:'other',role:'user'};await ctx.paperReadLedger();assert.equal(calls,2,'cache is account scoped');
 ctx.currentUser={username:'guest',role:'guest'};await assert.rejects(ctx.paperReadLedger());
 // A blocked candle download must not enqueue the live BTC ticker behind it.
 let releaseHistory,requests=[];
 const btc=vm.createContext({PaperMath:P,Date,Map,Promise,setTimeout,
  liveFetch:async url=>{requests.push(url);if(url.includes('/candles'))return new Promise(r=>releaseHistory=r);return{ok:true,json:async()=>({price:'82500',time:new Date().toISOString()})};}});
 vm.runInContext(fs.readFileSync('src/main/resources/static/btc-feed.js','utf8'),btc);
 const history=btc.BtcFeed.candles('5m',1);await new Promise(r=>setImmediate(r));
 const quote=await btc.BtcFeed.ticker();assert.equal(quote.price,82500);assert(requests.some(x=>x.endsWith('/ticker')));
 releaseHistory({ok:true,json:async()=>[]});await history;
 // Boot loops are armed without waiting for historical providers to finish.
 const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
 const code=html.slice(html.indexOf('let appLoopsStarted=false;'),html.indexOf('// ── FOREGROUND CATCH-UP'));
 let timers=0,bootstraps=0;const boot=vm.createContext({evwBackgroundFeeds(){},evwBackgroundNews(){},scalpLoop(){},pick:()=>{},bootstrapAll:()=>{bootstraps++;return new Promise(()=>{});},setInterval:()=>timers++,setTimeout:()=>timers++,console});
 vm.runInContext(code,boot);await boot.bootApp();assert(timers>=8);await boot.bootApp();assert.equal(bootstraps,1,'only one set of loops');
 console.log('PASS lease renewal during blocked restore, full owner snapshot coalescing, guest isolation, ticker bypasses history queue and non-blocking single boot');
})().catch(e=>{console.error(e);process.exitCode=1;});
