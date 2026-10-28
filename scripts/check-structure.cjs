'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const {extract,scan}=require('../src/main/resources/background/scanner.cjs');
const PaperMath=require('../src/main/resources/static/trading-core.js');
const now=Date.UTC(2026,9,28,10,0,1),ctx=vm.createContext({Date,Math,PaperMath});
const names=['atr','kmrPivots','kmrLevelZones','kmrOrderBlockSetup','kmrLevelPlan'];
vm.runInContext(['ASSETS','SPREAD'].map(n=>extract(n,'const')).join('\n')+'\n'+names.map(n=>extract(n)).join('\n'),ctx);
function fixture(){
 const c=Array.from({length:240},(_,i)=>({t:now-1000-(240-i)*300000,ms:300000,o:100,c:100.1,h:100.4,l:99.6,v:100}));
 Object.assign(c[230],{o:100,c:99.8,h:100.2,l:99.6});
 for(let i=231;i<239;i++)Object.assign(c[i],{o:103,c:103.1,h:103.3,l:102.8});
 Object.assign(c[239],{o:100.5,c:101.2,h:101.4,l:99.9,v:200});return c;
}
(async()=>{
 const c=fixture(),ob=ctx.kmrOrderBlockSetup(c,{now});assert.equal(ob.dir,'BUY',JSON.stringify(ob));assert(ob.gatesOk);assert(ob.stop<c[230].l);
 const mirror=c.map(k=>({...k,o:200-k.o,c:200-k.c,h:200-k.l,l:200-k.h}));
 const sell=ctx.kmrOrderBlockSetup(mirror,{now});assert.equal(sell.dir,'SELL');assert(sell.stop>mirror[230].h);
 for(const [label,mutate] of [
  ['low volume',a=>a.at(-1).v=50],['missing volume',a=>a.at(-8).v=0],
  ['invalidated block',a=>a[237].c=99],['already retested',a=>a[237].l=100],
  ['no displacement',a=>{for(let i=231;i<239;i++)Object.assign(a[i],{o:100,c:100.1,h:100.4,l:99.6});}],
  ['forming candle',a=>a.at(-1).t=now-1000],['history gap',a=>a.splice(-8,1)],
  ['reference only',a=>a.forEach(k=>k.analysisOnly=true)]]){
   const bars=fixture();mutate(bars);assert.equal(ctx.kmrOrderBlockSetup(bars,{now}).dir,null,label);
 }
 assert.equal(ctx.kmrOrderBlockSetup(c,{now:now+20*60000}).dir,null);
 assert.equal(ctx.kmrOrderBlockSetup(c,{now,trend:'BEAR',adx:40}).dir,null);
 const scanResult={A:ob.A,levelSetup:ob};
 const p4=ctx.kmrLevelPlan('XAUUSD','BUY',101.2,scanResult,{target:4,maxLoss:4});assert(!p4.reject,JSON.stringify(p4));assert(Math.abs(p4.tpUsd-4)<1e-8);assert.equal(p4.sl,ob.stop);
 const p5=ctx.kmrLevelPlan('XAUUSD','BUY',101.2,scanResult,{target:5,maxLoss:4});assert(!p5.reject);assert(p5.tp>p4.tp);assert.equal(p5.sl,p4.sl);
 assert(ctx.kmrLevelPlan('XAUUSD','BUY',101.2,scanResult,{target:.5,maxLoss:4}).reject,'small reward must not bypass minimum reward/risk');
 assert(ctx.kmrLevelPlan('XAUUSD','BUY',101.2,scanResult,{target:4,maxLoss:.5}).reject,'loss limit cannot clip structural stop');
 for(const target of [0,-2,NaN,Infinity])assert(ctx.kmrLevelPlan('XAUUSD','BUY',101.2,scanResult,{target,maxLoss:4}).reject);
 const capped=ctx.kmrLevelPlan('XAUUSD','BUY',101.2,{A:ob.A,levelSetup:{...ob,targetBarrier:105.2}},{target:5,maxLoss:4});assert(!capped.reject);assert(capped.tpUsd<5);assert.equal(capped.tp,105.2);
 const job={username:'fixture',role:'user',now,allowEntries:true,config:{target:4,levels:false,continuation:true},history:[],feeds:{XAUUSD:{price:101.2,quoteAt:now,five:c,bars:{'15m':PaperMath.aggregate(c,15)},source:'synthetic fixture'}}};
 for(const news of [{},{calendar:[],calendarAt:now},{calendarAt:now,calendar:[{title:'CPI',country:'USD',impact:'High',date:new Date(now).toISOString()}]}]){
  const result=await scan({...job,...news}),entry=result.changes.find(x=>x.type==='low-profit');
  assert(entry,JSON.stringify(result));assert.equal(entry.record.strategyVersion,'ob-volume-v1');assert.equal(entry.record.newsProtection,'NOT_APPLICABLE');assert.equal(entry.record.sl,ob.stop);assert(Math.abs(entry.record.tpUsd-4)<1e-8);
 }
 const result=await scan({...job,feeds:{XAUUSD:{...job.feeds.XAUUSD,quoteAt:now-31000}}});assert(!result.changes.some(x=>x.type==='low-profit'),'stale quote still blocks structure entry');
 console.log('PASS mirrored order-block displacement/BOS/retest, no lookahead, invalidation, volume, gap, reference, trend, configurable net targets, structural risk and news-independent background entries');
})().catch(e=>{console.error(e);process.exitCode=1;});
