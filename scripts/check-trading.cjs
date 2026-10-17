const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const P=require('../src/main/resources/static/trading-core.js');
const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
const core=fs.readFileSync('src/main/resources/static/trading-core.js','utf8');
function extract(a,b){const i=html.indexOf(a),j=html.indexOf(b,i);assert(i>=0&&j>i);return html.slice(i,j);}
function entry(dir='BUY'){return {outcome:'OPEN',dir,price:100,sl:dir==='BUY'?95:105,slNow:dir==='BUY'?95:105,
  tp1:dir==='BUY'?105:95,tp2:dir==='BUY'?110:90,tp:dir==='BUY'?115:85,posUnits:1,remFrac:1,realUsd:0,spreadPerUnit:.35};}
for(const dir of ['BUY','SELL']){
  const sign=dir==='BUY'?1:-1,r=entry(dir);
  assert(P.ladder(r,100+sign*5,1000));
  assert.equal(r.remFrac,.5);assert.equal(r.slNow,100);
  P.ladder(r,100-sign*10,2000);
  assert.equal(r.outcome,'LOSS','TP1 followed by a gap can lose');
  assert.equal(r.exitPrice,100-sign*10);assert(Math.abs(r.pnlUsd-(-2.85))<1e-9);
  assert.equal(r.closedAt,2000);
  assert.equal(r.fills.reduce((n,f)=>n+f.units,0),1);
  assert(Math.abs(r.fills.reduce((n,f)=>n+f.netUsd,0)-r.pnlUsd)<1e-9);
  assert(!P.ladder(r,100+sign*20,3000),'closed trade cannot fill twice');
  const full=entry(dir);P.ladder(full,100+sign*20,4000);
  assert.equal(full.fills.length,3);assert(Math.abs(full.pnlUsd-8.15)<1e-9);
  assert.equal(full.exitPrice,full.tp,'stored exit agrees with target fill');
}
const be=entry();be.spreadPerUnit=0;P.fill(be,100,1,'MANUAL',1);assert.equal(be.outcome,'BE');
const invalid=entry();assert(!P.ladder(invalid,NaN));assert.equal(invalid.fills,undefined);
const start=1800000000000-(1800000000000%900000);
const bars=Array.from({length:210},(_,i)=>({t:start+i*300000,o:100,h:100.4,l:99.8,c:100,v:10}));
assert.equal(P.aggregate(bars,15).length,70);
const missing=bars.filter((_,i)=>i!==1);assert.equal(P.aggregate(missing,15).length,69);
assert.equal(P.aggregate(bars.filter((_,i)=>i%3===0),15).length,0,'sparse one-per-slot is not a 15m candle');
assert.equal(P.aggregate([...bars,bars[0]],15).length,69,'duplicate timestamp invalidates its bucket');
assert.equal(P.closed(bars,300000,start+600000).length,2);
assert.equal(P.closed([{...bars[0],h:98}],300000,start+600000).length,0);
console.log('PASS BUY/SELL gaps, partial fill ledger, costs, zero-P&L classification, duplicate closes, incomplete and malformed candles');

const sandbox={PaperMath:P,Date,Math,Map,SPREAD:{XAUUSD:0},ASSETS:{XAUUSD:{contractSz:100,dec:2}},
  istDayKey:t=>Math.floor((t+19800000)/864e5),aggMinutes:(b,m)=>P.aggregate(b,m),
  scalpScan:(sym,b)=>({dir:'BUY',gatesOk:true,A:1,price:b.at(-1).c,setup:'test'}),
  scalpLevels:(sym,dir,price)=>({entry:price,sl:price-1,tp:price+2,beAt:price+1.2,units:1})};
vm.createContext(sandbox);vm.runInContext(extract('function scalpSimulate(sym,history,cfg){','// ── UI ──'),sandbox);
// Use past, fully closed candles; forced signals isolate execution from indicator selection.
const origin=Math.floor((Date.now()-3*864e5)/900000)*900000;
const sample=Array.from({length:240},(_,i)=>({t:origin+i*300000,o:100,h:100.2,l:98,c:100,v:10}));
sample[201].o=100.1;
let result=sandbox.scalpSimulate('XAUUSD',sample,{dayStop:.5,goal:10,stopAtGoal:true,timeStopMin:45});
assert.equal(result.n,1,'daily stop prevents later entries on the same day');
assert.equal(result.trades[0].entry,100.1,'entry is next open, not signal close');
assert.equal(result.trades[0].t,sample[201].t);
const gap=sample.map(k=>({...k,l:99.8}));gap[202]={...gap[202],o:90,h:91,l:89,c:90};
result=sandbox.scalpSimulate('XAUUSD',gap,{dayStop:.5,goal:10,stopAtGoal:true,timeStopMin:45});
assert.equal(result.trades[0].exit,90,'replay stop gaps use adverse opening fill');
const target=sample.map(k=>({...k,h:103,l:100}));
result=sandbox.scalpSimulate('XAUUSD',target,{dayStop:8,goal:1,stopAtGoal:true,timeStopMin:45});
assert.equal(result.n,1,'daily profit goal is enforced');
console.log('PASS next-open replay entries, adverse gaps, daily loss stop and daily goal');

const engineSource=fs.readFileSync('src/main/resources/static/paper-engine.js','utf8');
const context={crypto:{randomUUID:()=> 'engine-test'},Date,PaperMath:P,prices:{XAUUSD:100},currentUser:{username:'u',role:'user'}};
vm.createContext(context);vm.runInContext(engineSource,context);
context.quoteAt.XAUUSD=Date.now()-31000;assert.equal(context.freshQuote('XAUUSD'),false);
context.quoteAt.XAUUSD=Date.now()+10000;assert.equal(context.freshQuote('XAUUSD'),false);
context.quoteAt.XAUUSD=Date.now();assert.equal(context.freshQuote('XAUUSD'),true);
context.paperEngine.until=Date.now()-1;assert.equal(context.paperReady(),false);
context.paperEngine.until=Date.now()+1000;assert.equal(context.paperReady(),true);
context.currentUser=null;assert.equal(context.paperReady(),false);
console.log('PASS stale/future quote, expired engine lease and logout gates');

for(const file of ['trading-core.js','paper-engine.js','basket-demo.js','basket-replay.js'])new vm.Script(fs.readFileSync('src/main/resources/static/'+file,'utf8'));
