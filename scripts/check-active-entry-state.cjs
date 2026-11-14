'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const {extract}=require('../src/main/resources/background/scanner.cjs');
(async()=>{
 const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
 const styles=fs.readFileSync('src/main/resources/static/workspace-ui.css','utf8');
 assert(html.includes('data-tab="volumeTrap" onclick="showTab(\'volumeTrap\',this)"><span class="tab-ic"><i class="bi bi-bar-chart"'));assert(styles.includes('.bi-bar-chart::before'));
 assert(!html.includes('id="triggerStatus"'));assert(extract('renderSignals').includes('waitCard('));
 assert(html.includes('id="autoSignalAnalysis"'));assert(html.includes('Signal rules & safety gates'));assert(html.includes('Backtest & validation'));assert(!html.includes('id="trendStrip" hidden'));
 assert(html.includes('ENTRY BLOCKED')&&html.includes('SUBMITTING')&&html.includes('TRADE OPEN'));
 const saved=new Map(),c=vm.createContext({crypto:webcrypto,Date,console,currentUser:{username:'u',role:'user'},prices:{},
  localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},riyanSafeRecordId:async(t,id)=>id,
  riyanApi:async()=>{throw Error('HTTP 404');}});
 vm.runInContext(fs.readFileSync('src/main/resources/static/paper-engine.js','utf8'),c);
 const item={type:'basket-positions',id:'orphan',value:'{"status":"OPEN","entry":100}'};
 assert.equal(await c.paperReconcileConflict(item,'u','Basket entries retired; use Low Profit paper trading'),true);
 const log=JSON.parse(saved.get('riyan_conflicts_u'));assert.equal(log['basket-positions|orphan'].value,item.value);assert.match(log['basket-positions|orphan'].resolution,/quarantined/);
 assert.equal(await c.paperReconcileConflict(item,'u','Combined open risk exceeded'),false,'unrelated risk conflict cannot discard a queued snapshot');
 c.riyanApi=async()=>{throw Error('HTTP 401');};assert.equal(await c.paperReconcileConflict(item,'u','Basket mode is OFF'),false);
 c.riyanApi=async()=>({payload:JSON.stringify({status:'OPEN',updatedAt:0})});assert.equal(await c.paperReconcileConflict(item,'u','Basket mode is OFF'),false,'committed open position must remain managed');
 // Keep analysis, quality/watch cards and open locked plans while excluding closed orders.
 const render=vm.createContext({currentUser:{role:'admin'},hasAccess:()=>true,SYMS:['XAUUSD','XAGUSD','BTCUSD'],ASSETS:{XAUUSD:{},XAGUSD:{},BTCUSD:{}},
  activeSignals:{XAUUSD:1,XAGUSD:2},signalHistory:[{id:1,sym:'XAUUSD',outcome:'OPEN',confidence:'HIGH'},{id:2,sym:'XAGUSD',outcome:'LOSS',confidence:'MED'}],flashedSigIds:new Set(),
  paperEngine:{reason:'Active'},basketTxt:x=>x,renderTriggeredSignals:()=>{},lockedCard:(sym)=>'OPEN_PLAN_'+sym,
  isMetalsMarketOpen:()=>true,computeSignal:()=>({}),waitCard:(sym)=>'WATCH_QUALITY_'+sym,kmrVolumeCardHtml:sym=>'VOLUME_'+sym,
  document:{getElementById:()=>({})},setEvidenceHtml:(el,content)=>render.rendered=content});
 vm.runInContext(extract('renderSignals'),render);render.renderSignals();
 assert(render.rendered.includes('OPEN_PLAN_XAUUSD'));assert(!render.rendered.includes('OPEN_PLAN_XAGUSD'),'closed orders never reappear as active plans');
 assert(render.rendered.includes('WATCH_QUALITY_XAGUSD'));assert(render.rendered.includes('WATCH_QUALITY_BTCUSD'));assert(render.rendered.includes('VOLUME_XAUUSD'));
 // Every old open window is refreshed exactly once on service-worker activation.
 let activate,navigations=0,claimed=0;const sw=vm.createContext({URL,Promise,caches:{keys:async()=>['old'],delete:async()=>true},
  self:{location:{origin:'https://app.test'},clients:{claim:async()=>claimed++,matchAll:async()=>[{url:'https://app.test/',navigate:async()=>navigations++}]},addEventListener:(name,fn)=>{if(name==='activate')activate=fn;}}});
 vm.runInContext(fs.readFileSync('src/main/resources/static/sw.js','utf8'),sw);let pending;activate({waitUntil:p=>pending=p});await pending;assert.equal(navigations,1);assert.equal(claimed,1);
 console.log('PASS active-trade UI, actual entry states, shipped Volume Trap icon, definitive orphan rejection quarantine without losing committed trades, and old-client reload on worker upgrade');
})().catch(e=>{console.error(e);process.exitCode=1;});
