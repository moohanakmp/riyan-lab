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
assert(html.includes("if((n==='agents'||n==='office')&&!currentUser)return;"),'Agents and Office tabs need sign-in');
assert(/'tbk','tag','tof'\]/.test(html),'panel hide list includes the Agents and Office panels');
assert(html.includes('data-tab="office"')&&html.includes('<div id="tof" style="display:none">')&&html.includes('office.js?v='),'Office tab, panel and script');
const office=fs.readFileSync(dir+'office.js','utf8');
assert(!/\beval\s*\(|new Function|riyanApi|fetch\(/.test(office),'Office only reads KmrAgents: no eval and no network calls of its own');

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
ctx.currentUser={username:'tester',role:'admin'};ctx.hasAccess=()=>true;
// ATLAS's server plan: tasks attach to their agent, the lead line summarises them, and the assistant answers from them.
A._test.server.lead={tasks:[{agent:'NIGHT OWL',key:'server-scan',title:'Run the server scan',status:'DONE',evidence:'Scanned 1 account(s)'},
  {agent:'TRAPPER',key:'order-flow',title:'Record the order-flow footprint',status:'BLOCKED',evidence:'No recent order-flow minutes for Gold'}],notes:['Gold: uptrend on 1h and 4h, volatility normal.']};
const planned=A.reports();
assert.equal(planned.find(r=>r.id==='nightowl').task.status,'DONE','agent carries its task from Atlas');
assert.equal(planned.find(r=>r.id==='trapper').task.status,'BLOCKED');
assert.match(planned[0].line,/2 tasks, 1 done, 1 blocked \(TRAPPER\)/,'lead line summarises the plan');
assert.equal(planned[0].state,'warn','a blocked task needs attention');
assert.match(A.answer("what is today's plan"),/Blocked: TRAPPER, No recent order-flow/);
A._test.server.lead=null;A.reports();
const push=fs.readFileSync(dir+'push-client.js','utf8');
for(const bad of ['/paper/','/broker/','/settings'])assert(!push.includes(bad),'push client only touches alert endpoints: '+bad);
assert(html.includes('push-client.js?v=')&&html.includes('id="pushOnBtn"')&&html.includes('id="agentTasks"'),'plan and alert controls on the Agents tab');
const sw=fs.readFileSync(dir+'sw.js','utf8');
assert(sw.includes("addEventListener('push'")&&sw.includes('/api/v1/push/inbox')&&sw.includes('showNotification'),'service worker shows server pushes');
assert(office.includes('tasks --today'),'Office terminal lists the day\'s tasks');
const log=A.log.atlas;assert(log&&log.length>=1&&log.at(-1).line,'status history is recorded for the terminal');
const n=log.length;A.reports();assert.equal(A.log.atlas.length,n,'unchanged status is not logged twice');
const octx={console,Math,String,Date,Object,Array,Number,JSON,document:{readyState:'complete',getElementById:()=>null,addEventListener(){}}};octx.globalThis=octx;vm.createContext(octx);vm.runInContext(office,octx);
const O=octx.KmrOffice._test;for(const wide of [true,false]){const L=O.makeLayout(11,wide);assert.equal(L.slots.length,11);
  for(const s of L.slots)assert(s.cx+16<=L.w&&s.aisleY<L.h,'every desk fits inside the room');}
assert.equal(O.short('Scanning. Gold wait.'),'Scanning.');

// Command center (top of the Agents tab): display only, wired into the panel, real data only.
const cmd=fs.readFileSync(dir+'command.js','utf8');
assert(!/\beval\s*\(|new Function|riyanApi|fetch\(|XMLHttpRequest|localStorage\.setItem/.test(cmd),'command center only reads page state: no eval, network or saved settings');
for(const bad of ['/paper/','/broker/','method:'])assert(!cmd.includes(bad),'command center stays read-only: '+bad);
assert(html.includes('command.js?v=')&&html.includes('id="cmdDeck"')&&html.includes('id="cmdNodes"')&&html.includes('id="agentRollBtn"')&&html.includes('id="agentLead"'),'command center sits on the Agents tab with roll call and lead line');
assert(html.includes('id="cmdPlanner"')&&html.includes('id="cmdVolumeTrap"'),'command center links to Trade Planner and Volume Trap');
const cctx={...ctx,KmrAgents:A,allPaperRows:()=>[{outcome:'WIN',pnlUsd:2.5,closedAt:Date.parse('2026-11-20T06:00:00Z')},{outcome:'LOSS',pnlUsd:-4,closedAt:Date.parse('2026-11-20T08:00:00Z')},{outcome:'OPEN',pnlUsd:0}],
  computeSignal:()=>({smart:{score:73.6,gates:[{key:'htf',ok:true}]}}),sessionSummaryLine:()=>'London session active now'};
cctx.globalThis=cctx;vm.createContext(cctx);vm.runInContext(cmd,cctx);
const C=cctx.KmrCommand._test,cm=C.model();
assert.equal(cm.team.length,reps.length-1,'every agent except the lead is a node around the core');
assert.equal(cm.open,1,'open paper positions counted');
const gold=cm.pulses.find(p=>p.sym==='XAUUSD'),silver=cm.pulses.find(p=>p.sym==='XAGUSD');
assert.equal(gold.score,74,'pulse ring shows the scan quality score');assert.equal(silver.score,null,'no score without a fresh quote');
const day=C.paperDays()['2026-11-20'];assert(day&&day.n===2&&Math.abs(day.pnl+1.5)<1e-9,'calendar groups closed paper results by IST day');
assert.equal(C.dayKey(Date.parse('2026-11-26T19:00:00Z')),'2026-11-27','IST day boundary');
const uid=Object.keys(A.log)[0];A.log[uid].length=0;const t0=Date.now()-60e3;A.log[uid].push({t:t0,state:'ok',line:'a'},{t:t0+45e3,state:'warn',line:'b'});
assert.equal(C.uptime(uid,t0+60e3),75,'health bar = share of time not needing attention');
assert(cm.feed.every(e=>e.name&&Number.isFinite(e.t)),'signal log entries are named and timed');
// Wake word: "Hey Eagle" / "Eagle, listen" / "Eagle, <question>"; ordinary words containing "eagle" do not trigger.
const wp=A.wakeParse;assert.deepEqual({...wp('hey eagle')},{rest:''});assert.deepEqual({...wp('Eagle, listen')},{rest:''});
assert.equal(wp('Hey Eagle what is the gold price').rest,'what is the gold price');assert.equal(wp('eagle listen gold price').rest,'gold price');
assert.equal(wp('the beagle is cute'),null);assert.equal(wp('legal advice'),null);
assert(html.includes('id="agentWakeToggle"'),'wake word switch on the Agents tab');
const headers=fs.readFileSync(__dirname+'/../src/main/java/com/riyanlab/SecurityHeadersFilter.java','utf8');
assert(headers.includes('microphone=(self)')&&!headers.includes('microphone=()'),'the site must allow its own microphone use (voice assistant)');
console.log('agents checks passed');
