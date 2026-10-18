'use strict';
// Public delayed futures history. This is a volume/analysis reference, not spot FX
// volume, a broker feed, or permission to execute a trade. Never fabricate bars.
var ReferenceFeed = (() => {
  const instruments=Object.freeze({
    XAUUSD:{ticker:'GC=F',name:'COMEX gold'},XAGUSD:{ticker:'SI=F',name:'COMEX silver'},
    XPTUSD:{ticker:'PL=F',name:'NYMEX platinum'},XPDUSD:{ticker:'PA=F',name:'NYMEX palladium'},
    EURUSD:{ticker:'6E=F',name:'CME euro'},GBPUSD:{ticker:'6B=F',name:'CME British pound'},
    AUDUSD:{ticker:'6A=F',name:'CME Australian dollar'},NZDUSD:{ticker:'6N=F',name:'CME New Zealand dollar'},
    USDJPY:{ticker:'6J=F',name:'CME Japanese yen',inverse:true},
    USDCAD:{ticker:'6C=F',name:'CME Canadian dollar',inverse:true},
    USDCHF:{ticker:'6S=F',name:'CME Swiss franc',inverse:true}
  });
  const frames={'1m':['1m','5d',60000,1],'5m':['5m','1mo',300000,1],
    '15m':['15m','1mo',900000,1],'30m':['30m','1mo',1800000,1],
    '1h':['60m','1y',3600000,1],'4h':['60m','1y',3600000,4],'1d':['1d','5y',86400000,1]};
  const cache=new Map();
  function info(sym){
    const spec=instruments[sym];if(!spec)throw Error('Unsupported reference instrument');
    return {...spec,analysisOnly:true,volumeType:'futures contracts',
      source:spec.name+' futures ('+spec.ticker+') via Yahoo · delayed reference'+(spec.inverse?' · inverse price':'')};
  }
  function url(sym,iv){
    const spec=info(sym),cfg=frames[iv];if(!cfg)throw Error('Unsupported reference timeframe');
    return 'https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(spec.ticker)+'?interval='+cfg[0]+'&range='+cfg[1];
  }
  function normalize(value,sym,iv,now=Date.now()){
    const spec=info(sym),cfg=frames[iv];if(!cfg)throw Error('Unsupported reference timeframe');
    const [interval,,ms,factor]=cfg,chart=value?.chart;
    if(chart?.error)throw Error('Reference provider rejected history request');
    const data=chart?.result?.[0],q=data?.indicators?.quote?.[0];
    if(data?.meta?.symbol!==spec.ticker||data?.meta?.instrumentType!=='FUTURE'||
       ![interval,...(interval==='60m'?['1h']:[])].includes(data?.meta?.dataGranularity)||
       !Array.isArray(data?.timestamp)||!q)throw Error('Invalid reference market or timeframe');
    const times=data.timestamp;
    if(!['open','high','low','close'].every(p=>Array.isArray(q[p])&&q[p].length===times.length)||
       (q.volume!=null&&(!Array.isArray(q.volume)||q.volume.length!==times.length)))throw Error('Incomplete reference response');
    const out=new Map();
    times.forEach((seconds,i)=>{
      if(typeof seconds!=='number'||!Number.isInteger(seconds)||seconds<=0||seconds*1000>now+60000)throw Error('Invalid reference timestamp');
      // Closed markets are represented by null OHLC slots; do not make flat bars.
      if(['open','high','low','close'].some(p=>q[p][i]==null))return;
      if(!['open','high','low','close'].every(p=>typeof q[p][i]==='number'))throw Error('Invalid reference price');
      const k={t:seconds*1000,ms,o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],
        v:q.volume?.[i]??null,complete:true,analysisOnly:true,source:spec.ticker,volumeType:'futures contracts'};
      if(!PaperMath.valid(k))throw Error('Invalid reference candle');
      // Some chart responses append a quote snapshot/session fragment off the
      // interval grid. It is not a complete candle; discard, never round its time.
      if(iv!=='1d'&&k.t%ms!==0)return;
      if(k.t+ms>now-1000)return;
      if(spec.inverse){const {o,h,l,c}=k;k.o=1/o;k.h=1/l;k.l=1/h;k.c=1/c;}
      const previous=out.get(k.t);
      if(previous&&JSON.stringify(previous)!==JSON.stringify(k))throw Error('Conflicting reference candles');
      out.set(k.t,k);
    });
    const bars=[...out.values()].sort((a,b)=>a.t-b.t);
    if(factor===1)return bars;
    return PaperMath.aggregate(bars,ms*factor/60000,ms).map(k=>({...k,analysisOnly:true,source:spec.ticker,volumeType:'futures contracts'}));
  }
  async function candles(sym,iv,limit=700){
    if(!Number.isInteger(limit)||limit<1||limit>5000)throw Error('Unsupported reference history limit');
    const key=url(sym,iv);let entry=cache.get(key);
    if(!entry||entry.until<=Date.now()){
      const promise=(async()=>{
        const r=await liveFetch(key);let data;
        try{data=await r.json();}catch(e){throw Error('Reference provider returned invalid JSON');}
        if(!r.ok)throw Error('Reference history unavailable (HTTP '+(data?.upstreamStatus||r.status)+')');
        return data;
      })();
      entry={promise,until:Date.now()+60000};cache.set(key,entry);
      if(cache.size>32)cache.delete(cache.keys().next().value);
    }
    try{
      const bars=normalize(await entry.promise,sym,iv);
      if(!bars.length)throw Error('Reference provider returned no completed candles');
      return bars.slice(-limit).map(k=>({...k}));
    }catch(e){if(cache.get(key)===entry)cache.delete(key);throw e;}
  }
  return {candles,normalize,info,url,symbols:Object.keys(instruments)};
})();
if(typeof module!=='undefined')module.exports=ReferenceFeed;
