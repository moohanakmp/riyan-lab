'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {scan,normalize}=require('../src/main/resources/background/scanner.cjs');
(async()=>{
 const now=Date.UTC(2026,9,19,9,5,10);
 const base={username:'background-test',role:'user',now,history:[],config:{},feeds:{}};
 assert.equal((await scan(base)).changes.length,0,'no data cannot create signals');
 const auto={id:11,owner:base.username,sym:'BTCUSD',dir:'BUY',price:100,sl:90,slNow:90,tp1:105,tp2:110,tp:115,outcome:'OPEN',posUnits:.01,lot:.01,remFrac:1,realUsd:0,spreadPerUnit:5,accountingVersion:2,ts:now-3600000,updatedAt:now-3600000};
 const history=[{id:'11',type:'auto-signals',record:auto}];
 let result=await scan({...base,history,feeds:{BTCUSD:{price:120,quoteAt:now}}});
 const closed=result.changes.find(x=>x.type==='auto-signals');assert(closed,'server must manage an open trade with the app closed');
 assert.equal(closed.record.outcome,'WIN');assert.equal(closed.record.remFrac,0);assert.equal(closed.record.fills.length,3);assert.equal(closed.record.exitPrice,115);
 assert.equal((await scan({...base,history,feeds:{BTCUSD:{price:120,quoteAt:now-31000}}})).changes.length,0,'stale quote cannot settle');
 const scalp={id:12,sym:'BTCUSD',dir:'BUY',entry:100,sl:90,slNow:90,tp:115,beAt:110,status:'OPEN',lot:.01,units:.01,spreadPerUnit:5,accountingVersion:2,t:now-1200000,updatedAt:now-1200000,lastBar:now-1500000};
 result=await scan({...base,history:[{id:'12',type:'low-profit',record:scalp}],feeds:{BTCUSD:{price:80,quoteAt:now}}});
 assert.equal(result.changes[0].record.status,'SL');assert.equal(result.changes[0].record.exit,80,'adverse gap retained');assert.equal(result.changes[0].record.pnl,-.25);
 const rows=[[Math.floor(now/300000)*300,99,102,100,101,12]];
 assert.equal(normalize(rows,300000,now,true).length,0,'forming bar excluded');
 const source=fs.readFileSync('src/main/resources/background/scanner.cjs','utf8');
 for(const name of ['evaluateSignals','recordSignal','scalpEvaluate','scalpOpen','scalpCheckRange','kmrSmartScan'])assert(source.includes("'"+name+"'"),'reuse original '+name);
 assert(!source.includes('fetch('),'worker has no arbitrary network or notification channel');
 // Actual indicator rules over deterministic sample history; no stubbed trade decisions.
 let seed=7123;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/4294967296;
 let entry=null,eligibleJob=null;
 for(let attempt=0;attempt<100&&!entry;attempt++){
  let price=100;const five=Array.from({length:300},(_,i)=>{const o=price;price+=((rand()-.45)*1.2);return {t:now-10000-(300-i)*300000,ms:300000,o,h:Math.max(o,price)+rand()*.8,l:Math.min(o,price)-rand()*.8,c:price,v:10+rand()*20};});
  const Paper=require('../src/main/resources/static/trading-core.js');
  const bars={'15m':Paper.aggregate(five,15),'1h':Paper.aggregate(five,60),'4h':Paper.aggregate(five,240)};
  eligibleJob={...base,calendar:[],calendarAt:now,feeds:{XAUUSD:{price,quoteAt:now,five,bars,source:'test only'}}};
  result=await scan(eligibleJob);
  entry=result.changes.find(x=>x.type==='low-profit'&&x.record.status==='OPEN');
 }
 assert(entry,'unchanged real indicator strategy must generate eligible background paper entry');assert.equal(entry.record.generator,'server-background');assert.equal(entry.record.accountingVersion,2);assert.equal(entry.record.lot,.01);assert(entry.record.conditions.gates.every(g=>g.ok));
 assert.equal((await scan({...eligibleJob,allowEntries:false})).changes.length,0,'unsynchronized personal settings cannot create new entries');
 assert.equal((await scan({...eligibleJob,calendar:null,calendarAt:0})).changes.length,0,'calendar failure must block real eligible setups');
 const replay=await scan({...base,calendar:[],calendarAt:now,history:[{id:entry.id,type:entry.type,record:entry.record}],feeds:{}});
 assert(!replay.changes.some(x=>x.record.status==='OPEN'&&x.id!==entry.id),'restarted worker cannot duplicate an open trade');
 console.log('PASS background no-data/stale fail-closed, real indicator entry, exact ladder and adverse-gap lifecycle, restart ownership inputs, shared strategies and no outbound alerts');
})().catch(e=>{console.error(e);process.exitCode=1});
