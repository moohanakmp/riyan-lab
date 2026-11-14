'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const {extract}=require('../src/main/resources/background/scanner.cjs');
const PaperMath=require('../src/main/resources/static/trading-core.js');
const now=Date.UTC(2026,9,30,10,0,1),ctx=vm.createContext({Date,Math,PaperMath});
vm.runInContext(['ASSETS','SPREAD'].map(n=>extract(n,'const')).join('\n')+'\n'+['atr','kmrPivots','kmrLevelZones','kmrBreakRetestSetup','kmrLevelPlan'].map(n=>extract(n)).join('\n'),ctx);
function fixture(){
 const c=Array.from({length:80},(_,i)=>({t:now-1000-(80-i)*300000,ms:300000,o:100,c:100.1,h:100.4,l:99.6,v:100}));
 Object.assign(c[77],{o:100.1,c:101.1,h:101.2,l:100,v:160});
 Object.assign(c[78],{o:101.1,c:101.05,h:101.3,l:100.8});
 Object.assign(c[79],{o:100.4,c:100.75,h:100.8,l:100.3,v:100});return c;
}
const c=fixture(),buy=ctx.kmrBreakRetestSetup(c,{now});assert.equal(buy.dir,'BUY',JSON.stringify(buy));
const immediate=fixture();immediate[78]={...immediate[77],t:immediate[78].t};immediate[77]={...immediate[76],t:immediate[77].t};
assert.equal(ctx.kmrBreakRetestSetup(immediate,{now}).dir,'BUY','the first candle after a breakout can confirm its retest');
const mirror=c.map(k=>({...k,o:200-k.o,c:200-k.c,h:200-k.l,l:200-k.h}));
assert.equal(ctx.kmrBreakRetestSetup(mirror,{now}).dir,'SELL');
for(const [label,mutate] of [
 ['weak breakout volume',a=>a[77].v=80],['weak trigger volume',a=>a[79].v=20],
 ['previous retest',a=>a[78].l=100.4],['invalidated level',a=>a[78].c=100],
 ['history gap',a=>a.splice(65,1)],['reference',a=>a[60].analysisOnly=true],
 ['forming trigger',a=>a[79].t=now-1000],['no retest',a=>a[79].l=100.7],
 ['wrong direction',a=>{a[79].o=100.8;}],['missing volume',a=>a[70].v=0]]){
 const a=fixture();mutate(a);assert.equal(ctx.kmrBreakRetestSetup(a,{now}).dir,null,label);
}
assert.equal(ctx.kmrBreakRetestSetup(c,{now:now+20*60000}).dir,null);
assert.equal(ctx.kmrBreakRetestSetup(c,{now,trend:'BEAR',adx:35}).dir,null);
assert.equal(ctx.kmrBreakRetestSetup(c,{now,trend:'BULL',adx:12}).dir,'BUY','low ADX alone does not veto a confirmed retest');
const plan=ctx.kmrLevelPlan('XAUUSD','BUY',buy.price,{A:buy.A,levelSetup:buy},{target:2,maxLoss:4});assert(!plan.reject,JSON.stringify(plan));assert(plan.sl<buy.price);assert(plan.slUsd<=4);
assert(ctx.kmrLevelPlan('XAUUSD','BUY',buy.price,{A:buy.A,levelSetup:{...buy,stop:90}},{target:2,maxLoss:4}).reject);
console.log('PASS mirrored first-retest entries, breakout/trigger volume, no repeated retests, gaps, stale/forming/reference data, strong opposing trend and structural loss cap');
