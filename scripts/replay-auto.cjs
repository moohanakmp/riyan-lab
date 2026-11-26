'use strict';
// Offline replay of the server background Auto engine over saved candle history.
// Usage: SCANNER_STATIC=<static dir> node scripts/replay-auto.cjs candles.json [fromISO] [toISO] [stepMin]
// candles.json = {SYM:{'5m':[],'15m':[],'1h':[],'4h':[]}} of CLOSED bars {t,ms,o,h,l,c,v}.
// Runs the real scanner.cjs scan() every step with price = last closed 5m close and no
// news calendar (news gate not replayed). Only Auto signals are kept; Low Profit is ignored.
// Prints one JSON line per Auto signal plus a summary. Research tool: needs no network.
const fs=require('node:fs');
const {scan}=require('../src/main/resources/background/scanner.cjs');
const [file,fromArg,toArg,stepArg]=process.argv.slice(2);
const data=JSON.parse(fs.readFileSync(file,'utf8'));
const step=(+stepArg||5)*60000;
const syms=['XAUUSD','XAGUSD','BTCUSD'].filter(s=>data[s]);
const to=toArg?Date.parse(toArg):data.end;
const from=fromArg?Date.parse(fromArg):to-14*864e5;
const LIMIT={'15m':700,'1h':300,'4h':300};
function upTo(arr,now,n){let hi=arr.length;while(hi>0&&arr[hi-1].t+arr[hi-1].ms>now)hi--;return arr.slice(Math.max(0,hi-n),hi);}
(async()=>{
 const records=new Map(),reasons={};
 for(let now=from;now<=to;now+=step){
  const feeds={};
  for(const sym of syms){
   const d=data[sym],five=upTo(d['5m'],now,300);if(!five.length)continue;
   const bars={};for(const tf of ['15m','1h','4h'])bars[tf]=upTo(d[tf],now,LIMIT[tf]);
   feeds[sym]={price:five.at(-1).c,quoteAt:now-1000,five,bars,source:'replay'};
  }
  const history=[...records.values()].map(r=>({id:String(r.id),type:'auto-signals',record:r}));
  const res=await scan({username:'replay',role:'admin',now,history,config:{auto:true},allowEntries:true,calendar:[],calendarAt:now,feeds});
  for(const ch of res.changes)if(ch.type==='auto-signals'){
   const isNew=!records.has(ch.id);records.set(ch.id,ch.record);
   if(isNew)console.log(JSON.stringify({event:'OPEN',at:new Date(now).toISOString(),sym:ch.record.sym,dir:ch.record.dir,tier:ch.record.confidence,price:ch.record.price,sl:ch.record.sl,tp1:ch.record.tp1,led4h:!!ch.record.why?.led4h}));
  }
  for(const sym of syms){const a=res.diagnostics[sym]?.auto||'';const k=a.replace(/[0-9.]+/g,'#').slice(0,70);reasons[sym]=reasons[sym]||{};reasons[sym][k]=(reasons[sym][k]||0)+1;}
 }
 const rows=[...records.values()];
 const sum={from:new Date(from).toISOString(),to:new Date(to).toISOString(),signals:rows.length,bySym:{}};
 for(const r of rows){const s=sum.bySym[r.sym]=sum.bySym[r.sym]||{n:0,win:0,loss:0,be:0,open:0,pnlUsd:0,led4h:0,led4hPnl:0};
  s.n++;const o=r.outcome;if(o==='OPEN')s.open++;else if(o==='WIN')s.win++;else if(o==='LOSS')s.loss++;else s.be++;
  s.pnlUsd+=+(r.pnlUsd||0);if(r.why?.led4h){s.led4h++;s.led4hPnl+=+(r.pnlUsd||0);}}
 for(const s of Object.values(sum.bySym)){s.pnlUsd=+s.pnlUsd.toFixed(2);s.led4hPnl=+s.led4hPnl.toFixed(2);}
 sum.topSkipReasons=Object.fromEntries(Object.entries(reasons).map(([k,v])=>[k,Object.entries(v).sort((a,b)=>b[1]-a[1]).slice(0,4)]));
 for(const r of rows)console.log(JSON.stringify({event:'RESULT',sym:r.sym,dir:r.dir,opened:new Date(r.ts).toISOString(),outcome:r.outcome,pnlUsd:r.pnlUsd,led4h:!!r.why?.led4h}));
 console.log(JSON.stringify({event:'SUMMARY',...sum},null,1));
})().catch(e=>{console.error(e);process.exitCode=1;});
