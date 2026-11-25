'use strict';
// 2026-11-25 review: Auto/manual SL/TP also checked on closed 5m bars (wicks), and the metal
// spot/perp basis is measured against the 1m perp bar next to the quote (not the last 15m close).
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const PM=require('../src/main/resources/static/trading-core.js');
const html=fs.readFileSync(__dirname+'/../src/main/resources/static/index.html','utf8');
function extract(start,end){const a=html.indexOf(start),b=html.indexOf(end,a+start.length);assert(a>=0&&b>a,start);return html.slice(a,b);}
const T=Date.UTC(2026,10,25,9,0),M=60000,F=300000;
const trade=over=>({sym:'XAUUSD',dir:'BUY',price:4000,sl:3997,tp1:4003,tp2:4005,tp:4008,ts:T,posUnits:1,spreadPerUnit:0,outcome:'OPEN',...over});

// ── PaperMath.candle: adverse path first ──
let r=trade();PM.candle(r,{t:T,o:4000,h:4001,l:3996,c:4000.5});
assert.equal(r.outcome,'LOSS');assert.equal(r.exitPrice,3997,'wick through the stop fills at the stop');
r=trade();PM.candle(r,{t:T,o:3995,h:3999,l:3994,c:3998});
assert.equal(r.exitPrice,3995,'a gap through the stop fills at the open');
r=trade();PM.candle(r,{t:T,o:4000,h:4004,l:3999,c:4002});
assert.equal(r.tp1Hit,true);assert.equal(r.outcome,'OPEN');assert.equal(r.slNow,4000,'TP1 by wick moves stop to break-even');
r=trade();PM.candle(r,{t:T,o:4000,h:4009,l:3996,c:4001});
assert.equal(r.outcome,'LOSS','stop and target in one bar: stop first (conservative)');
r=trade({dir:'SELL',sl:4003,tp1:3997,tp2:3995,tp:3992});PM.candle(r,{t:T,o:4000,h:4004,l:3999,c:4000});
assert.equal(r.outcome,'LOSS');assert.equal(r.exitPrice,4003);
assert.equal(PM.candle(trade(),{t:T,o:4000,h:3990,l:4010,c:4000}),false,'invalid bar ignored');

// ── autoWickCheck: only closed bars after entry, each bar once ──
const ctx=vm.createContext({PaperMath:PM,Math,scalpData:{XAUUSD:[]}});
vm.runInContext(extract('function autoWickCheck(','async function checkOutcome('),ctx);
const wick=vm.runInContext('autoWickCheck',ctx);
ctx.scalpData.XAUUSD=[{t:T-F,o:4000,h:4000,l:3990,c:3995},{t:T,o:4000,h:4004,l:3999,c:4002},{t:T+F,o:4002,h:4002,l:4000.5,c:4001},{t:T+2*F,o:4001,h:4001,l:3990,c:3991,complete:false}];
r=trade();
assert.equal(wick(r,T+2*F+1000),true);
assert.equal(r.tp1Hit,true,'bar before entry ignored; TP1 bar applied');
assert.equal(r.outcome,'OPEN','forming bar ignored; the next bar did not reach break-even');
assert.equal(r.wickCheckedTo,T+2*F);
assert.equal(wick(r,T+2*F+2000),false,'same bars are not applied twice');
r=trade({ts:T+30000});wick(r,T+3*F);assert.equal(r.wickCheckedTo,T+2*F,'bar that contains the entry is skipped');

// ── Metal basis from the 1m perp bar next to the quote ──
const b=vm.createContext({prices:{XAUUSD:4010},quoteAt:{XAUUSD:T+65000},metalRef:{XAUUSD:{t:T,c:4012}},metalBasis:{XAUUSD:{f:1}},Math});
vm.runInContext(extract('function metalBasisFactor(','function calibrateMetal('),b);
const factor=vm.runInContext('metalBasisFactor',b);
assert.ok(Math.abs(factor('XAUUSD',T+70000)-4010/4012)<1e-12,'spot / 1m perp close');
b.metalRef.XAUUSD={t:T-10*M,c:4000};assert.equal(factor('XAUUSD',T+70000),null,'stale 1m bar is not used');
b.metalRef.XAUUSD={t:T,c:4012};b.metalBasis.XAUUSD={f:0.9996,src:'1m',at:T+10000};
const smooth=factor('XAUUSD',T+70000);assert.ok(Math.abs(smooth-(0.9996*0.7+4010/4012*0.3))<1e-12,'small changes are smoothed');
assert.ok(/fetchOkxMetal\(sym,'1m',3\)/.test(html),'browser fetches the 1m reference bar');
assert.ok(fs.readFileSync(__dirname+'/../src/main/resources/background/scanner.cjs','utf8').includes("'autoWickCheck'"),'server scanner runs the same wick check');
console.log('PASS wick-based SL/TP (adverse first, gap fill, BE after TP1, no double-apply, entry bar skipped), 1m metal basis with smoothing and staleness guard, scanner parity');
