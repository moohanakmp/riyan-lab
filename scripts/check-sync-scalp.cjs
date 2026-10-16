const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const h=fs.readFileSync('src/main/resources/static/index.html','utf8');
function extract(start,end){
 const a=h.indexOf(start),b=h.indexOf(end,a+start.length);
 if(a<0||b<0)throw new Error('Function marker missing: '+start+' / '+end);
 return h.slice(a,b);
}
(async()=>{
 const block=extract('async function riyanSafeRecordId(type,id){','function riyanQueue(type,id,obj){');
 const ctx=vm.createContext({crypto:webcrypto,TextEncoder});
 vm.runInContext(block,ctx);
 const safe=vm.runInContext('riyanSafeRecordId',ctx);
 const original='USD|Core CPI m/m|1791981000000';
 const first=await safe('gold-calls',original);
 const second=await safe('gold-calls',original);
 assert.match(first,/^id-[a-f0-9]{64}$/);
 assert.equal(first,second,'hash must be stable');
 assert.equal(await safe('auto-signals','1791981000000'),'1791981000000');
 assert.notEqual(await safe('analysis',original),first,'type names are hash namespaces');
 assert(!/[| /%]/.test(first),'path ID cannot contain an encoded slash');
 const veryLong='news/important event'.repeat(100);
 assert.match(await safe('news-alerts',veryLong),/^id-[a-f0-9]{64}$/);
 console.log('PASS URL-safe IDs, exact CPI/m/m regression and deterministic 200-char-safe hashes');

 const agg=extract('function aggMinutes(c,min){','async function scalpFetch(sym,lim){');
 const closedLine=h.match(/function kmrClosed\(arr\)\{[^\n]+\}/)?.[0];
 if(!closedLine)throw new Error('kmrClosed unavailable');
 const select=extract('function scalpClosed15m(sym,c5,now=Date.now()){','// ctx: {now, events, isMetal, marketOpen, spread, cfg, dec}');
 const now=Math.floor(1800000000000/300000)*300000;
 const bars=Array.from({length:300},(_,i)=>{
  const t=now-(300-i)*300000;
  return {t,o:100+i*.01,h:100.3+i*.01,l:99.8+i*.01,c:100.1+i*.01,v:12};
 });
 const context=vm.createContext({ohlcData:{XAUUSD:{'15m':[]}},Date,Math,Array,Object});
 vm.runInContext(closedLine+'\n'+agg+'\n'+select,context);
 const selector=vm.runInContext('scalpClosed15m',context);
 const fallback=selector('XAUUSD',bars,now);
 assert(fallback.length>=55,'derived 15m must have enough candle history');
 assert(fallback.every(x=>x.t+900000<=now-1000),'fallback only uses closed 15m bars');
 const synthetic=Array.from({length:90},(_,i)=>({
   t:now-3*3600000-(90-i)*900000,o:102,h:103,l:101,c:102,v:12
 }));
 context.ohlcData.XAUUSD['15m']=synthetic;
 // Provider 15m has correct scale but its last bar is stale.
 const stale=selector('XAUUSD',bars,now);
 assert(stale.length>=55,'stale 15m provider must recover from 5m');
 assert.equal(stale[stale.length-1].c,fallback[fallback.length-1].c);
 console.log('PASS Low Profit completed 15m fallback, stale-feed recovery and closed-candle gate');
})().catch(e=>{console.error(e);process.exitCode=1;});
