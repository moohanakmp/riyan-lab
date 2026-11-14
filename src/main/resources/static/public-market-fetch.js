'use strict';
// Original public exchange data is fetched by the browser. Never attach application
// cookies/CSRF headers to an external provider. HTTP rejections are not retried via
// the server; the existing server route is used only when browser transport fails.
var PublicMarketFetch=(()=>{
 const cache=new Map(),pending=new Map(),cooldowns=new Map();
 function browserEndpoint(raw){
  try{
   const u=new URL(raw);
   if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash)return null;
   if(u.hostname==='api.gold-api.com'&&['/price/XAU','/price/XAG'].includes(u.pathname)&&!u.search)return u;
   if(u.hostname==='api.exchange.coinbase.com'){
    if(['/products/BTC-USD/ticker','/products/BTC-USD/stats'].includes(u.pathname)&&!u.search)return u;
    if(u.pathname!=='/products/BTC-USD/candles')return null;
    const keys=[...u.searchParams.keys()];
    if(keys.length!==3||new Set(keys).size!==3||keys.some(k=>!['granularity','start','end'].includes(k)))return null;
    const seconds=Number(u.searchParams.get('granularity')),start=Date.parse(u.searchParams.get('start')),end=Date.parse(u.searchParams.get('end'));
    return [60,300,900,3600,21600,86400].includes(seconds)&&Number.isFinite(start)&&start>=0&&Number.isFinite(end)&&end>=start&&end-start<300*seconds*1000&&end<=Date.now()+60000?u:null;
   }
   const allowed=u.hostname==='api.binance.com'&&u.pathname==='/api/v3/klines'
     ||u.hostname==='fapi.binance.com'&&u.pathname==='/fapi/v1/klines';
   if(!allowed)return null;
   const permitted=u.hostname==='api.binance.com'?['PAXGUSDT','BTCUSDT']:['XAUUSDT','XAGUSDT'];
   if(!permitted.includes(u.searchParams.get('symbol'))||
      !['1m','5m','15m','30m','1h','4h','1d','1w','1M'].includes(u.searchParams.get('interval')))return null;
   const keys=[...u.searchParams.keys()];
   if(keys.length!==new Set(keys).size||keys.some(k=>!['symbol','interval','limit','endTime'].includes(k)))return null;
   const limit=u.searchParams.get('limit');
   if(!/^\d+$/.test(limit||'')||+limit<1||+limit>(u.hostname==='api.binance.com'?1000:1500))return null;
   const end=u.searchParams.get('endTime');
   if(end!==null&&(!/^\d+$/.test(end)||+end>Date.now()+60000))return null;
   return u;
  }catch(e){return null;}
 }
 async function server(url){
  return fetch('/api/v1/market/data?url='+encodeURIComponent(url),{
   credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000)});
 }
 async function request(raw){
  const u=browserEndpoint(raw);if(!u)return server(raw);
  const key=u.href,now=Date.now(),saved=cache.get(key);
  if(saved&&saved.until>now)return saved.response.clone();
  const cooldown=cooldowns.get(u.hostname);
  if(cooldown&&cooldown.until>now)
   return new Response(JSON.stringify({error:'Public exchange temporarily unavailable; retry after cooldown',upstreamStatus:cooldown.status}),{status:503,headers:{'Content-Type':'application/json'}});
  let task=pending.get(key);
  if(!task){
   task=(async()=>{
    let r;
    try{r=await fetch(key,{mode:'cors',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(8000)});}
    catch(e){r=await server(raw);}
    // Do not route an explicit browser-side rate/region denial through another path.
    if(r.status===429||r.status===451||r.status===403){
     const retry=Number(r.headers.get('Retry-After'));
     cooldowns.set(u.hostname,{status:r.status,until:Date.now()+Math.max(r.status===429?60000:900000,Number.isFinite(retry)?Math.max(0,retry)*1000:0)});
    }
    cache.set(key,{until:Date.now()+(r.ok?(/\/price\/|\/ticker$/.test(u.pathname)?3000:30000):60000),response:r.clone()});
    if(cache.size>64)cache.delete(cache.keys().next().value);
    return r;
   })();pending.set(key,task);
  }
  try{return (await task).clone();}finally{if(pending.get(key)===task)pending.delete(key);}
 }
 return {request,browserEndpoint};
})();
if(typeof module!=='undefined')module.exports=PublicMarketFetch;
