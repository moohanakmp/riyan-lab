'use strict';
// 2026-11-19: order flow footprint, delta/CVD and buy trend / warning / sell trend alerts.
const assert=require('node:assert/strict'),fs=require('node:fs');
const OF=require('../src/main/resources/static/order-flow.js');
const LiveVolume=require('../src/main/resources/static/live-volume.js'),T=LiveVolume._test;
const M=60000,t0=Math.floor(Date.UTC(2026,10,19,13,0)/M)*M;

// ── Footprint: buy/sell volume at each price from the real taker side ──
let b=OF.book();OF.online(b,t0-1000);
OF.add(b,t0+1000,4000.10,3,true);OF.add(b,t0+2000,4000.10,1,false);OF.add(b,t0+3000,4001.40,2,true);OF.add(b,t0+4000,3999.90,5,false);
OF.add(b,t0+5000,-1,1,true);OF.add(b,NaN,4000,1,true);OF.add(b,t0+6000,4000,0,true);
let rows=OF.candles(b,M,t0+30000);
assert.equal(rows.length,1);const k=rows[0];
assert.deepEqual([k.o,k.h,k.l,k.c,k.buy,k.sell,k.v,k.delta,k.n],[4000.10,4001.40,3999.90,3999.90,5,6,11,-1,4],'OHLC, buy/sell and delta from trades; bad trades ignored');
assert.equal(k.complete,false,'forming candle is marked live');assert.equal(k.partial,false);
const lad=OF.ladder(k,1);
assert.deepEqual(lad.map(x=>[x.p,x.b,x.s]),[[4001,2,0],[4000,3,1],[3999,0,5]],'price rows top to bottom, buy right / sell left');
assert.equal(OF.stepFor([{h:4001,l:4000}]),0.1);assert.equal(OF.stepFor([{h:4012,l:4000}]),1);
assert.equal(OF.stepFor([{h:4001,l:4000},{h:4031,l:4030}],12,36),1,'whole chart span limits the row count');

// ── 5m merges five 1m buckets; CVD accumulates; stream gaps mark candles partial ──
b=OF.book();OF.online(b,t0-1000);
for(let i=0;i<10;i++)OF.add(b,t0+i*M+500,100+i,1+i,i%2===0);
rows=OF.candles(b,5*M,t0+10*M);
assert.equal(rows.length,2);assert.equal(rows[0].t,t0);assert.equal(rows[0].v,1+2+3+4+5);
assert.equal(rows[0].delta,1-2+3-4+5);assert.equal(rows[1].cvd,rows[0].delta+rows[1].delta);
assert(rows.every(r=>r.complete&&!r.partial));
OF.offline(b,t0+10*M+10000);OF.online(b,t0+12*M+5000);
OF.add(b,t0+12*M+6000,111,1,true);
const after=OF.candles(b,M,t0+14*M);assert.equal(after.at(-1).partial,true,'minute with a disconnect is partial');
const fresh=OF.book();OF.add(fresh,t0+500,1,1,true);assert.equal(OF.candles(fresh,M,t0+M)[0].partial,true,'trades before the stream is confirmed live are partial');

// ── Three-state guide from the uploaded chart ──
function series(spec){
  const bk=OF.book();OF.online(bk,t0-1000);
  spec.forEach(([o,c,delta,vol],i)=>{const t=t0+i*M,buy=(vol+delta)/2,sell=(vol-delta)/2;
    OF.add(bk,t+1000,o,sell,false);OF.add(bk,t+2000,o,buy,true);OF.add(bk,t+30000,Math.max(o,c)+.2,0.001,true);OF.add(bk,t+40000,Math.min(o,c)-.2,0.001,false);OF.add(bk,t+59000,c,0.001,true);});
  return OF.candles(bk,M,t0+spec.length*M);
}
const healthy=OF.trend(series([[4000,4002,500,1500],[4002,4004,650,1600],[4004,4006,700,1700],[4006,4008,800,1800]]));
assert.equal(healthy.state,'BUY');assert.equal(healthy.badge,'HEALTHY');
const warn=OF.trend(series([[4000,4002,800,1500],[4002,4004,600,1500],[4004,4005,400,1500],[4005,4006,120,1500]]));
assert.equal(warn.state,'WARN','price up but delta shrinking');
const flip=OF.trend(series([[4000,4002,500,1500],[4002,4003,300,1500],[4003,4004,100,1500],[4004,4001,-600,1500]]));
assert.equal(flip.state,'SELL');assert.equal(flip.badge,'ACT','delta flips + to - = sell trend');
const flipUp=OF.trend(series([[4004,4002,-500,1500],[4002,4001,-300,1500],[4001,4000,-100,1500],[4000,4003,600,1500]]));
assert.equal(flipUp.state,'BUY');assert.equal(flipUp.badge,'ACT');
const down=OF.trend(series([[4008,4006,-500,1500],[4006,4004,-650,1600],[4004,4002,-700,1700]]));
assert.equal(down.state,'SELL');assert.equal(down.badge,'HEALTHY');
const warnDown=OF.trend(series([[4008,4006,-800,1500],[4006,4004,-600,1500],[4004,4003,-400,1500],[4003,4002,-120,1500]]));
assert.equal(warnDown.state,'WARN');
assert.equal(OF.trend(series([[4000,4002,500,1500],[4002,4004,650,1600]])).state,'WAIT','needs 3 closed candles');
// Forming candle never triggers: a live flip only counts once the candle closes.
const live=series([[4000,4002,500,1500],[4002,4003,300,1500],[4003,4004,100,1500],[4004,4001,-600,1500]]);live.at(-1).complete=false;
assert.notEqual(OF.trend(live).state,'SELL');
// Partial candles are excluded from alerts.
const part=series([[4000,4002,500,1500],[4002,4003,300,1500],[4003,4004,100,1500],[4004,4001,-600,1500]]);part.at(-1).partial=true;
assert.notEqual(OF.trend(part).badge,'ACT');

// ── Absorption: heavy buying at the high, close below it ──
const ab={complete:true,c:4010.2,cells:null};
const levels=[{p:4012,b:1100,s:800},{p:4011,b:450,s:350},{p:4010,b:220,s:200},{p:4009,b:50,s:50}];
assert.equal(OF.absorption(ab,levels).p,4012);
assert.equal(OF.absorption({complete:true,c:4012.5},levels),null,'no absorption when price closed above');
assert.equal(OF.absorption({complete:false,c:4010},levels),null);

// ── Live stream feeds the footprint; OKX contracts convert to base units ──
const s=T.blank('XAUUSD');
const c=T.okxCandle([String(t0),'4000','4002','3999','4001','500','0.5','2000','0']);assert.equal(c.ctVal,0.001,'contract size from base volume / contracts');
OF.online(s.fp,t0-1000);T.addTrade(s,t0+1000,10,true,4000.5);T.addTrade(s,t0+2000,4,false,4000.2);T.addTrade(s,t0+3000,3,true);
assert.equal(OF.candles(s.fp,M,t0+M)[0].v,14,'trades without a price stay out of the footprint');
assert.equal(s.trades.length,3,'taker flow bar still counts every trade');
T.states.set('XAUUSD',s);s.ctVal=0.001;const fp=LiveVolume.footprint('XAUUSD',M,t0+M);
assert.equal(fp.unit,'XAU units');assert.equal(fp.scale,0.001);
const s2=T.blank('XAGUSD');T.states.set('XAGUSD',s2);assert.equal(LiveVolume.footprint('XAGUSD').unit,'contracts','until the contract size is known');
const btc=T.blank('BTCUSD');T.states.set('BTCUSD',btc);OF.online(btc.fp,t0-1000);
T.addMatch(btc,{time:new Date(t0+1000).toISOString(),price:'90000',size:'0.5',side:'sell'});
assert.equal(OF.candles(btc.fp,M,t0+M)[0].buy,0.5,'Coinbase maker sell = taker buy');

// ── 2026-11-24: server background collector fills minutes this browser did not stream ──
{
  const bk=OF.book();OF.online(bk,t0+3*M+20000);           // page opened mid-minute 3
  OF.add(bk,t0+3*M+30000,100,1,true);OF.add(bk,t0+4*M+1000,101,2,false);
  const sm=(t,extra={})=>({t,o:100,h:101,l:99,c:100.5,buy:3,sell:2,n:5,partial:false,final:true,cells:[[100,3,0],[99,0,2]],...extra});
  for(let i=0;i<4;i++)OF.merge(bk,sm(t0+i*M));             // minutes 0-3 from the server
  OF.merge(bk,sm(t0+4*M,{buy:99}));                          // browser streamed minute 4 fully: kept
  let r=OF.candles(bk,M,t0+5*M);
  assert.deepEqual(r.map(k=>k.t),[0,1,2,3,4].map(i=>t0+i*M),'no missing minutes');
  assert(r.every(k=>!k.partial),'server-complete minutes replace partial ones; none partial');
  assert.equal(r[3].v,5,'partial browser minute 3 replaced by the complete server minute');assert.equal(r[4].sell,2,'complete browser minute kept');
  assert.equal(OF.trend(r).state!=='WAIT',true,'alerts can use server-filled closed candles');
  assert.equal(OF.add(bk,t0+3*M+59000,100,7,true),false,'late live trade for a closed server minute is not counted twice');
  // A forming server minute restarts from the live stream instead of being added to.
  OF.merge(bk,sm(t0+5*M,{final:false}));assert.equal(OF.candles(bk,M,t0+5*M+30000).at(-1).v,5);
  OF.add(bk,t0+5*M+31000,100,1,true);assert.equal(OF.candles(bk,M,t0+5*M+40000).at(-1).v,1);
  // Server says partial: stays partial. 5m candle with one partial minute is partial.
  const p2=OF.book();for(let i=0;i<5;i++)OF.merge(p2,sm(t0+i*M,{partial:i===2}));
  assert.equal(OF.candles(p2,5*M,t0+5*M)[0].partial,true);
  assert.equal(OF.candles(p2,M,t0+5*M)[1].partial,false);
  assert.equal(OF.merge(p2,{t:t0+7,o:1,h:1,l:1,c:1,cells:[]}),false,'misaligned minute rejected');
  // LiveVolume.applyServer merges into the symbol's book and adopts the contract size.
  const xs=T.blank('XAGUSD');T.states.set('XAGUSD',xs);
  T.applyServer('XAGUSD',{boot:'b1',rev:9,scale:0.01,live:true,lastTradeAt:t0,backfill:{state:'complete'},minutes:[sm(t0),sm(t0+M)]},t0+2*M);
  const fx=LiveVolume.footprint('XAGUSD',M,t0+2*M);
  assert.equal(fx.rows.length,2);assert.equal(fx.unit,'XAG units');assert.equal(fx.scale,0.01);assert.equal(fx.server.live,true);
  assert.equal(T.serverInfo('XAGUSD').rev,9);
  assert.throws(()=>T.applyServer('XAGUSD',{minutes:'x'}));
}

// ── Display isolation and UI wiring ──
const src=fs.readFileSync('src/main/resources/static/order-flow.js','utf8');
assert(!/scalpOpen|riyanApi|paperEngine|signalHistory|scalpHist|fetch\(/.test(src),'order flow must not touch entries, persistence or network');
const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
assert(html.indexOf('/order-flow.js')<html.indexOf('/live-volume.js'),'order-flow loads before live-volume');
assert(html.includes('id="volumeTrapFootprint"')&&html.includes('id="flowAlert"'));
assert(html.includes('id="volumeTrapLive"')&&html.includes('id="volumeTrapContainer"'),'existing Volume Trap UI kept');
const {extract}=require('../src/main/resources/background/scanner.cjs');
for(const fn of ['renderVolumeTrapFootprint','flowAlertCheck','showFlowAlert','footprintSvg'])assert(!/scalpOpen\(|riyanApi\(|paperEngine\./.test(extract(fn)),fn+' is display only');
// Delta tables take a just-closed live minute without waiting for the REST poll.
const vm=require('node:vm'),ctx=vm.createContext({PaperMath:require('../src/main/resources/static/trading-core.js'),
  LiveVolume:{snapshot:()=>({closed:[{t:t0+M,ms:M,o:1,h:2,l:1,c:2,v:5,complete:true},{t:t0+3*M,ms:M,o:1,h:2,l:1,c:2,v:5,complete:true},{t:t0+2*M,ms:M,o:1,h:2,l:1,c:2,v:5,complete:true,partial:true}]})}});
vm.runInContext(extract('volumeTrapWithLive'),ctx);
const merged=ctx.volumeTrapWithLive('XAUUSD',[{t:t0,ms:M,o:1,h:2,l:1,c:2,v:5,complete:true}]);
assert.deepEqual(merged.map(x=>x.t),[t0,t0+M],'only contiguous, fully covered live minutes are appended');
console.log('PASS server background minutes fill gaps without double counting, footprint from taker trades, 1m/5m merge, CVD, partial coverage, healthy/warning/flip states (both directions), closed-candle-only alerts, absorption, OKX contract units, display isolation, live minute merge');
