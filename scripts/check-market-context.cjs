'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const M=require('../src/main/resources/static/market-context.js');
const {extract}=require('../src/main/resources/background/scanner.cjs');
const now=Math.floor(Date.now()/900000)*900000+1000,step=900000;
function base(){return Array.from({length:75},(_,i)=>{let p=120-i*.2;return{t:now-1000-(75-i)*step,ms:step,o:p+.1,c:p,h:p+.25,l:p-.25,v:100};});}
const evaluate=c=>M.analyze(c,{now,step}),mirror=c=>c.map(k=>({...k,o:240-k.o,c:240-k.c,h:240-k.l,l:240-k.h}));
function hit(r,key){return r.patterns.find(p=>p.key===key);}
assert.equal(M.definitions.length,31);assert.equal(new Set(M.definitions.map(p=>p.key)).size,31);
const c=base();Object.assign(c.at(-2),{o:106,c:105,h:106.1,l:104.9});Object.assign(c.at(-1),{o:104.8,c:106.4,h:106.6,l:104.6,v:180});
const e=evaluate(c);assert(hit(e,'bullEngulf').confirmed);assert(e.triggerBuy);assert.equal(e.momentum,'BUY');assert(e.volumeReady);assert.equal(e.footprintAvailable,false);
assert(hit(evaluate(mirror(c)),'bearEngulf').confirmed);assert.equal(evaluate(mirror(c)).momentum,'SELL');
const hammer=base();Object.assign(hammer.at(-1),{o:105.3,c:105.5,h:105.6,l:103.8});
assert(hit(evaluate(hammer),'hammer').detected);assert(!hit(evaluate(hammer),'hammer').confirmed,'bare hammer requires confirmation');
const confirm=hammer.map(k=>({...k,t:k.t-step}));confirm.push({...confirm.at(-1),t:now-1000-step,o:105.5,c:106.2,h:106.4,l:105.4});
assert(hit(evaluate(confirm),'hammer').confirmed,'later closed candle confirms prior hammer');
const doji=base();Object.assign(doji.at(-1),{o:105,c:105,h:106,l:104});const neutral=evaluate(doji);assert(hit(neutral,'doji').detected);assert(!neutral.triggerBuy&&!neutral.triggerSell,'neutral doji cannot authorize an entry');
// Delta volume must conserve total volume and invert under an exact price mirror.
for(const row of e.rows){assert(Math.abs(row.buy+row.sell-row.v)<1e-7);assert(Math.abs(row.delta)<=row.v+1e-7);}
const reversed=evaluate(mirror(c));assert(Math.abs(reversed.delta+e.delta)<1e-6);assert(Math.abs(reversed.cvd+e.cvd)<1e-6);
const zero=c.map(k=>({...k,v:0}));const missing=evaluate(zero);assert(!missing.volumeReady);assert.equal(missing.delta,null);assert.equal(missing.momentum,'MIXED');
const gap=c.filter((_,i)=>i!==c.length-5);assert(!evaluate(gap).ready);assert(!evaluate([...c].reverse()).ready);
const delayed=c.map(k=>({...k,analysisOnly:true}));assert.equal(evaluate(delayed).entryData,false);
const future={...c.at(-1),t:now-1000};const same=evaluate([...c,future]);assert.equal(same.lastAt,e.lastAt,'forming candles do not change confirmed evidence');
assert.equal(evaluate(c.map(k=>({...k,t:k.t-step*3}))).entryData,false);
// Confirmed prior swing sweep, BOS, displacement and retests use only observed candles.
const swings=Array.from({length:80},(_,i)=>{let p=100+Math.cos(i*Math.PI/5)*2;return{t:now-1000-(80-i)*step,o:p-.1,c:p+.1,h:p+.3,l:p-.3,v:100};});
Object.assign(swings.at(-1),{o:101.8,h:103,l:100.8,c:101.2,v:180});
assert(evaluate(swings).concepts.find(x=>x.name==='Liquidity sweep').active);
const breakUp=swings.map(k=>({...k}));Object.assign(breakUp.at(-1),{o:101,c:103.6,h:103.8,l:100.9});assert(evaluate(breakUp).concepts.find(x=>x.name==='Break of structure').active);
assert(evaluate(breakUp).concepts.find(x=>x.name==='Displacement').active);


const flatBars=()=>base().map(v=>({...v,o:100,c:100,h:100.2,l:99.8}));
const fvgBars=flatBars();
[{o:100,c:100,h:100.2,l:99.8},{o:100,c:103,h:103.2,l:99.9},{o:103,c:103.2,h:103.4,l:102.8},{o:103.2,c:103.3,h:103.5,l:103},{o:102.9,c:103,h:103.2,l:102.4}].forEach((v,i)=>Object.assign(fvgBars[fvgBars.length-5+i],v));
assert(evaluate(fvgBars).concepts.find(x=>x.name==='Fair value gap retest').active);
const inverseBars=flatBars();
[{o:100,c:100,h:100.2,l:99.8},{o:100,c:103,h:103.2,l:99.9},{o:103,c:103.2,h:103.4,l:102.8},{o:103,c:99.8,h:103.1,l:99.7},{o:99.8,c:99.9,h:100,l:99.5},{o:101,c:100,h:101.5,l:99.9}].forEach((v,i)=>Object.assign(inverseBars[inverseBars.length-6+i],v));
const inverted=evaluate(inverseBars).concepts.find(x=>x.name==='Inverted FVG retest');assert(inverted.active);assert.equal(inverted.dir,'SELL');
const obBars=flatBars();
[{o:101,c:100,h:101.2,l:99.8},{o:100,c:103,h:103.2,l:99.9},{o:103,c:103.1,h:103.3,l:102.8},{o:100.8,c:101.5,h:101.6,l:100.6}].forEach((v,i)=>Object.assign(obBars[obBars.length-4+i],v));
assert(evaluate(obBars).concepts.find(x=>x.name==='Order block retest').active);
const brokenOb=obBars.map(k=>({...k}));Object.assign(brokenOb.at(-2),{o:100,c:99,h:100.1,l:98.9});assert(!evaluate(brokenOb).concepts.find(x=>x.name==='Order block retest').active);
assert(evaluate(swings).concepts.find(x=>x.name==='Internal range liquidity').active);

// Every catalog entry has a concrete positive OHLC fixture (including rare gap patterns).
const k=(o,c,h=Math.max(o,c)+.1,l=Math.min(o,c)-.1)=>({o,c,h,l,v:150});
const fixtures={
 doji:[k(105,105,106,104)],hammer:[k(105.3,105.5,105.6,103.8)],invertedHammer:[k(104.3,104.5,106,104.2)],
 bullEngulf:[k(106,105),k(104.8,106.4)],morningStar:[k(106,104),k(104.1,104.2,104.3,103.9),k(104.2,105.6)],
 soldiers:[k(104,105),k(104.8,106),k(105.8,107)],piercing:[k(106,104),k(104.05,105.4)],tweezerBottom:[k(106,104,106.1,103.8),k(104,105,105.1,103.8)],
 bullHarami:[k(106,104),k(104.7,105.2)],insideUp:[k(106,104),k(104.7,105.2),k(105.3,106.4)],outsideUp:[k(105.5,104.8),k(104.6,105.8),k(105.9,106.3)],
 bullMarubozu:[k(104,106,106.02,103.98)],spinning:[k(105,105.4,106,104)],dragonfly:[k(105.5,105.5,105.55,103.5)],
 bullTriStar:[k(104,104),k(103,103),k(103.8,103.8)],longDoji:[k(105,105,106,104)]
};
for(const [key,tail] of Object.entries(fixtures)){const test=base();tail.forEach((v,i)=>Object.assign(test[test.length-tail.length+i],v));assert(hit(evaluate(test),key).detected,'catalog fixture: '+key);}
const mirrors={shootingStar:'hammer',hangingMan:'invertedHammer',bearEngulf:'bullEngulf',eveningStar:'morningStar',crows:'soldiers',darkCloud:'piercing',tweezerTop:'tweezerBottom',bearHarami:'bullHarami',insideDown:'insideUp',outsideDown:'outsideUp',bearMarubozu:'bullMarubozu',gravestone:'dragonfly',bearTriStar:'bullTriStar'};
for(const [key,from] of Object.entries(mirrors)){const test=base(),tail=fixtures[from];tail.forEach((v,i)=>Object.assign(test[test.length-tail.length+i],v));assert(hit(evaluate(mirror(test)),key).detected,'mirrored catalog fixture: '+key);}
const rising=base().map((v,i)=>({...v,o:90+i*.2,c:90+i*.2+.1,h:90+i*.2+.25,l:90+i*.2-.25}));
[k(104,106,106.2,103.8),k(105.8,105.3),k(105.4,105),k(105.2,104.9),k(105.5,106.5)].forEach((v,i)=>Object.assign(rising[rising.length-5+i],v));
assert(hit(evaluate(rising),'risingMethods').detected);assert(hit(evaluate(mirror(rising)),'fallingMethods').detected);

const compact=vm.createContext({});vm.runInContext(extract('marketEvidenceSnapshot'),compact);const snap=compact.marketEvidenceSnapshot(e);assert(!snap.rows);assert(snap.patterns.every(p=>p.name));assert(JSON.stringify(snap).length<5000,'entry audit remains bounded');
const source=fs.readFileSync('src/main/resources/background/scanner.cjs','utf8');assert(source.includes("'market-context.js'"),'server uses same shared evidence');
const back=vm.createContext({Math,kmrSmartScan:(f,h1,h4,ctx)=>{assert.equal(ctx.now,f.at(-1).t+900000);assert(h1.every(k=>k.t+3600000<=ctx.now));assert(h4.every(k=>k.t+14400000<=ctx.now));return{tier:null};}});
vm.runInContext(extract('kmrAgg')+'\n'+extract('kmrBacktest'),back);
const long=Array.from({length:300},(_,i)=>({...c[0],t:Math.floor(now/14400000)*14400000-(300-i)*step}));assert(back.kmrBacktest(long,{tune:{},isMetal:true,dec:2}).ok);
console.log('PASS shared 31-pattern catalog, contextual confirmations, neutral rejection, exact volume conservation, mirrored delta, stale/forming/reference/missing/gap guards, sweep/BOS/displacement and bounded entry audit');
