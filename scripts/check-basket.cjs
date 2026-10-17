const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const PaperMath=require('../src/main/resources/static/trading-core.js');
const source=fs.readFileSync('src/main/resources/static/basket-demo.js','utf8');
const replay=fs.readFileSync('src/main/resources/static/basket-replay.js','utf8');
const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
assert.match(html, /<script src="\/basket-demo\.js(?:\?v=[^"]+)?"><\/script>/);
assert.match(html, /<script src="\/basket-replay\.js(?:\?v=[^"]+)?"><\/script>/);
assert(html.includes('basketEvaluate(sym)'));
assert(html.includes('basketCandleCheck()'));
const now=Date.now();
let queued=[],calls=[];
const storage=new Map();
const context=vm.createContext({
 Math,Date,console,Map,Set,Array,Object,Number,JSON,PaperMath,paperReady:()=>true,freshQuote:()=>true,
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
 currentUser:{username:'basketowner',role:'user'},
 SPREAD:{XAUUSD:.35,XAGUSD:.03,BTCUSD:5},
 ASSETS:{XAUUSD:{contractSz:100,dec:2},XAGUSD:{contractSz:100,dec:3},BTCUSD:{contractSz:1,dec:1}},
 scalpCfg:{target:2,maxLoss:4,dayStop:8,goal:10,stopAtGoal:true,
   timeStopMin:45,auto:true,continuation:false,assets:{XAUUSD:true,XAGUSD:true,BTCUSD:true}},
 prices:{XAUUSD:100.5,XAGUSD:50,BTCUSD:80000},
 scalpState:{XAUUSD:{feedAt:now,feedError:'',scan:null},XAGUSD:{feedAt:now,feedError:'',scan:null},BTCUSD:{feedAt:now,feedError:''}},
 scalpData:{XAUUSD:[],XAGUSD:[],BTCUSD:[]},
 scalpHist:[],
 scalpToday:()=>({pnl:0,goalHit:false,stopHit:false}),
 istDayKey:t=>Math.floor((t+5.5*3600e3)/864e5),
 kmrClosed:bars=>bars&&bars.length>1?bars.slice(0,-1):(bars||[]),
 riyanQueue:(type,id,payload)=>queued.push({type,id,payload}),
 riyanApi:async()=>[],
 riyanProcessQueue:()=>{},
 fmtP:(s,p)=>p.toFixed(2),
 ICONS:{XAUUSD:'🥇',XAGUSD:'🥈',BTCUSD:'₿'},
 showToast:(...args)=>calls.push(args),
 confirm:()=>true,
 document:{getElementById:()=>null},
 renderScalpTab:()=>{},
 renderScalpLive:()=>{},
 SYMS:['XAUUSD','XAGUSD','BTCUSD'],
 scalpFetch:async()=>[],
 aggMinutes:(candles,min)=>{
   const out=[];for(let i=0;i<candles.length;i+=3)
     out.push({t:candles[i].t,o:candles[i].o,h:Math.max(...candles.slice(i,i+3).map(c=>c.h)),
       l:Math.min(...candles.slice(i,i+3).map(c=>c.l)),c:candles[Math.min(i+2,candles.length-1)].c,v:1});
   return out;
 },
 scalpScan:(sym,bars,c15,h1,ctx)=>({
  dir:'BUY',gatesOk:true,A:0.2,price:bars[bars.length-1].c,
  sym,setup:'Deterministic closed-candle test',why:['confirmed'],barT:bars[bars.length-1].t,
  gates:[{ok:true,label:'No news'}],adx:25,rsi7:55,relVol:1.1,trend:'BULL'
 })
});
vm.runInContext(source,context);
vm.runInContext(replay,context);
const run=(expression)=>vm.runInContext(expression,context);
const candidate={dir:'BUY',A:1,gatesOk:true,setup:'Trend pullback',barT:now-600000,
  gates:[{ok:true,label:'Safe'}],trend:'BULL'};
const recent=[{t:now-1200000,l:99.9,h:101,c:100,o:100},
 {t:now-900000,l:99.8,h:100.8,c:100,o:100},
 {t:now-600000,l:99.7,h:100.6,c:100,o:100}];
context.demoScan=candidate;context.demoCandles=recent;
const plan=run("basketPlan('XAUUSD',demoScan,100,demoCandles,scalpCfg)");
assert(!plan.reject,'0.01 simulated Gold setup must fit $4 cap when tight enough');
assert.equal(plan.lot,.01);
assert(plan.riskUsd<=4,'single position must not exceed basket $4');
const tooWide=run("basketPlan('XAUUSD',demoScan,100,demoCandles,{maxLoss:.2})");
assert(tooWide.reject,'too-wide 0.01 lot Gold stop must be rejected');
const session={sym:'XAUUSD',dir:'BUY',positions:[{...plan,entry:100}]};
context.plan=plan;context.session=session;
const averaging=run("basketCanAdd(session,plan,100,scalpCfg)");
assert.equal(averaging.ok,false,'no averaging down after spread');
assert.match(averaging.reason,/averaging down/);
const up=run("basketCanAdd(session,plan,105,scalpCfg)");
assert.equal(up.ok,true,'non-losing basket can add only if combined stop risk fits');
const over={...session,positions:Array.from({length:5},()=>({...plan,entry:100}))};
context.fullSession=over;
assert.equal(run("basketCanAdd(fullSession,plan,105,scalpCfg)").ok,false,'5 positions is the strict cap');
assert.equal(run("basketPnlAt(session.positions,100,'XAUUSD')")<0,true,'spread is counted');
const s={id:'paper-case',sym:'XAUUSD',dir:'BUY',status:'OPEN',
 createdAt:now-20*60000,lastCheckedBar:0,positions:[{
 id:'p1',dir:'BUY',entry:100,sl:99,lot:.01,units:1,
 openedAt:now-20*60000
 }]};
context.basketDemo.active=s;context.basketDemo.enabled=true;
context.scalpData.XAUUSD=[
 {t:now-10*60000,o:100,h:104,l:98,c:103,v:2},
 {t:now-5*60000,o:103,h:104,l:102,c:103,v:2}
];
run('basketCandleCheck()');
assert.equal(context.basketDemo.active,null,'basket must close on stop');
assert.equal(context.basketDemo.history[0].closeReason,'POSITION_STOP',
 'if same candle reaches SL and target, stop must take precedence');
assert(context.basketDemo.history[0].netPnl<0,'stop exit must record loss');
assert(queued.some(x=>x.type==='basket-sessions'),'sessions must be queued for PostgreSQL');
assert(queued.some(x=>x.type==='basket-positions'),'positions must be queued');
assert(queued.some(x=>x.type==='basket-events'),'events must be queued');
assert(queued.every(x=>x.id.startsWith('basketowner:')),'owner-scoped source ID required');
const old=run('basketDemo.enabled');
assert.equal(old,true,'demo on/off is independent of original scalpCfg.auto');
const series=Array.from({length:290},(_,i)=>{
 const o=100+i*.035;return{t:now-(290-i)*300000,o,h:o+.12,l:o-.08,c:o+.035,v:100};
});
context.history=series;
const results=run("basketReplaySimulation('XAUUSD',history,scalpCfg)");
assert.equal(results.ok,true);
assert(results.positions>0,'synthetic confirmed candles should open paper positions');
assert(results.maxPositions<=5,'replay may never open more than five positions');
assert(results.baskets>0,'replay should close and report at least one basket');
assert(results.assumptions.some(x=>x.includes('no commission')), 'replay must disclose omitted costs');
assert(!source.includes('mt5_executor')&&!source.includes('execute-demo'),
 'paper mode must not call MT5');

// Three safety regressions: corrupt saved positions cannot bypass combined risk,
// the configured +$2 NET target exits all simulated positions, and no real orders.
context.corruptSession={sym:'XAUUSD',dir:'BUY',status:'OPEN',positions:[
 {dir:'BUY',entry:100,sl:NaN,units:1}
]};
assert.equal(run("basketCanAdd(corruptSession,plan,105,scalpCfg)").ok,false,
 'invalid restored stop must fail closed instead of returning NaN risk');
const targetSession={
 id:'basket-target-test',sym:'XAUUSD',dir:'BUY',status:'OPEN',
 createdAt:now-2*60000,lastCheckedBar:0,
 positions:[
  {id:'basket-tp-1',dir:'BUY',entry:100,sl:99.5,units:1,lot:0.01,status:'OPEN'},
  {id:'basket-tp-2',dir:'BUY',entry:100,sl:99.5,units:1,lot:0.01,status:'OPEN'}
 ]
};
context.basketDemo.active=targetSession;
context.basketDemo.enabled=true;
context.scalpState.XAUUSD.feedAt=Date.now();
context.scalpState.XAUUSD.feedError='';
context.prices.XAUUSD=101.5;
run('basketManage()');
assert.equal(context.basketDemo.active,null,
 'basket +$2 target closes all positions, not a partial order');
const netClosed=context.basketDemo.history[0];
assert.equal(netClosed.id,'basket-target-test');
assert.equal(netClosed.positions.length,2);
assert(netClosed.positions.every(p=>p.status==='CLOSED'),'both paper positions must close');
assert(netClosed.netPnl>=2,'net after modeled spread must meet $2');
assert.equal(netClosed.closeReason,'NET_TP');
assert(queued.filter(x=>x.type==='basket-positions').length>=3,
 'all position state transitions must queue for PostgreSQL');
console.log('PASS: +$2 NET closes entire basket, corrupt risk fails closed, audit events persist');

console.log('PASS: paper-only basket entries, 0.01 sizing, combined risk, non-losing additions, five-position cap');
console.log('PASS: conservative stop before profit, owner-scoped audit ledger, next-bar replay summary');

(async()=>{
 context.riyanReadAll=async()=>[];
 assert.equal(await run('basketDbRestore()'),true,'empty server history is a successful restore');
 assert.equal(context.basketDemo.active,null);
 const position={id:'recovered',basketId:'lost-response',sym:'XAUUSD',dir:'BUY',status:'OPEN',entry:100,sl:99,units:1,openedAt:now};
 context.riyanReadAll=async type=>type==='basket-positions'?[{payload:position}]:[];
 assert.equal(await run('basketDbRestore()'),true);
 assert.equal(context.basketDemo.active.id,'lost-response','committed position reconstructs missing session');
 assert.equal(context.basketDemo.active.positions.length,1);
 position.status='CLOSED';position.closedAt=now+1;position.pnl=1.65;
 assert.equal(await run('basketDbRestore()'),true);
 assert.equal(context.basketDemo.active,null);
 assert.equal(context.basketDemo.history[0].netPnl,1.65);
 console.log('PASS: empty basket restore, lost-response reconstruction and authoritative closed history');
})().catch(error=>{console.error(error);process.exitCode=1;});
