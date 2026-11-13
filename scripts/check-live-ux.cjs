'use strict';
// 2026-11-13: live Volume Trap stream, server-authoritative Low Profit settings, faster news recovery.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {extract}=require('../src/main/resources/background/scanner.cjs');
(async()=>{
 // ── Live volume parsing is display-only and rejects malformed rows ──
 const LiveVolume=require('../src/main/resources/static/live-volume.js'),T=LiveVolume._test;
 const t0=Math.floor(Date.now()/60000)*60000;
 const k=T.okxCandle([String(t0),'2000','2002','1999','2001','5','0.5','1000','0']);
 assert.deepEqual([k.t,k.o,k.h,k.l,k.c,k.v,k.complete],[t0,2000,2002,1999,2001,0.5,false],'OKX volume uses base-unit volCcy, like the REST history');
 assert.equal(T.okxCandle([String(t0),'2000','1990','1999','2001','5','0.5','1','1']),null,'high below low is rejected');
 assert.equal(T.okxCandle([String(t0+1),'2000','2002','1999','2001','5','0.5','1','1']),null,'off-minute timestamps are rejected');
 assert.equal(T.okxCandle(['x']),null);
 const s=T.blank('BTCUSD');s.connectedAt=Date.now()-60000;
 const iso=ms=>new Date(ms).toISOString();
 T.addMatch(s,{time:iso(t0+1000),price:'100',size:'2',side:'sell'});
 T.addMatch(s,{time:iso(t0+2000),price:'103',size:'1',side:'buy'});
 T.addMatch(s,{time:iso(t0+3000),price:'99',size:'1',side:'sell'});
 assert.deepEqual([s.forming.o,s.forming.h,s.forming.l,s.forming.c,s.forming.v],[100,103,99,99,4]);
 T.addMatch(s,{time:iso(t0+61000),price:'101',size:'1',side:'buy'});
 assert.equal(s.closed.length,1);assert.equal(s.closed[0].v,4);assert.equal(s.forming.t,t0+60000);
 T.addMatch(s,{time:'bad',price:'1',size:'1',side:'buy'});T.addMatch(s,{time:iso(t0),price:'-1',size:'1',side:'buy'});
 assert.equal(s.trades.length,4,'invalid trades are ignored');
 T.states.set('BTCUSD',s);const f=T.flow('BTCUSD',t0+62000);
 // Maker side "sell" means the taker bought: 2+1 bought of 5 total.
 assert.equal(Math.round(f.buyPct),60);assert.equal(Math.round(f.sellPct),40);
 assert.equal(LiveVolume.snapshot('XAUUSD').status,'idle','no stream starts until Volume Trap is opened');
 const vt=fs.readFileSync('src/main/resources/static/live-volume.js','utf8');
 assert(!/scalpOpen|riyanApi|paperEngine|signalHistory|scalpHist/.test(vt),'live stream must not touch entries or persistence');

 // ── Opening the app adopts saved server settings instead of overwriting them ──
 const posts=[];let status={enabled:true,state:'SCANNING',settings:{enabled:true,basketEnabled:false,basketModeVersion:2,
   scalp:{target:2,maxLoss:9,goal:10,dayStop:20,stopAtGoal:true,auto:true,continuation:false,levels:true,assets:{XAUUSD:true,XAGUSD:false,BTCUSD:true},timeStopMin:45}}};
 const stored={};
 const ctx=vm.createContext({console,JSON,Object,Number,Math,Date,String,Array,Promise,setInterval(){},
  localStorage:{getItem:k=>stored[k]??null,setItem:(k,v)=>{stored[k]=v;}},
  document:{readyState:'complete',getElementById:()=>null,addEventListener(){}},
  currentUser:{username:'kalai',role:'admin'},basketDemo:{enabled:false,modePending:false},
  calendarCacheAt:0,renderCalendarHealth(){},fetchEconCalendar:async()=>{},
  riyanApi:async(url,opts)=>{if(url.endsWith('/settings')){posts.push(JSON.parse(opts.body));return {saved:true};}return status;}});
 const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
 vm.runInContext(html.match(/const SCALP_DEF=\{[^\n]*\};/)[0]+'\nlet scalpCfg={...SCALP_DEF,continuation:true,assets:{...SCALP_DEF.assets}};\n'+extract('saveScalpCfg'),ctx);
 vm.runInContext(fs.readFileSync('src/main/resources/static/background-client.js','utf8'),ctx);
 await new Promise(r=>setTimeout(r,20));
 assert.equal(posts.length,0,'opening the app must not overwrite saved server settings');
 const cfg=vm.runInContext('scalpCfg',ctx);
 assert.equal(cfg.continuation,false,'server strategy switches are adopted');assert.equal(cfg.assets.XAGUSD,false);
 assert.equal(cfg.maxLoss,4,'risk cap still enforced');assert.equal(cfg.dayStop,8,'daily stop cap still enforced');
 assert.equal(JSON.parse(stored.kmr_scalp_cfg).continuation,false);
 vm.runInContext("scalpCfg.continuation=true",ctx);await vm.runInContext('backgroundRefresh()',ctx);
 assert.equal(posts.length,1,'a later local change is still saved to the server');assert.equal(posts[0].scalp.continuation,true);
 // Accounts without saved settings keep the previous behaviour (first open saves them).
 const posts2=[];status={enabled:true,state:'SCANNING'};
 ctx.riyanApi=async(url,opts)=>{if(url.endsWith('/settings')){posts2.push(1);return {saved:true};}return status;};
 ctx.currentUser={username:'newuser',role:'user'};await vm.runInContext('backgroundRefresh()',ctx);
 assert.equal(posts2.length,1);

 // ── News: stored server headlines are retried before the second public fallback ──
 const calls=[];let storedRows=null;
 const news=vm.createContext({Date,URL,encodeURIComponent,NEWS_QUERY:{XAUUSD:'gold'},feedError:{},tagSentiment:()=>'nt',
  riyanApi:async()=>{calls.push('server');return storedRows;},throttleFeedCall:async()=>{},
  fetchJsonRobust:async()=>{calls.push('external');storedRows=[{headline:'Refreshed',url:'https://example.org/a',source_name:'RSS',published_at:new Date().toISOString()}];return{data:null,error:'unavailable'};}});
 vm.runInContext(extract('fetchStoredNews')+extract('fetchNews'),news);
 const got=await news.fetchNews('XAUUSD');
 assert.equal(got[0].title,'Refreshed');assert.deepEqual(calls,['server','external','server']);
 storedRows=null;news.fetchJsonRobust=async()=>{calls.push('external');return{data:null,error:'down'};};calls.length=0;
 assert.equal(await news.fetchNews('XAUUSD'),null);
 assert(calls.filter(x=>x==='external').length<=2,'no long chain of slow public fallbacks');
 const age=vm.createContext({Date,Number,Math});vm.runInContext(extract('newsAge'),age);
 assert.equal(age.newsAge(new Date(Date.now()-5*60000).toISOString()),'5 min ago');assert.equal(age.newsAge('nonsense'),'');
 assert.equal(age.newsAge('20261113T100000Z')!=='',true,'GDELT timestamps are understood');
 console.log('PASS live Volume Trap parsing/taker flow/display isolation, server-authoritative settings with risk caps, stored-news retry and bounded fallbacks');
})().catch(e=>{console.error(e);process.exit(1);});
