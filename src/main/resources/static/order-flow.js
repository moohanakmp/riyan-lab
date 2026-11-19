'use strict';
// Order flow footprint built from live exchange trades (display only).
// Each trade carries the real taker side, so buy/sell volume at each price is measured,
// not estimated from candle shape. Nothing here reads or writes paper entries.
var OrderFlow = (() => {
  const MINUTE=60000,KEEP_MS=90*MINUTE;
  const STEPS=[0.001,0.002,0.005,0.01,0.02,0.05,0.1,0.2,0.25,0.5,1,2,2.5,5,10,20,25,50,100,250,500];
  function book(){return {mins:new Map(),gaps:[[-Infinity,Infinity]],lastAt:0};}
  const key=p=>Math.round(p*1e4)/1e4;
  // Stream coverage: a candle that overlaps a disconnected period is marked partial.
  function online(b,at){const g=b.gaps.at(-1);if(g&&g[1]===Infinity)g[1]=at;}
  function offline(b,at){const g=b.gaps.at(-1);if(!g||g[1]!==Infinity){b.gaps.push([at,Infinity]);if(b.gaps.length>20)b.gaps.splice(1,1);}}
  function partial(b,t,ms){return b.gaps.some(([a,z])=>a<t+ms&&z>t);}
  function add(b,t,price,size,buy){
    if(!Number.isFinite(t)||!(price>0)||!(size>0))return false;
    const start=Math.floor(t/MINUTE)*MINUTE;let m=b.mins.get(start);
    if(!m){m={t:start,o:price,h:price,l:price,c:price,first:t,last:t,buy:0,sell:0,n:0,cells:new Map()};b.mins.set(start,m);}
    if(t<m.first){m.first=t;m.o=price;}
    if(t>=m.last){m.last=t;m.c=price;}
    m.h=Math.max(m.h,price);m.l=Math.min(m.l,price);m.n++;
    const k=key(price),cell=m.cells.get(k)||{b:0,s:0};
    if(buy){cell.b+=size;m.buy+=size;}else{cell.s+=size;m.sell+=size;}
    m.cells.set(k,cell);b.lastAt=Math.max(b.lastAt,t);
    if(b.mins.size>KEEP_MS/MINUTE+5){const cut=b.lastAt-KEEP_MS;for(const s of b.mins.keys())if(s<cut)b.mins.delete(s);}
    return true;
  }
  // Merge one-minute buckets into the chosen timeframe (1m or 5m). Gaps stay gaps.
  function candles(b,tfMs,now=Date.now(),limit=12){
    const out=new Map();
    for(const m of [...b.mins.values()].sort((x,y)=>x.t-y.t)){
      const t=Math.floor(m.t/tfMs)*tfMs;let k=out.get(t);
      if(!k){k={t,ms:tfMs,o:m.o,h:m.h,l:m.l,c:m.c,buy:0,sell:0,n:0,cells:new Map()};out.set(t,k);}
      k.h=Math.max(k.h,m.h);k.l=Math.min(k.l,m.l);k.c=m.c;k.buy+=m.buy;k.sell+=m.sell;k.n+=m.n;
      for(const [p,c] of m.cells){const x=k.cells.get(p)||{b:0,s:0};x.b+=c.b;x.s+=c.s;k.cells.set(p,x);}
    }
    const rows=[...out.values()].slice(-limit);
    for(const k of rows){k.v=k.buy+k.sell;k.delta=k.buy-k.sell;k.complete=now>=k.t+tfMs;k.partial=partial(b,k.t,tfMs);}
    let cvd=0;for(const k of rows){cvd+=k.delta;k.cvd=cvd;}
    return rows;
  }
  // One price step for the whole chart so rows line up across candles (about 12 rows per candle).
  function stepFor(rows,target=12,spanTarget=Infinity){
    const range=Math.max(0,...rows.map(k=>k.h-k.l));
    const span=rows.length?Math.max(...rows.map(k=>k.h))-Math.min(...rows.map(k=>k.l)):0;
    if(!(range>0)&&!(span>0))return STEPS[3];
    return STEPS.find(s=>range/s<=target&&span/s<=spanTarget)||STEPS.at(-1);
  }
  function ladder(k,step){
    const map=new Map();
    for(const [p,c] of k.cells){const lv=Math.round(Math.floor(p/step+1e-9)*step*1e6)/1e6,x=map.get(lv)||{p:lv,b:0,s:0};x.b+=c.b;x.s+=c.s;map.set(lv,x);}
    return [...map.values()].sort((a,b)=>b.p-a.p);
  }
  // Absorption candidate: the busiest price sits at the candle's extreme, the aggressive
  // side there is the one that failed (big buying at the high but the close is lower).
  function absorption(k,levels){
    if(!k.complete||levels.length<3)return null;
    const tot=x=>x.b+x.s,avg=levels.reduce((n,x)=>n+tot(x),0)/levels.length;
    const top=levels.slice(0,2),bottom=levels.slice(-2);
    const hi=top.reduce((a,x)=>tot(x)>tot(a)?x:a),lo=bottom.reduce((a,x)=>tot(x)>tot(a)?x:a);
    if(tot(hi)>=2*avg&&hi.b>hi.s&&k.c<hi.p)return {p:hi.p,side:'BUY',note:'Heavy buying at the high, price could not go higher'};
    if(tot(lo)>=2*avg&&lo.s>lo.b&&k.c>lo.p)return {p:lo.p,side:'SELL',note:'Heavy selling at the low, price could not go lower'};
    return null;
  }
  // Three-state guide: price + delta agree = trend, delta shrinking = warning, delta flips = act.
  // Uses closed, fully covered candles only so an alert does not flicker inside a candle.
  function trend(rows,scale=1){
    const c=rows.filter(k=>k.complete&&!k.partial&&k.v>0).slice(-4);
    if(c.length<3)return {state:'WAIT',label:'Collecting candles',reason:'Needs 3 closed candles with full live coverage.'};
    const [a,b,z]=c.slice(-3),d=[a.delta,b.delta,z.delta],strong=k=>Math.abs(k.delta)>=0.1*k.v;
    const fmt=v=>(v>0?'+':'')+v.toLocaleString('en-IN',{maximumFractionDigits:v>=-10&&v<=10?3:0});
    const seq=d.map(v=>fmt(v*scale)).join(' → ');
    if(a.delta>0&&b.delta>0&&z.delta<0&&strong(z)&&z.c<z.o)
      return {state:'SELL',label:'Sell trend',badge:'ACT',reason:'Delta flipped from + to −: sellers have taken over.',seq,at:z.t};
    if(a.delta<0&&b.delta<0&&z.delta>0&&strong(z)&&z.c>z.o)
      return {state:'BUY',label:'Buy trend',badge:'ACT',reason:'Delta flipped from − to +: buyers have taken over.',seq,at:z.t};
    const ab=absorption(z,ladder(z,stepFor([z])));
    if(d.every(x=>x>0)&&d[0]>d[1]&&d[1]>d[2]&&z.h>=Math.max(a.h,b.h)-1e-9)
      return {state:'WARN',label:'Warning',badge:'WARNING',reason:'Price still making highs but buying delta is shrinking. Buyers are getting tired.',seq,at:z.t};
    if(d.every(x=>x<0)&&d[0]<d[1]&&d[1]<d[2]&&z.l<=Math.min(a.l,b.l)+1e-9)
      return {state:'WARN',label:'Warning',badge:'WARNING',reason:'Price still making lows but selling delta is shrinking. Sellers are getting tired.',seq,at:z.t};
    if(ab&&(ab.side==='BUY'?z.delta>0:z.delta<0))
      return {state:'WARN',label:'Warning',badge:'WARNING',reason:'Absorption: '+ab.note.toLowerCase()+'.',seq,at:z.t};
    if(d.every(x=>x>0)&&[a,b,z].every(strong)&&z.c>a.c)
      return {state:'BUY',label:'Buy trend',badge:'HEALTHY',reason:'Price up and delta strongly positive: buyers are in control.',seq,at:z.t};
    if(d.every(x=>x<0)&&[a,b,z].every(strong)&&z.c<a.c)
      return {state:'SELL',label:'Sell trend',badge:'HEALTHY',reason:'Price down and delta strongly negative: sellers are in control.',seq,at:z.t};
    return {state:'NEUTRAL',label:'No clear trend',reason:'Price and delta are mixed.',seq,at:z.t};
  }
  return {book,add,online,offline,partial,candles,stepFor,ladder,absorption,trend,MINUTE};
})();
if(typeof module!=='undefined')module.exports=OrderFlow;
