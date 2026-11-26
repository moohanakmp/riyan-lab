'use strict';
// 4H-led direction: a flat 1H (EMA20/50 within 0.2 ATR) no longer vetoes a clear 4H trend,
// but the 15m structure must confirm it and the setup is capped at MED. Indicators are
// stubbed so only the direction/gate/tier rules are under test.
const assert=require('node:assert/strict'),vm=require('node:vm');
const {extract}=require('../src/main/resources/background/scanner.cjs');
const bars=n=>Array.from({length:n},(_,i)=>({t:i*900000,o:100,h:100.6,l:99.4,c:100,v:100}));
const ctx=vm.createContext({Math,Number,MarketContext:undefined});
vm.runInContext(extract('SIG_TUNE','const')+'\n'+['ema','atr','kmrTfFlat','kmrSmartScan','ev2txt'].map(n=>extract(n)).join('\n'),ctx);
// Real ema/atr feed kmrTfFlat; the 15m engine helpers are stubbed to a clean, passing setup.
function setup({b1,b4,flat,st,dir}){
 Object.assign(ctx,{
  kmrTfBias:c=>c.tag==='1h'?b1:b4,atr:()=>0.3,
  kmrTfFlat:c=>c.tag==='1h'?{flat,gap:flat?0.05:0.9}:{flat:false,gap:1},
  rsi:()=>dir==='SELL'?42:58,macd:()=>({hist:dir==='SELL'?-1:1,prevHist:0}),kmrAdx:()=>({adx:28,pdi:dir==='SELL'?10:30,mdi:dir==='SELL'?30:10}),
  kmrStructure:()=>({state:st,H:[],L:[]}),kmrVolumePressure:()=>({ok:true,buyPct:dir==='SELL'?35:65,sellPct:dir==='SELL'?65:35,obvUp:dir!=='SELL',divergence:null}),kmrSweep:()=>true});
 const c=bars(80);const last=c.at(-1);
 if(dir==='SELL')Object.assign(last,{o:100.3,c:99.9,h:100.35,l:99.85});else Object.assign(last,{o:99.7,c:100.1,h:100.15,l:99.65});
 const h1=Object.assign(bars(60),{tag:'1h'}),h4=Object.assign(bars(60),{tag:'4h'});
 return ctx.kmrSmartScan(c,h1,h4,{tune:vm.runInContext('SIG_TUNE.XAUUSD',ctx),obs:[],events:[],newsReady:true,now:Date.now(),istHour:12,isMetal:true,dec:2});
}
let s=setup({b1:'BULL',b4:'BEAR',flat:false,st:'BEAR',dir:'SELL'});
assert.equal(s.dir,null,'a real 1H uptrend still vetoes a 4H downtrend');assert.match(s.reason,/no clear higher-timeframe direction/);
s=setup({b1:'BULL',b4:'BEAR',flat:true,st:'BEAR',dir:'SELL'});
assert.equal(s.dir,'SELL','flat 1H lets the clear 4H lead');assert.equal(s.led4h,true);
assert.match(s.gates[0].label,/4H BEAR leads — 1H is flat/);
assert(s.gates.some(g=>g.key==='lead15'&&g.ok),'15m lower highs and lows confirm');
assert.equal(s.gatesOk,true,s.reason);assert.equal(s.tier,'MED','4H-led setups are capped at MED even at score '+s.score);
assert(s.factors.some(f=>f.label==='1H trend flat — 4H leads'&&f.pts===0),'no 1H points when it is flat');
s=setup({b1:'BULL',b4:'BEAR',flat:true,st:'MIXED',dir:'SELL'});
assert.equal(s.tier,null,'mixed 15m structure does not confirm the 4H');assert.match(s.reason,/does not yet confirm the 4H/);
s=setup({b1:'BEAR',b4:'BULL',flat:true,st:'BULL',dir:'BUY'});assert.equal(s.dir,'BUY','mirrored BUY');assert.equal(s.led4h,true);
s=setup({b1:'BULL',b4:'NEUTRAL',flat:true,st:'BULL',dir:'BUY'});assert.equal(s.dir,null,'a neutral 4H cannot lead');
s=setup({b1:'BEAR',b4:'BEAR',flat:true,st:'BEAR',dir:'SELL'});assert.equal(s.led4h,false,'agreeing timeframes keep the normal path');
assert(!s.gates.some(g=>g.key==='lead15'));
// Real kmrTfFlat on real numbers: flat when EMA20/50 sit close, not when they are far apart.
const flatRun=Array.from({length:120},(_,i)=>({t:i,o:100,h:101,l:99,c:100+(i%2?0.2:-0.2)}));
const real=vm.createContext({Math,Number});vm.runInContext(['ema','atr','kmrTfFlat'].map(n=>extract(n)).join('\n'),real);
assert.equal(real.kmrTfFlat(flatRun).flat,true,'sideways closes are flat');
const trend=Array.from({length:120},(_,i)=>({t:i,o:100+i,h:101+i,l:99+i,c:100.5+i}));
assert.equal(real.kmrTfFlat(trend).flat,false,'a steady trend is not flat');
assert.equal(real.kmrTfFlat(trend.slice(0,40)),null,'short history is never called flat');
console.log('PASS 4H leads only when 1H is flat, 15m must confirm, capped at MED, mirrored, neutral 4H and real 1H trend still veto');
