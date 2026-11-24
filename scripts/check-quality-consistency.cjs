'use strict';
// Signal quality meter must agree with the entry verdict: a failed required gate can never
// read as an A+ score, factors vs safety gates are named separately, a missing live quote
// keeps the full gate read, and the metal quote poll lands right after a quote expires.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
const ctx=vm.createContext({Math,Date,SIG_TUNE:{},prices:{},quoteAt:{}});
vm.runInContext(html.slice(html.indexOf('const KMR_BLOCKED_SCORE_CAP'),html.indexOf('function waitCard(')),ctx);
vm.runInContext(html.slice(html.indexOf('function metalPollDelay('),html.indexOf('async function performMetalQuotes(')),ctx);
const keys=['htf','vol','adx','ext','spike','rsi','news','roll','volm','value','trigger','struct'];
const gates=fail=>keys.map(key=>({key,ok:!fail.includes(key),label:key+' label',wait:key+' wait'}));
const factors=Array.from({length:8},(_,i)=>({pass:i!==7,label:'f'+i}));
// BTC 2026-11-24 09:15Z: SELL, factors 95, NO CHASE failed (2.0x ATR below EMA20).
const btc={state:'WAIT',score:7,total:8,smart:{dir:'SELL',score:95,tier:null,gatesOk:false,gates:gates(['ext']),factors}};
let q=ctx.signalQuality(btc,'BTCUSD');
assert.equal(q.score,49);assert.equal(q.setupScore,95);assert.equal(q.label,'BLOCKED · NO CHASE');assert.notEqual(q.label,'A+ CLEAN');
assert.equal(q.block.reason,'ext label');assert.equal(q.chips.find(c=>c[0]==='NO CHASE')[1],'bad');
let meter=ctx.qualityMeterHtml(btc,'BTCUSD');
assert(meter.includes('49/100')&&meter.includes('blocked by NO CHASE')&&meter.includes('score 95/100')&&meter.includes('Waiting for:'));
assert.equal(ctx.qualityCountsText(btc,'BTCUSD'),'7/8 setup factors · 11/12 safety gates passed');
// XAU: 1H BULL vs 4H BEAR, no direction, so no factors and score 0.
const xau={state:'WAIT',score:9,total:12,smart:{dir:null,score:0,tier:null,gatesOk:false,gates:gates(['htf','value','trigger']),factors:[]}};
q=ctx.signalQuality(xau,'XAUUSD');assert.equal(q.score,0);assert.equal(q.label,'BLOCKED · HTF, VALUE, TRIGGER');assert(q.block.noDir);
assert(ctx.qualityMeterHtml(xau,'XAUUSD').includes('no trade direction yet'));
assert.equal(ctx.qualityCountsText(xau,'XAUUSD'),'9/12 safety gates passed · setup not scored (no direction)');
// XAG: quote missing keeps every gate chip and adds LIVE PRICE as a blocker.
const xag={state:'WAIT',quoteUnavailable:true,score:9,total:12,smart:{dir:null,score:0,tier:null,gatesOk:false,gates:gates(['htf','value','trigger']),factors:[]}};
q=ctx.signalQuality(xag,'XAGUSD');assert.equal(q.chips.length,14);assert.equal(q.chips.find(c=>c[0]==='LIVE PRICE')[1],'bad');
assert.match(q.label,/^BLOCKED · LIVE PRICE, HTF/);assert.equal(q.gatesOk,false);
// A fully passed HIGH setup is unchanged.
const ok={state:'BUY',score:8,total:8,smart:{dir:'BUY',score:88,tier:'HIGH',gatesOk:true,gates:gates([]),factors}};
q=ctx.signalQuality(ok,'XAUUSD');assert.equal(q.score,88);assert.equal(q.label,'A+ CLEAN');assert.equal(q.block,null);
// Even with all gates passed, a quote outage blocks and caps.
q=ctx.signalQuality({...ok,quoteUnavailable:true},'XAUUSD');assert.equal(q.gatesOk,false);assert.equal(q.score,49);
// Metal poll: still 8 s normally, pulled in to just after expiry, never under 2 s.
const now=1e12;ctx.quoteAt.XAUUSD=now-5000;ctx.quoteAt.XAGUSD=now-5000;assert.equal(ctx.metalPollDelay(now),8000);
ctx.quoteAt.XAGUSD=now-27000;assert.equal(ctx.metalPollDelay(now),4500);
ctx.quoteAt.XAGUSD=now-31000;assert.equal(ctx.metalPollDelay(now),2000);
ctx.quoteAt.XAGUSD=now-60000;ctx.quoteAt.XAUUSD=0;assert.equal(ctx.metalPollDelay(now),8000,'long outages keep the old cadence');
// Freshness gate itself is unchanged.
assert(fs.readFileSync('src/main/resources/static/paper-engine.js','utf8').includes('Date.now()-(quoteAt[sym]||0)<30000'));
assert.equal(ctx.signalQuality(btc,'BTCUSD').cap,vm.runInContext('KMR_BLOCKED_SCORE_CAP',ctx),'meter cap and manual-plan cap agree');
console.log('PASS blocked score cap, gate/factor counts, quote-blocker chips, unchanged HIGH setup, metal poll timing');
