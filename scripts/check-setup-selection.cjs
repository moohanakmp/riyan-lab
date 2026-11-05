'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const {extract}=require('../src/main/resources/background/scanner.cjs');
const now=Date.UTC(2026,10,5,10),bars=Array.from({length:80},(_,i)=>({t:now-(80-i)*300000,o:100,c:100,h:101,l:99,v:100}));
const ctx=vm.createContext({Date,Math,atr:()=>2,emaSeries:c=>c,ema:()=>100,rsi:()=>50,kmrAdx:()=>({adx:15}),bbAt:()=>null,fmtP:(_,p)=>String(p),kmrIstHour:()=>15});
vm.runInContext(['ASSETS','SPREAD','SCALP_DEF'].map(n=>extract(n,'const')).join('\n')+'\n'+['kmrLevelPlan','scalpScan'].map(n=>extract(n)).join('\n'),ctx);
function run(sym,dir,entry,stops,target=4,maxLoss=4,barriers=[]){
 const models=stops.map((stop,i)=>({dir,gatesOk:true,stop,targetBarrier:barriers[i]??null,why:['confirmed fixture'],reason:'Confirmed',A:2}));
 [ctx.kmrLevelSetup,ctx.kmrOrderBlockSetup,ctx.kmrBreakRetestSetup]=models.map(m=>()=>m);
 return ctx.scalpScan(sym,bars,bars,null,{now,isMetal:false,marketOpen:true,spread:0,dec:2,entry,cfg:{target,maxLoss}});
}
let s=run('XAUUSD','BUY',100,[95,99,98]);
assert.equal(s.strategyVersion,'ob-volume-v1','risk-rejected support/resistance must not hide an eligible order block');
assert.equal(s.levelSetup.stop,99);
s=run('XAUUSD','SELL',100,[105,101,102]);assert.equal(s.strategyVersion,'ob-volume-v1','mirrored SELL selection');
s=run('XAUUSD','BUY',100,[99,98,99],4,4,[100.5,100.6,110]);assert.equal(s.strategyVersion,'break-retest-v1','barrier-rejected candidates must not hide an eligible retest');
s=run('XAUUSD','BUY',100,[99,98,97]);assert.equal(s.strategyVersion,'sr-volume-v1','preserve priority when the first setup passes');
s=run('XAUUSD','BUY',100,[95,94,93]);assert(s.candidateChecks.every(c=>c.reject),'keep rejection evidence for every confirmed setup');assert(s.candidateChecks.length===3);
s=run('XAUUSD','BUY',102,[99,101,100]);assert.equal(s.strategyVersion,'ob-volume-v1','evaluate risk at the intended entry, not the prior candle close');
s=run('XAGUSD','BUY',100,[95,99,98]);assert.equal(s.strategyVersion,'ob-volume-v1','silver uses the same risk-aware selection');
s=run('BTCUSD','BUY',1000,[500,900,800]);assert.equal(s.strategyVersion,'ob-volume-v1','BTC uses its own contract size and spread');
s=run('BTCUSD','SELL',1000,[1500,1100,1200]);assert.equal(s.strategyVersion,'ob-volume-v1');
s=run('XAUUSD','BUY',100,[98,98,98],2);assert(s.candidateChecks.every(c=>c.reject.startsWith('Configured $2.00 target')),'target-limited reward must not be blamed on an opposing level');
s=run('XAUUSD','BUY',100,[99,99,99],4,4,[100.5,100.5,100.5]);assert(s.candidateChecks.every(c=>c.reject.startsWith('Next opposing level')),'barrier-limited reward remains distinct');
console.log('PASS simultaneous setup risk selection, mirrored SELL, opposing barriers, stable priority, rejection evidence and actual-entry risk');
