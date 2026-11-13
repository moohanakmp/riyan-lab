'use strict';
// Live Volume Trap stream: display only. It never places, approves or settles paper
// entries; strategies keep using completed candles from the existing feeds.
// Gold/silver: OKX XAU/XAG-USDT perpetual (public WebSocket, no key).
// Bitcoin: Coinbase Exchange BTC-USD matches (public WebSocket, no key).
var LiveVolume = (() => {
  const OKX_INST={XAUUSD:'XAU-USDT-SWAP',XAGUSD:'XAG-USDT-SWAP'};
  const STALE_MS=20000,FLOW_WINDOW_MS=5*60000,MAX_TRADES=4000;
  let socket=null,businessSocket=null,current=null,retryTimer=null,retries=0,pingTimer=null;
  const states=new Map();
  function blank(sym){
    return {sym,status:'idle',error:'',source:sym==='BTCUSD'?'Coinbase BTC/USD trades (live)':'OKX '+sym.slice(0,3)+'/USDT perp (live)',
      forming:null,closed:[],trades:[],updatedAt:0,connectedAt:0};
  }
  function state(sym){if(!states.has(sym))states.set(sym,blank(sym));return states.get(sym);}
  function num(v){const n=Number(v);return Number.isFinite(n)?n:NaN;}
  // OKX candle rows: [ts,o,h,l,c,vol(contracts),volCcy(base units),volCcyQuote,confirm]
  function okxCandle(row){
    if(!Array.isArray(row)||row.length<9)return null;
    const k={t:num(row[0]),ms:60000,o:num(row[1]),h:num(row[2]),l:num(row[3]),c:num(row[4]),v:num(row[6]),complete:String(row[8])==='1'};
    if(![k.t,k.o,k.h,k.l,k.c,k.v].every(Number.isFinite)||k.t%60000!==0||k.l<=0||k.h<k.l||k.o<k.l||k.o>k.h||k.c<k.l||k.c>k.h||k.v<0)return null;
    return k;
  }
  // Taker side gives real buy/sell aggression for these venues (not an estimate from candle shape).
  function addTrade(s,t,size,takerBuy){
    if(!Number.isFinite(t)||!Number.isFinite(size)||size<=0)return;
    s.trades.push({t,size,buy:!!takerBuy});
    if(s.trades.length>MAX_TRADES)s.trades.splice(0,s.trades.length-MAX_TRADES);
  }
  function addMatch(s,m){
    const t=Date.parse(m.time),price=num(m.price),size=num(m.size);
    if(!Number.isFinite(t)||!(price>0)||!(size>0))return;
    // Coinbase "side" is the maker order side; a sell maker means the taker bought.
    addTrade(s,t,size,m.side==='sell');
    const start=Math.floor(t/60000)*60000;
    if(!s.forming||s.forming.t!==start){
      if(s.forming&&s.forming.t<start){s.closed.push({...s.forming,complete:true,partial:s.forming.partial});if(s.closed.length>60)s.closed.shift();}
      // The first minute after connecting misses earlier trades in that minute.
      s.forming={t:start,ms:60000,o:price,h:price,l:price,c:price,v:0,complete:false,partial:!s.forming&&t-start>2000};
    }
    const k=s.forming;k.h=Math.max(k.h,price);k.l=Math.min(k.l,price);k.c=price;k.v+=size;
    s.updatedAt=Date.now();
  }
  function flow(sym,now=Date.now()){
    const s=state(sym),recent=s.trades.filter(x=>now-x.t<=FLOW_WINDOW_MS);
    const buy=recent.reduce((n,x)=>n+(x.buy?x.size:0),0),total=recent.reduce((n,x)=>n+x.size,0);
    const covered=s.connectedAt?Math.min(FLOW_WINDOW_MS,now-s.connectedAt):0;
    return total>0?{buyPct:buy/total*100,sellPct:100-buy/total*100,count:recent.length,windowMs:covered}:null;
  }
  function stopSockets(){
    clearTimeout(retryTimer);clearInterval(pingTimer);retryTimer=null;pingTimer=null;
    for(const ws of [socket,businessSocket])if(ws){ws.onclose=null;ws.onerror=null;ws.onmessage=null;try{ws.close();}catch(e){}}
    socket=null;businessSocket=null;
  }
  function scheduleRetry(sym){
    if(current!==sym||retryTimer)return;
    const delay=Math.min(60000,2000*2**Math.min(5,retries++));
    const s=state(sym);s.status='reconnecting';
    retryTimer=setTimeout(()=>{retryTimer=null;if(current===sym)connect(sym);},delay);
  }
  function open(url,sym,onOpen,onMessage){
    if(typeof WebSocket==='undefined')throw Error('Live stream not supported in this browser');
    const ws=new WebSocket(url),s=state(sym);
    ws.onopen=()=>{if(current!==sym)return;retries=0;s.status='live';s.error='';s.connectedAt=s.connectedAt||Date.now();onOpen(ws);};
    ws.onmessage=event=>{if(current!==sym||event.data==='pong')return;try{onMessage(JSON.parse(event.data));}catch(e){}};
    ws.onerror=()=>{s.error='Live stream connection failed';};
    ws.onclose=()=>{if(current===sym){s.status='reconnecting';stopSockets();scheduleRetry(sym);}};
    return ws;
  }
  function connect(sym){
    stopSockets();const s=state(sym);s.status='connecting';s.connectedAt=0;
    try{
      if(sym==='BTCUSD'){
        socket=open('wss://ws-feed.exchange.coinbase.com',sym,ws=>ws.send(JSON.stringify({type:'subscribe',product_ids:['BTC-USD'],channels:['matches']})),
          msg=>{if(msg.type==='match'&&msg.product_id==='BTC-USD')addMatch(s,msg);else if(msg.type==='error'){s.error=String(msg.message||'Stream error').slice(0,120);}});
      }else{
        const inst=OKX_INST[sym];
        businessSocket=open('wss://ws.okx.com:8443/ws/v5/business',sym,ws=>ws.send(JSON.stringify({op:'subscribe',args:[{channel:'candle1m',instId:inst}]})),
          msg=>{
            if(msg.event==='error'){s.error=String(msg.msg||'Stream error').slice(0,120);return;}
            if(msg.arg?.channel!=='candle1m'||!Array.isArray(msg.data))return;
            for(const row of msg.data){const k=okxCandle(row);if(!k)continue;
              if(k.complete){if(!s.closed.length||s.closed.at(-1).t<k.t){s.closed.push(k);if(s.closed.length>60)s.closed.shift();}if(s.forming?.t===k.t)s.forming=null;}
              else s.forming=k;
              s.updatedAt=Date.now();}
          });
        socket=open('wss://ws.okx.com:8443/ws/v5/public',sym,ws=>ws.send(JSON.stringify({op:'subscribe',args:[{channel:'trades',instId:inst}]})),
          msg=>{if(msg.arg?.channel!=='trades'||!Array.isArray(msg.data))return;for(const x of msg.data)addTrade(s,num(x.ts),num(x.sz),x.side==='buy');s.updatedAt=Date.now();});
        // OKX closes idle connections after 30s without traffic.
        pingTimer=setInterval(()=>{for(const ws of [socket,businessSocket])try{if(ws?.readyState===1)ws.send('ping');}catch(e){}},20000);
      }
    }catch(e){s.status='unavailable';s.error=String(e.message||e).slice(0,120);}
  }
  function start(sym){
    if(!['XAUUSD','XAGUSD','BTCUSD'].includes(sym))return;
    if(current===sym&&(socket||businessSocket||retryTimer))return;
    current=sym;retries=0;connect(sym);
  }
  function stop(){current=null;stopSockets();}
  function snapshot(sym,now=Date.now()){
    const s=state(sym),fresh=s.updatedAt>0&&now-s.updatedAt<STALE_MS;
    return {sym,status:s.status==='live'&&!fresh&&s.updatedAt>0?'quiet':s.status,error:s.error,source:s.source,
      forming:s.forming&&now-s.forming.t<120000?{...s.forming}:null,closed:s.closed.slice(-30),flow:flow(sym,now),updatedAt:s.updatedAt,fresh};
  }
  return {start,stop,snapshot,_test:{okxCandle,addMatch,addTrade,flow,state,blank,states}};
})();
if(typeof module!=='undefined')module.exports=LiveVolume;
