/* Shared OHLCV evidence, not a profit forecast. No network, orders or mutable state. */
(function(root){
'use strict';
const definitions=[
 ['doji','Doji','NEUTRAL'],['hammer','Hammer','BUY'],['invertedHammer','Inverted Hammer','BUY'],['shootingStar','Shooting Star','SELL'],['hangingMan','Hanging Man','SELL'],
 ['bullEngulf','Bullish Engulfing','BUY'],['bearEngulf','Bearish Engulfing','SELL'],['morningStar','Morning Star','BUY'],['eveningStar','Evening Star','SELL'],
 ['soldiers','Three White Soldiers','BUY'],['crows','Three Black Crows','SELL'],['piercing','Piercing Line','BUY'],['darkCloud','Dark Cloud Cover','SELL'],
 ['tweezerTop','Tweezer Top','SELL'],['tweezerBottom','Tweezer Bottom','BUY'],['bullHarami','Bullish Harami','BUY'],['bearHarami','Bearish Harami','SELL'],
 ['insideUp','Three Inside Up','BUY'],['insideDown','Three Inside Down','SELL'],['outsideUp','Three Outside Up','BUY'],['outsideDown','Three Outside Down','SELL'],
 ['risingMethods','Rising Three Methods','BUY'],['fallingMethods','Falling Three Methods','SELL'],['bullMarubozu','Bullish Marubozu','BUY'],['bearMarubozu','Bearish Marubozu','SELL'],
 ['spinning','Spinning Top','NEUTRAL'],['dragonfly','Dragonfly Doji','BUY'],['gravestone','Gravestone Doji','SELL'],['bullTriStar','Bullish Tri-Star','BUY'],['bearTriStar','Bearish Tri-Star','SELL'],['longDoji','Long-Legged Doji','NEUTRAL']
].map(([key,name,dir])=>({key,name,dir}));
const finite=Number.isFinite;
function valid(k){return k&&finite(k.t)&&k.t>0&&['o','h','l','c'].every(p=>finite(k[p])&&k[p]>0)&&k.h>=Math.max(k.o,k.c,k.l)&&k.l<=Math.min(k.o,k.c,k.h)&&(k.v==null||finite(k.v)&&k.v>=0);}
function atr(c){let sum=0,n=0;for(let i=Math.max(1,c.length-14);i<c.length;i++){sum+=Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c));n++;}return n?sum/n:0;}
function shape(k){const r=Math.max(k.h-k.l,1e-12),b=Math.abs(k.c-k.o);return{...k,r,b,up:k.c>k.o,down:k.c<k.o,lo:Math.min(k.o,k.c),hi:Math.max(k.o,k.c),lw:Math.min(k.o,k.c)-k.l,uw:k.h-Math.max(k.o,k.c),doji:b/r<=.1};}
function patterns(c,A){
 const s=c.map(shape),n=s.length-1,k=s[n],p=s[n-1],q=s[n-2];
 if(!q)return definitions.map(d=>({...d,detected:false,confirmed:false}));
 const bias=end=>{const w=s.slice(Math.max(0,end-5),end);return w.length<3?'FLAT':w.at(-1).c>w[0].c+A*.25?'UP':w.at(-1).c<w[0].c-A*.25?'DOWN':'FLAT';};
 const before=bias(n),before2=bias(n-1),before3=bias(n-2),before5=bias(n-4);
 const lower=x=>x.lw>=Math.max(2*x.b,.55*x.r)&&x.uw<=.2*x.r;
 const upper=x=>x.uw>=Math.max(2*x.b,.55*x.r)&&x.lw<=.2*x.r;
 const eng=(a,b,up)=>up?b.down&&a.up&&a.lo<=b.lo&&a.hi>=b.hi&&a.b>b.b:a.down&&b.up&&a.lo<=b.lo&&a.hi>=b.hi&&a.b>b.b;
 const har=(a,b,up)=>(up?b.down&&a.up:b.up&&a.down)&&a.lo>b.lo&&a.hi<b.hi&&a.b<=b.b*.6;
 const hits={
  doji:k.doji,hammer:lower(k)&&!k.doji&&before==='DOWN',invertedHammer:upper(k)&&!k.doji&&before==='DOWN',shootingStar:upper(k)&&!k.doji&&before==='UP',hangingMan:lower(k)&&!k.doji&&before==='UP',
  bullEngulf:eng(k,p,true)&&before2==='DOWN',bearEngulf:eng(k,p,false)&&before2==='UP',
  morningStar:q.down&&q.b/q.r>=.5&&p.b<=q.b*.35&&k.up&&k.c>(q.o+q.c)/2&&before3==='DOWN',
  eveningStar:q.up&&q.b/q.r>=.5&&p.b<=q.b*.35&&k.down&&k.c<(q.o+q.c)/2&&before3==='UP',
  soldiers:[q,p,k].every(x=>x.up&&x.b/x.r>=.55)&&p.c>q.c&&k.c>p.c&&p.o>=q.lo&&p.o<=q.hi&&k.o>=p.lo&&k.o<=p.hi&&before3==='DOWN',
  crows:[q,p,k].every(x=>x.down&&x.b/x.r>=.55)&&p.c<q.c&&k.c<p.c&&p.o>=q.lo&&p.o<=q.hi&&k.o>=p.lo&&k.o<=p.hi&&before3==='UP',
  piercing:p.down&&k.up&&k.o<=p.c+A*.1&&k.c>(p.o+p.c)/2&&k.c<p.o&&before2==='DOWN',
  darkCloud:p.up&&k.down&&k.o>=p.c-A*.1&&k.c<(p.o+p.c)/2&&k.c>p.o&&before2==='UP',
  tweezerTop:p.up&&k.down&&Math.abs(k.h-p.h)<=A*.1&&before2==='UP',tweezerBottom:p.down&&k.up&&Math.abs(k.l-p.l)<=A*.1&&before2==='DOWN',
  bullHarami:har(k,p,true)&&before2==='DOWN',bearHarami:har(k,p,false)&&before2==='UP',
  insideUp:har(p,q,true)&&k.up&&k.c>q.o&&before3==='DOWN',insideDown:har(p,q,false)&&k.down&&k.c<q.o&&before3==='UP',
  outsideUp:eng(p,q,true)&&k.up&&k.c>p.h&&before3==='DOWN',outsideDown:eng(p,q,false)&&k.down&&k.c<p.l&&before3==='UP',
  bullMarubozu:k.up&&k.b/k.r>=.85,bearMarubozu:k.down&&k.b/k.r>=.85,
  spinning:k.b/k.r>.1&&k.b/k.r<=.35&&k.uw>=k.r*.25&&k.lw>=k.r*.25,
  dragonfly:k.doji&&k.lw>=k.r*.65&&k.uw<=k.r*.1&&before==='DOWN',gravestone:k.doji&&k.uw>=k.r*.65&&k.lw<=k.r*.1&&before==='UP',
  bullTriStar:q.doji&&p.doji&&k.doji&&p.h<q.l&&k.l>p.h&&before3==='DOWN',bearTriStar:q.doji&&p.doji&&k.doji&&p.l>q.h&&k.h<p.l&&before3==='UP',
  longDoji:k.doji&&k.uw>=k.r*.35&&k.lw>=k.r*.35
 };
 if(s.length>=5){const first=s[n-4],inner=s.slice(n-3,n);hits.risingMethods=first.up&&first.b/first.r>=.6&&inner.every(x=>x.b<first.b*.6&&x.h<=first.h&&x.l>=first.l)&&k.up&&k.c>first.h&&before5==='UP';hits.fallingMethods=first.down&&first.b/first.r>=.6&&inner.every(x=>x.b<first.b*.6&&x.h<=first.h&&x.l>=first.l)&&k.down&&k.c<first.l&&before5==='DOWN';}
 const needNext=new Set(['hammer','invertedHammer','shootingStar','hangingMan','bullHarami','bearHarami','dragonfly','gravestone','bullTriStar','bearTriStar']);
 const result=definitions.map(d=>({...d,detected:!!hits[d.key],confirmed:!!hits[d.key]&&d.dir!=='NEUTRAL'&&!needNext.has(d.key),confirmation:needNext.has(d.key)?'Needs a later close beyond the pattern high/low':d.dir==='NEUTRAL'?'Indecision; never an entry by itself':'Closed pattern; location, volume and risk still required'}));
 // Only a later CLOSED candle can confirm a one-bar reversal/harami; never look ahead.
 if(c.length>10){const prev=patternsAtPrevious(c,A);for(const d of result){if(prev[d.key]&&(d.dir==='BUY'?k.up&&k.c>p.h:k.down&&k.c<p.l)){d.detected=true;d.confirmed=true;d.confirmation='Later candle closed beyond pattern '+(d.dir==='BUY'?'high':'low');}}}
 return result;
}
function patternsAtPrevious(c,A){
 // Avoid recursive whole-history classification for simple follow-through patterns.
 const p=shape(c.at(-2)),before=c.slice(-8,-2),trend=before.at(-1).c-before[0].c,down=trend<-A*.25,up=trend>A*.25;
 const lo=p.lw>=Math.max(2*p.b,.55*p.r)&&p.uw<=.2*p.r,hi=p.uw>=Math.max(2*p.b,.55*p.r)&&p.lw<=.2*p.r;
 const first=shape(c.at(-4)),middle=shape(c.at(-3)),past=c.slice(-10,-4),priorDir=past.at(-1).c-past[0].c;
 const tri=first.doji&&middle.doji&&p.doji;
 const q=shape(c.at(-3)),har=p.lo>q.lo&&p.hi<q.hi&&p.b<=q.b*.6;
 return{bullTriStar:tri&&middle.h<first.l&&p.l>middle.h&&priorDir<-A*.25,bearTriStar:tri&&middle.l>first.h&&p.h<middle.l&&priorDir>A*.25,hammer:down&&lo&&!p.doji,invertedHammer:down&&hi&&!p.doji,shootingStar:up&&hi&&!p.doji,hangingMan:up&&lo&&!p.doji,dragonfly:down&&p.doji&&p.lw>=p.r*.65&&p.uw<=p.r*.1,gravestone:up&&p.doji&&p.uw>=p.r*.65&&p.lw<=p.r*.1,bullHarami:har&&q.down&&p.up&&down,bearHarami:har&&q.up&&p.down&&up};
}
function pivots(c){const high=[],low=[];for(let i=2;i<c.length-2;i++){const w=c.slice(i-2,i+3);if(w.every((k,j)=>j===2||k.h<c[i].h))high.push({p:c[i].h,t:c[i].t,i});if(w.every((k,j)=>j===2||k.l>c[i].l))low.push({p:c[i].l,t:c[i].t,i});}return{high,low};}
function concepts(c,A){
 const last=c.at(-1),prev=c.at(-2),prior=c.slice(0,-1),pv=pivots(prior),hi=pv.high.at(-1),lo=pv.low.at(-1),items=[];
 const add=(name,dir,active,detail,level=null)=>items.push({name,dir,active:!!active,detail,level});
 const beforeHi=pv.high.at(-2),beforeLo=pv.low.at(-2),oldTrend=beforeHi&&beforeLo&&hi&&lo?(hi.p>beforeHi.p&&lo.p>beforeLo.p?'BUY':hi.p<beforeHi.p&&lo.p<beforeLo.p?'SELL':null):null;
 const breakUp=hi&&prev.c<=hi.p&&last.c>hi.p,breakDown=lo&&prev.c>=lo.p&&last.c<lo.p;
 add('Break of structure',breakUp?'BUY':breakDown?'SELL':'NEUTRAL',breakUp||breakDown,'Closed beyond a prior confirmed swing',breakUp?hi?.p:lo?.p);
 add('Change of character',breakUp?'BUY':breakDown?'SELL':'NEUTRAL',breakUp&&oldTrend==='SELL'||breakDown&&oldTrend==='BUY','First close through the opposing swing of the prior structure',breakUp?hi?.p:lo?.p);
 const sweepUp=hi&&last.h>hi.p&&last.c<hi.p,sweepDown=lo&&last.l<lo.p&&last.c>lo.p;
 add('Liquidity sweep',sweepDown?'BUY':sweepUp?'SELL':'NEUTRAL',sweepDown||sweepUp,'Wick crossed a prior swing and closed back inside',sweepDown?lo?.p:hi?.p);
 const displacement=Math.abs(last.c-last.o)>=.8*A&&(last.h-last.l)>0&&Math.abs(last.c-last.o)/(last.h-last.l)>=.65;
 add('Displacement',last.c>last.o?'BUY':'SELL',displacement,'Directional body ≥ 0.8 ATR and ≥ 65% of candle range');
 const gaps=[];
 for(let i=Math.max(2,c.length-45);i<c.length-1;i++){
  const a=c[i-2],b=c[i-1],d=c[i];if(Math.abs(b.c-b.o)<A*.5)continue;
  let g=d.l>a.h?{dir:'BUY',low:a.h,high:d.l,i}:d.h<a.l?{dir:'SELL',low:d.h,high:a.l,i}:null;
  if(g&&g.high-g.low>=A*.1)gaps.push(g);
 }
 const alive=gaps.filter(g=>c.slice(g.i+1,-1).every(k=>g.dir==='BUY'?k.c>=g.low:k.c<=g.high));
 const fvg=alive.filter(g=>last.l<=g.high&&last.h>=g.low&&(g.dir==='BUY'?last.c>g.high&&last.c>last.o:last.c<g.low&&last.c<last.o)).at(-1);
 add('Fair value gap retest',fvg?.dir||'NEUTRAL',!!fvg,'Prior three-candle gap retested and rejected on this close',fvg?(fvg.low+fvg.high)/2:null);
 const inverse=gaps.map(g=>{const broken=c.findIndex((k,i)=>i>g.i&&i<c.length-1&&(g.dir==='BUY'?k.c<g.low:k.c>g.high));return{...g,broken};}).filter(g=>g.broken>=0&&c.slice(g.broken+1,-1).every(k=>g.dir==='BUY'?k.c<=g.high:k.c>=g.low)).filter(g=>last.l<=g.high&&last.h>=g.low&&(g.dir==='BUY'?last.c<g.low&&last.c<last.o:last.c>g.high&&last.c>last.o)).at(-1);
 add('Inverted FVG retest',inverse?(inverse.dir==='BUY'?'SELL':'BUY'):'NEUTRAL',!!inverse,'Gap invalidated earlier, then retested from the opposite side',inverse?(inverse.low+inverse.high)/2:null);
 const blocks=[];
 for(let i=Math.max(1,c.length-40);i<c.length-1;i++){
  const b=c[i-1],d=c[i];if(Math.abs(d.c-d.o)<A*.8)continue;
  const dir=d.c>d.o&&b.c<b.o&&d.c>b.h?'BUY':d.c<d.o&&b.c>b.o&&d.c<b.l?'SELL':null;
  if(dir&&c.slice(i+1,-1).every(k=>dir==='BUY'?k.c>=b.l:k.c<=b.h)&&last.l<=b.h&&last.h>=b.l&&(dir==='BUY'?last.c>b.h&&last.c>last.o:last.c<b.l&&last.c<last.o))blocks.push({dir,low:b.l,high:b.h});
 }
 const ob=blocks.at(-1);add('Order block retest',ob?.dir||'NEUTRAL',!!ob,'Last opposing candle before displacement, not invalidated before retest',ob?(ob.low+ob.high)/2:null);
 const equalHigh=hi&&pv.high.slice(0,-1).some(p=>Math.abs(p.p-hi.p)<=.15*A),equalLow=lo&&pv.low.slice(0,-1).some(p=>Math.abs(p.p-lo.p)<=.15*A);
 add('Internal range liquidity','NEUTRAL',equalHigh||equalLow,'At least two confirmed highs/lows cluster within 0.15 ATR');
 return items;
}
function analyze(bars,options={}){
 const step=options.step||300000,now=options.now??Date.now();
 if(!Array.isArray(bars)||bars.some((k,i)=>!valid(k)||i&&k.t<=bars[i-1].t))return{ready:false,reason:'Invalid OHLCV history',patterns:[],concepts:[],rows:[]};
 const c=bars.filter(k=>k.t+step<=now&&k.complete!==false);
 if(c.length<30)return{ready:false,reason:'Needs 30 closed candles',patterns:[],concepts:[],rows:[]};
 if(c.slice(-30).some((k,i,a)=>i&&k.t-a[i-1].t!==step))return{ready:false,reason:'Recent candle history has gaps',patterns:[],concepts:[],rows:[]};
 const A=atr(c),last=c.at(-1),volOk=c.slice(-21).every(k=>finite(k.v)&&k.v>0),average=c.slice(-21,-1).reduce((a,k)=>a+(k.v||0),0)/20;
 let cvd=0,obv=0;
 const rows=c.slice(-60).map((k,i,a)=>{const buy=(k.v||0)*(k.h>k.l?(k.c-k.l)/(k.h-k.l):.5),sell=(k.v||0)-buy,delta=buy-sell;cvd+=delta;if(i)obv+=(k.c>a[i-1].c?1:k.c<a[i-1].c?-1:0)*(k.v||0);return{...k,buy,sell,delta,cvd,obv};});
 const recent=rows.slice(-20),volume=recent.reduce((n,k)=>n+(k.v||0),0),buy=recent.reduce((n,k)=>n+k.buy,0),delta=recent.reduce((n,k)=>n+k.delta,0);
 const relVol=volOk&&average>0?last.v/average:null,cmf=volume>0?delta/volume:null;
 const vwap=volume>0?recent.reduce((n,k)=>n+(k.h+k.l+k.c)/3*(k.v||0),0)/volume:null;
 const tail=rows.at(-1),slope=tail.cvd-rows.at(-6).cvd,priceChange=last.c-c.at(-6).c;
 const pressure=volOk&&volume>0?buy/volume*100:null;
 const direction=volOk&&relVol>=1&&tail.delta>0&&slope>0&&last.c>last.o?'BUY':volOk&&relVol>=1&&tail.delta<0&&slope<0&&last.c<last.o?'SELL':'MIXED';
 const divergent=priceChange>0&&slope<0?'BEARISH':priceChange<0&&slope>0?'BULLISH':null;
 const signals=concepts(c,A),catalog=patterns(c,A),range=last.h-last.l;
 const absorption=relVol>=1.5&&range>0&&Math.abs(last.c-last.o)/range<=.35&&(Math.max(last.o,last.c)-last.l>=range*.55||last.h-Math.min(last.o,last.c)>=range*.55);
 return{ready:true,step,entryData:!c.some(k=>k.analysisOnly)&&now-last.t<=step*2,lastAt:last.t,A,patterns:catalog,concepts:signals,rows,volumeReady:volOk,relVol,cmf,vwap,pressure,delta:volOk?tail.delta:null,cvd:volOk?tail.cvd:null,obv:volOk?tail.obv:null,momentum:direction,divergence:divergent,absorptionCandidate:volOk&&absorption,
  deltaMethod:'Estimated from candle close location; not trade-side delta',footprintAvailable:false,
  triggerBuy:catalog.some(p=>p.confirmed&&p.dir==='BUY'),triggerSell:catalog.some(p=>p.confirmed&&p.dir==='SELL'),
  note:'Patterns are contextual evidence, not stand-alone orders. Weekday direction claims are unvalidated and are not entry rules.'};
}
const api={definitions,analyze};root.MarketContext=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
