'use strict';
// Agents desk: every agent reports real state, answers are read-only, and the page wiring exists.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const dir=__dirname+'/../src/main/resources/static/';
const src=fs.readFileSync(dir+'agents.js','utf8'),html=fs.readFileSync(dir+'index.html','utf8');

assert(!/\beval\s*\(|new Function/.test(src),'agents.js must not use eval (CSP has no unsafe-eval)');
for(const bad of ['/paper/close','/paper/open','/broker/order','/broker/mode','method:\'POST\'','method:"POST"','method:\'PUT\'','method:\'DELETE\''])
  assert(!src.includes(bad),'agents must stay read-only: found '+bad);
assert(html.includes('data-tab="agents"'),'Agents tab button');
assert(html.includes('<div id="tag" style="display:none">'),'Agents panel');
assert(html.includes('agents.js?v='),'agents.js loaded');
assert(html.includes("if(n==='agents'&&!currentUser)return;"),'Agents tab needs sign-in');
assert(/'tbk','tag'\]/.test(html),'panel hide list includes the Agents panel');

const ctx={console,Date,Math,JSON,Number,String,Array,Object,Promise,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},
  localStorage:{getItem:()=>null,setItem(){}},sessionStorage:{getItem:()=>'1',setItem(){}},
  document:{getElementById:()=>null,querySelectorAll:()=>[],addEventListener(){},readyState:'complete',body:{appendChild(){}}},
  currentUser:{username:'tester',role:'admin'},hasAccess:()=>true,isMetalsMarketOpen:()=>true,
  prices:{XAUUSD:2400.5,XAGUSD:30.1,BTCUSD:90000},freshQuote:s=>s!=='XAGUSD',fmtP:(s,v)=>v.toFixed(2),
  activeSignals:{},signalHistory:[],computeSignal:()=>({state:'BUY',reason:'trend not confirmed',smart:{}}),autoEntryCheck:()=>({ok:false,reason:'x'}),
  allPaperRows:()=>[{sym:'XAUUSD',dir:'BUY',outcome:'OPEN'}],scalpToday:()=>({pnl:1.5,wins:2,losses:1}),
  PAPER_LIMITS:{maxOpen:3,dailyLoss:50},istDayKey:()=>'2026-11-26',sigTime:()=>Date.now(),pnlStats:()=>({pnl:0,w:0,l:0,closed:0})};
ctx.globalThis=ctx;vm.createContext(ctx);
vm.runInContext(src,ctx);
const A=ctx.KmrAgents;assert(A,'KmrAgents exported');

const reps=A.reports();
assert.equal(reps[0].id,'atlas','team lead reports first');
assert(reps.length>=8,'admin sees the full team');
for(const r of reps){assert(r.name&&r.line&&typeof r.line==='string','every agent has a spoken line: '+r.id);
  assert(['ok','busy','warn','off','idle'].includes(r.state),'known state for '+r.id);}
assert(new Set(reps.map(r=>r.id)).size===reps.length,'agent ids unique');

for(const q of ['buy gold','sell silver now','close my trade','please buy bitcoin'])
  assert.match(A.answer(q),/can't place or close/,'voice must refuse trade commands: '+q);
assert.match(A.answer('gold price'),/Gold is 2400\.50/);
assert.match(A.answer('silver price'),/not live/,'stale quote is flagged, not presented as live');
assert.match(A.answer('open trades'),/1 paper trade open/);
assert.match(A.answer('low profit'),/plus 1\.50 dollars/);
assert(A.answer('team status').startsWith('ATLAS'),'team roll call answer');

ctx.currentUser={username:'viewer',role:'guest'};ctx.hasAccess=()=>false;
const guest=A.reports().map(r=>r.id);
assert(!guest.includes('bridge')&&!guest.includes('courier'),'guests do not see broker or Telegram agents');
assert.match(A.answer('broker'),/admins only/);
const vaultLine=txt=>{ctx.document.getElementById=id=>id==='riyanSyncBtn'?{textContent:txt}:null;const r=A.AGENTS.find(a=>a.id==='vault').report();ctx.document.getElementById=()=>null;return r;};
assert.equal(vaultLine('☁ DB Synced').state,'ok');assert.equal(vaultLine('☁ Failed 2 · Pending 3').state,'warn');assert.equal(vaultLine('☁ Pending 4').state,'busy');assert.equal(vaultLine('☁ DB Sync').state,'idle');
console.log('agents checks passed');
