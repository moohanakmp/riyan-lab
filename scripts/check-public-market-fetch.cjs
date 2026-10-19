'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('src/main/resources/static/public-market-fetch.js','utf8');
const gold='https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=15m&limit=100';
const silver=gold.replace('XAUUSDT','XAGUSDT');
function feed(fetch){const ctx=vm.createContext({fetch,URL,Response,AbortSignal,Date,Map,Set,Number,JSON,encodeURIComponent});vm.runInContext(code,ctx);return ctx.PublicMarketFetch;}
(async()=>{
 let calls=[];
 let F=feed(async(url,opts)=>{calls.push({url,opts});return new Response('[1,2]');});
 const [one,two]=await Promise.all([F.request(gold),F.request(gold)]);
 assert.deepEqual(await one.json(),[1,2]);assert.deepEqual(await two.json(),[1,2]);
 assert.equal(calls.length,1);assert.equal(calls[0].opts.credentials,'omit');assert.equal(calls[0].opts.mode,'cors');
 assert.equal(calls[0].url,gold);assert.equal(calls[0].opts.headers,undefined,'never transmit app headers');
 await (await F.request(gold)).json();assert.equal(calls.length,1,'short-lived public cache');
 for(const status of [429,451,403]){
  calls=[];F=feed(async(url,opts)=>{calls.push(url);return new Response('{}',{status});});
  assert.equal((await F.request(gold)).status,status);
  assert.equal((await F.request(silver)).status,503);
  assert.equal(calls.length,1,'host cooldown covers other symbols');
  assert(!calls.some(x=>x.startsWith('/api/')),'explicit denial must never reroute');
 }
 calls=[];F=feed(async(url,opts)=>{calls.push({url,opts});if(!url.startsWith('/api/'))throw new TypeError('CORS unavailable');return new Response('[]');});
 await F.request(gold);assert.equal(calls.length,2);assert(calls[1].url.startsWith('/api/v1/market/data?url='));assert.equal(calls[1].opts.credentials,'same-origin');
 const btc='https://api.exchange.coinbase.com/products/BTC-USD/ticker';
 calls=[];await F.request(btc);assert.equal(calls.length,2);assert.equal(calls[0].url,btc);assert(calls[1].url.startsWith('/api/'),'preserve BTC server fallback on transport failure');
 calls=[];F=feed(async(url,opts)=>{calls.push({url,opts});return new Response('{}');});
 await F.request('https://api.gold-api.com/price/XAU');assert.equal(calls[0].opts.credentials,'omit');assert(!calls[0].url.startsWith('/api/'),'quotes are independent of database');
 assert.equal(F.browserEndpoint('https://api.gold-api.com/price/XAU?secret=1'),null);assert.equal(F.browserEndpoint('https://api.exchange.coinbase.com/products/ETH-USD/ticker'),null);
 for(const url of ['http://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=15m&limit=100',gold+'&callback=evil',gold+'&interval=1m',gold.replace('XAUUSDT','ETHUSDT'),gold.replace('fapi.binance.com','fapi.binance.com.evil.test'),gold.replace('limit=100','limit=9999'),gold.replace('https://','https://user@'),gold+'#fragment'])assert.equal(F.browserEndpoint(url),null);
 assert(F.browserEndpoint(gold));assert(F.browserEndpoint(gold.replace('fapi.binance.com/fapi/v1','api.binance.com/api/v3').replace('XAUUSDT','PAXGUSDT')));
 console.log('PASS original browser market route, coalescing/cache, credential isolation, host cooldowns, no reroute after HTTP rejection, CORS fallback, direct BTC/metals quotes with server fallback and bounded endpoints');
})().catch(e=>{console.error(e);process.exitCode=1;});
