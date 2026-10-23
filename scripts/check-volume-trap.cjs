'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {extract,scan}=require('../src/main/resources/background/scanner.cjs');
const PaperMath=require('../src/main/resources/static/trading-core.js');
const now=Math.floor(Date.now()/300000)*300000+1000;
const names=['kmrIstHour','ema','rsi','atr','emaSeries','bbAt','fmtP','kmrAdx','kmrPivots','kmrTfBias','kmrVolumePressure','kmrLevelZones','kmrLevelSetup','kmrLevelPlan','scalpScan','scalpLevels'];
const ctx=vm.createContext({Date,Math,PaperMath});
vm.runInContext(['ASSETS','SPREAD'].map(n=>extract(n,'const')).join('\n')+'\n'+names.map(n=>extract(n)).join('\n'),ctx);
function sample(){
 const bars=Array.from({length:240},(_,i)=>{const p=4160+4.5*Math.cos(i*Math.PI/6);return{t:now-1000-(240-i)*300000,ms:300000,o:p-.1,c:p+.1,h:p+.5,l:p-.5,v:100};});
 bars.at(-2).o=4163.5;bars.at(-2).c=4163.8;bars.at(-2).h=4164.1;bars.at(-2).l=4163.2;
 Object.assign(bars.at(-1),{o:4164.4,h:4165.3,l:4163,c:4163.4,v:180});return bars;
}
(async()=>{
 const bars=sample(),model=ctx.kmrLevelSetup(bars,{now,trend:'FLAT',adx:15});
 assert.equal(model.dir,'SELL',JSON.stringify(model));assert(model.level.touches>=2);assert.equal(model.trap,true);
 assert(model.stop>bars.at(-1).h,'stop stays beyond rejected high');
 const scanResult={A:model.A,levelSetup:model,strategyVersion:'sr-volume-v1'};
 const plan=ctx.scalpLevels('XAUUSD','SELL',4163.4,scanResult,bars,{maxLoss:4});
 assert(!plan.reject,JSON.stringify(plan));assert(plan.sl>plan.entry);assert(plan.tp<plan.entry);assert(plan.rr>=1.3);assert.equal(plan.lot,.01);assert(plan.slUsd<=4);
 // Mirror the same candles: support rejection must produce BUY, with symmetric levels/risk.
 const mirror=bars.map(k=>({...k,o:8320-k.o,c:8320-k.c,h:8320-k.l,l:8320-k.h}));
 const buy=ctx.kmrLevelSetup(mirror,{now,trend:'FLAT',adx:15});assert.equal(buy.dir,'BUY');
 const buyPlan=ctx.scalpLevels('XAUUSD','BUY',mirror.at(-1).c,{A:buy.A,levelSetup:buy,strategyVersion:'sr-volume-v1'},mirror,{maxLoss:4});assert(!buyPlan.reject);assert(buyPlan.sl<buyPlan.entry);assert(buyPlan.tp>buyPlan.entry);
 const lowVolume=sample();lowVolume.at(-1).v=40;assert.equal(ctx.kmrLevelSetup(lowVolume,{now}).dir,null);
 const noVolume=sample();noVolume.at(-8).v=0;assert.equal(ctx.kmrLevelSetup(noVolume,{now}).dir,null);
 const breakout=sample();Object.assign(breakout.at(-1),{o:4164.5,c:4166,h:4166.5,l:4164.3});assert.equal(ctx.kmrLevelSetup(breakout,{now}).dir,null,'a breakout is not a rejection sell');
 const forming=sample();forming.at(-1).t=now-1000;assert.equal(ctx.kmrLevelSetup(forming,{now}).dir,null,'forming rejection cannot become a signal');
 const delayed=sample().map(k=>({...k,analysisOnly:true}));assert.equal(ctx.kmrLevelSetup(delayed,{now}).dir,null);
 const gap=sample();gap.splice(-8,1);assert.equal(ctx.kmrLevelSetup(gap,{now}).dir,null);
 assert.equal(ctx.kmrLevelSetup(sample(),{now:now+20*60000}).dir,null,'stale history blocked');
 assert.equal(ctx.kmrLevelSetup(sample(),{now,trend:'BULL',adx:40}).dir,null,'do not blindly sell strong uptrends');
 const flat=sample().map(k=>({...k,o:4160,c:4160,h:4161,l:4159}));assert.equal(ctx.kmrLevelZones(flat,2).resistance.length,0,'flat duplicates cannot fake repeated touches');
 const shortTarget={...model,targetBarrier:4163};assert(ctx.kmrLevelPlan('XAUUSD','SELL',4163.4,{A:model.A,levelSetup:shortTarget},{maxLoss:4}).reject,'insufficient reward after spread rejected');
 assert(ctx.scalpLevels('XAUUSD','SELL',4158,scanResult,bars,{maxLoss:4}).reject,'wide stop must not be clipped or lot enlarged');
 assert(ctx.scalpLevels('XAUUSD','SELL',4166,scanResult,bars,{maxLoss:4}).reject,'invalidated level cannot be entered');
 const c15=PaperMath.aggregate(bars,15),settings={now,events:[],newsReady:true,isMetal:true,marketOpen:true,spread:.35,dec:2,levels:true};
 const original=ctx.scalpScan('XAUUSD',bars,c15,[],{...settings,levels:false});
 const levelScan=ctx.scalpScan('XAUUSD',bars,c15,[],settings);
 if(original.dir)assert.equal(levelScan.setup,original.setup,'original valid candidates retain priority');
 else assert.equal(levelScan.strategyVersion,'sr-volume-v1');
 const noNews=ctx.scalpScan('XAUUSD',bars,c15,[],{...settings,newsReady:false});assert.equal(noNews.gatesOk,levelScan.gatesOk);assert(noNews.gates.some(g=>g.advisory));
 assert.equal(ctx.scalpScan('XAUUSD',bars,c15,[],{...settings,marketOpen:false}).gatesOk,false);
 // Browser and background use exactly the same new functions and retain server-entry provenance.
 const result=await scan({username:'fixture',role:'user',now,allowEntries:true,config:{levels:true},history:[],calendar:[],calendarAt:now,
  feeds:{XAUUSD:{price:bars.at(-1).c,quoteAt:now,five:bars,bars:{'15m':c15,'1h':PaperMath.aggregate(bars,60),'4h':PaperMath.aggregate(bars,240)},source:'synthetic fixture only'}}});
 const entry=result.changes.find(x=>x.type==='low-profit'&&x.record.status==='OPEN');
 assert(entry,'real level setup must reach the background entry pipeline');
 assert.equal(entry.record.strategyVersion,'sr-volume-v1');
 assert.equal(entry.record.generator,'server-background');
 assert.equal(entry.record.conditions.levelSetup.level.touches,model.level.touches);
 assert.equal(entry.record.sl,model.stop);
 assert(entry.record.tpUsd/entry.record.slUsd>=1.3);
 const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
 assert(html.includes("if((n==='flow'||n==='volumeTrap')&&!hasAccess('flow'))"));
 assert(html.includes('data-tab="volumeTrap"'));assert(html.includes('id="tvt"'));assert(html.includes('id="tfl"'),'Flow remains intact');
 // Rendering uses escaped source text and draws actual series, without placing orders.
 const render=extract('renderVolumeTrap');assert(render.includes('basketTxt(st.feedSource'));assert(!render.includes('scalpOpen('));
 // Display timeframe selection must not mutate or submit entries, and minute requests coalesce.
 let resolveMinute,calls=0,renders=0;
 Object.assign(ctx,{SYMS:['XAUUSD','XAGUSD','BTCUSD'],fetchOkxMetal:async(sym,tf,n)=>{calls++;assert.equal(tf,'1m');assert.equal(n,180);await new Promise(r=>resolveMinute=r);return Array.from({length:60},(_,i)=>({t:Math.floor(Date.now()/60000)*60000-(60-i)*60000,ms:60000,o:100,h:102,l:99,c:101,v:100}));},renderVolumeTrap:()=>renders++});
 vm.runInContext("let volumeTrapSym='XAUUSD',volumeTrapTf='5m';const volumeTrapMinuteCache=new Map();"+extract('volumeTrapTimeframe')+extract('volumeTrapLoadMinute'),ctx);
 ctx.volumeTrapTimeframe('1m');assert.equal(vm.runInContext('volumeTrapTf',ctx),'1m');ctx.volumeTrapTimeframe('15m');assert.equal(vm.runInContext('volumeTrapTf',ctx),'1m');
 const pending=ctx.volumeTrapLoadMinute('XAUUSD');await ctx.volumeTrapLoadMinute('XAUUSD');assert.equal(calls,1);resolveMinute();await pending;await ctx.volumeTrapLoadMinute('XAUUSD');assert.equal(calls,1);assert.equal(vm.runInContext("volumeTrapMinuteCache.get('XAUUSD').bars.length",ctx),60);
 assert(extract('volumeTrapDetailHtml').includes("step=tf==='1m'?60000:300000"));
 Object.assign(ctx,{basketTxt:s=>String(s),MarketContext:require('../src/main/resources/static/market-context.js')});
 vm.runInContext(extract('tradeVolumeDetailsHtml'),ctx);
 const evidence=ctx.MarketContext.analyze(bars,{now,step:300000});
 const detail=ctx.tradeVolumeDetailsHtml(evidence,'XAUUSD','OKX XAU/USDT perp');
 assert(detail.includes('Start (IST)'));assert(detail.includes('End (IST)'));assert(detail.includes('0.01 lot = 1 oz'));assert(detail.includes('Individual trade lot sizes and trade counts are unavailable'));assert(detail.includes('XAU base units'));assert(!detail.includes('<details'));
 const token=ctx.tradeVolumeDetailsHtml(evidence,'XAUUSD','Binance PAXG proxy');assert(token.includes('PAXG tokens'));
 console.log('PASS symmetric level/volume rejection plans, real-volume requirement, failed breaks, forming/stale/reference/gap rejection, strong-trend guard, net reward/risk, fixed risk/lot, original priority, shared background and Volume Trap navigation');
})().catch(e=>{console.error(e);process.exitCode=1});
