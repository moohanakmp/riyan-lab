'use strict';
// Coinbase Exchange BTC-USD: one venue for quotes, indicators, Flow and replay.
// Only completed source bars are returned. Missing intervals are never fabricated.
var BtcFeed = (() => {
  const base='https://api.exchange.coinbase.com/products/BTC-USD';
  const configs={'1m':[60,1],'5m':[300,1],'15m':[900,1],'30m':[900,2],'1h':[3600,1],'4h':[3600,4],'1d':[86400,1]};
  const cache=new Map();
  let requestTail=Promise.resolve();
  function json(url){
    const next=requestTail.then(()=>requestJson(url));
    requestTail=next.catch(()=>{}).then(()=>new Promise(resolve=>setTimeout(resolve,150)));
    return next;
  }
  async function requestJson(url){
    const r=await liveFetch(url);let value;
    try{value=await r.json();}catch(e){throw Error('Coinbase returned invalid JSON');}
    if(!r.ok)throw Error('Coinbase unavailable (HTTP '+(value?.upstreamStatus||r.status)+')');
    return value;
  }
  function normalize(rows,ms,start,end){
    if(!Array.isArray(rows))throw Error('Invalid Coinbase candles');
    const out=new Map();
    for(const row of rows){
      if(!Array.isArray(row)||row.length<6)throw Error('Malformed Coinbase candle');
      const k={t:Number(row[0])*1000,ms,l:Number(row[1]),h:Number(row[2]),o:Number(row[3]),c:Number(row[4]),v:Number(row[5]),complete:true};
      if(!PaperMath.valid(k)||k.t%ms!==0)throw Error('Invalid Coinbase OHLC or timestamp');
      if(k.t<start||k.t+ms>end)continue;
      const previous=out.get(k.t);
      if(previous&&JSON.stringify(previous)!==JSON.stringify(k))throw Error('Conflicting Coinbase candles');
      out.set(k.t,k);
    }
    return [...out.values()].sort((a,b)=>a.t-b.t);
  }
  async function candles(iv,limit,end=Date.now()){
    const cfg=configs[iv];
    if(!cfg||!Number.isInteger(limit)||limit<1||limit>5000||!Number.isFinite(end)||end>Date.now()+60000)throw Error('Unsupported BTC history request');
    const [seconds,factor]=cfg,ms=seconds*1000,targetMs=ms*factor;
    const until=Math.floor(end/targetMs)*targetMs;
    const start=until-limit*targetMs,key=iv+':'+limit+':'+until;
    let entry=cache.get(key);
    if(entry&&entry.expires>Date.now())return (await entry.promise).map(k=>({...k}));
    const promise=(async()=>{
      let cursor=until;const all=[];
      while(cursor>start){
        const from=Math.max(start,cursor-300*ms);
        const url=base+'/candles?granularity='+seconds+'&start='+new Date(from).toISOString()+'&end='+new Date(cursor-1000).toISOString();
        const batch=normalize(await json(url),ms,from,cursor);
        all.push(...batch);cursor=from;
      }
      all.sort((a,b)=>a.t-b.t);
      return factor===1?all:PaperMath.aggregate(all,targetMs/60000,ms);
    })();
    entry={promise,expires:Date.now()+60000};cache.set(key,entry);
    if(cache.size>32)cache.delete(cache.keys().next().value);
    try{return (await promise).map(k=>({...k}));}catch(e){cache.delete(key);throw e;}
  }
  function quote(value,now=Date.now()){
    const price=Number(value?.price),at=Date.parse(value?.time);
    if(!PaperMath.positive(price)||!Number.isFinite(at)||now-at>30000||at>now+5000)throw Error('Coinbase BTC quote is stale or invalid');
    return {price,at};
  }
  return {candles,normalize,quote,ticker:async()=>quote(await requestJson(base+'/ticker')),stats:()=>requestJson(base+'/stats'),source:'Coinbase BTC/USD'};
})();
if(typeof module!=='undefined')module.exports=BtcFeed;
