'use strict';
// Pure paper-execution rules, shared by the live browser engine and regressions.
// Prices are reference prices; spread is an estimated round-trip cost per unit.
var PaperMath = (() => {
  const positive = n => Number.isFinite(n) && n > 0;
  function valid(k) {
    return k && positive(k.t) && ['o','h','l','c'].every(p => positive(k[p])) &&
      k.h >= Math.max(k.o,k.c,k.l) && k.l <= Math.min(k.o,k.c,k.h) &&
      (k.v == null || (Number.isFinite(k.v) && k.v >= 0));
  }
  function closed(bars, step, now=Date.now()) {
    if (!Array.isArray(bars) || !bars.length) return [];
    step = step || bars[0].ms || (bars.length>1 ? Math.min(...bars.slice(1).map((k,i)=>k.t-bars[i].t)) : 0);
    if (!positive(step) || bars.some((k,i)=>!valid(k)||(i>0&&k.t<=bars[i-1].t))) return [];
    return bars.filter(k=>k.t+step<=now && k.complete!==false);
  }
  function aggregate(bars, minutes, sourceMs=300000) {
    const ms=minutes*60000, buckets=new Map();
    if (!Array.isArray(bars)||ms%sourceMs!==0) return [];
    for (const k of bars) {
      if (!valid(k)||k.t%sourceMs!==0) return [];
      const t=Math.floor(k.t/ms)*ms;
      if(!buckets.has(t)) buckets.set(t,[]);
      buckets.get(t).push(k);
    }
    return [...buckets].sort((a,b)=>a[0]-b[0]).flatMap(([t,ks])=>{
      ks.sort((a,b)=>a.t-b.t);
      if(ks.length!==ms/sourceMs||ks.some((k,i)=>k.t!==t+i*sourceMs)) return [];
      return [{t,ms,o:ks[0].o,h:Math.max(...ks.map(k=>k.h)),l:Math.min(...ks.map(k=>k.l)),
        c:ks.at(-1).c,v:ks.some(k=>k.v==null)?null:ks.reduce((n,k)=>n+k.v,0),n:ks.length,complete:true,
        ...(ks.some(k=>k.analysisOnly)?{analysisOnly:true}:{}),
        ...(ks[0].source?{source:ks.every(k=>k.source===ks[0].source)?ks[0].source:'mixed'}:{})}];
    });
  }
  function stopFill(dir,stop,observed) {
    return dir==='BUY'?Math.min(stop,observed):Math.max(stop,observed);
  }
  function outcome(net) { return net>0.005?'WIN':net<-.005?'LOSS':'BE'; }
  function fill(r,px,fraction,reason,at=Date.now()) {
    const remaining=r.remFrac==null?1:r.remFrac;
    const qty=Math.min(remaining,fraction);
    if(!positive(px)||!positive(r.posUnits)||!positive(qty)) return false;
    const cost=(r.spreadPerUnit||0)*r.posUnits*qty;
    const net=(px-r.price)*(r.dir==='BUY'?1:-1)*r.posUnits*qty-cost;
    r.realUsd=(r.realUsd||0)+net;r.remFrac=Math.max(0,remaining-qty);
    (r.fills||(r.fills=[])).push({at,price:px,units:r.posUnits*qty,fraction:qty,reason,costUsd:cost,netUsd:net});
    r.updatedAt=at;
    if(r.remFrac<1e-9) {
      r.remFrac=0;r.pnlUsd=r.realUsd;r.outcome=outcome(r.pnlUsd);
      r.exitPrice=px;r.closedAt=at;r.exitAt=at;
    }
    return true;
  }
  function ladder(r,quote,at=Date.now()) {
    if(r.outcome!=='OPEN'||!positive(quote)||!positive(r.price)||!positive(r.posUnits)) return false;
    const buy=r.dir==='BUY', crossed=p=>positive(p)&&(buy?quote>=p:quote<=p);
    const sl=r.slNow==null?r.sl:r.slNow;
    // Stops take priority, including a gap through a previously raised stop.
    if(positive(sl)&&(buy?quote<=sl:quote>=sl)) return fill(r,stopFill(r.dir,sl,quote),r.remFrac==null?1:r.remFrac,'STOP',at);
    let changed=false;
    if(!r.tp1Hit&&crossed(r.tp1)) {
      fill(r,r.tp1,.5,'TP1',at);r.tp1Hit=true;r.slNow=r.price;r.beMoved=true;changed=true;
    }
    if(r.tp1Hit&&!r.tp2Hit&&crossed(r.tp2)) {
      fill(r,r.tp2,.3,'TP2',at);r.tp2Hit=true;r.slNow=r.tp1;changed=true;
    }
    if(crossed(r.tp)) {fill(r,r.tp,r.remFrac==null?1:r.remFrac,'TP3',at);changed=true;}
    return changed;
  }
  return {positive,valid,closed,aggregate,stopFill,outcome,fill,ladder};
})();
if(typeof module!=='undefined')module.exports=PaperMath;
