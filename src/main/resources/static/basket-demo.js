'use strict';
// KMR Basket Scalping — PAPER-ONLY experimental module (no MT5 routing).
// This module is loaded before the main inline app; its functions run only
// after the existing authentication and Low Profit app have initialized.
var basketDemo={enabled:false,active:null,history:[],events:[],lastBars:{},replays:{},updatedAt:0};
var basketReplayBusy=false;
function basketKey(){return 'kmr_basket_paper_v1_'+(currentUser?currentUser.username:'anonymous');}
function basketLoad(){
  try{
    var saved=JSON.parse(localStorage.getItem(basketKey())||'null');
    basketDemo=saved&&typeof saved==='object'?
      Object.assign({enabled:false,active:null,history:[],events:[],lastBars:{},replays:{}},saved):
      {enabled:false,active:null,history:[],events:[],lastBars:{},replays:{}};
    basketDemo.replays={};
    if(currentUser&&currentUser.role==='guest')basketDemo.enabled=false;
  }catch(e){console.warn('Basket paper history unavailable',e);}
}
function basketSave(){
  basketDemo.updatedAt=Date.now();
  try{localStorage.setItem(basketKey(),JSON.stringify(basketDemo));}
  catch(e){console.warn('Basket demo local cache could not save',e);}
}
function basketTxt(s){return String(s==null?'':s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function basketMoney(n){return Number.isFinite(n)?(n>=0?'+':'−')+'$'+Math.abs(n).toFixed(2):'—';}
function basketPnlAt(positions,price,sym){
  var spread=SPREAD[sym]||0;
  return positions.reduce((sum,p)=>sum+
    (price-p.entry)*(p.dir==='BUY'?1:-1)*p.units-spread*p.units,0);
}
function basketRiskAtStops(positions,sym){
  var spread=SPREAD[sym]||0;
  return positions.reduce((sum,p)=>sum+Math.max(0,
    (p.entry-p.sl)*(p.dir==='BUY'?1:-1)*p.units+spread*p.units),0);
}
// Always start at 0.01 lot; adding positions is not a way to evade max risk.
function basketPlan(sym,scan,entry,c5,cfg){
  if(!scan||!scan.dir||!scan.gatesOk||!Number.isFinite(entry)||entry<=0||
    !c5||c5.length<3||!Number.isFinite(scan.A)||scan.A<=0)return{reject:'Unverified setup'};
  var units=0.01*ASSETS[sym].contractSz,sgn=scan.dir==='BUY'?1:-1;
  var A=scan.A,spread=SPREAD[sym]||0;
  var last3=c5.slice(-3),ext=sgn>0?
    Math.min(...last3.map(k=>k.l)):Math.max(...last3.map(k=>k.h));
  var swingDistance=Math.abs(entry-ext)+0.15*A;
  var experimental=scan.strategyVersion==='continuation-v1-opt-in';
  if(experimental&&swingDistance>1.3*A)return{reject:'EMA9 swing stop too wide'};
  var dist=experimental?Math.max(0.45*A,swingDistance):
    Math.min(Math.max(swingDistance,A),1.6*A);
  if(!(dist>0&&units>0))return{reject:'Invalid stop distance'};
  var sl=entry-sgn*dist,riskUsd=(dist+spread)*units;
  if(riskUsd>cfg.maxLoss+1e-6)return{reject:
    '0.01 lot stop risk $'+riskUsd.toFixed(2)+' exceeds the $'+cfg.maxLoss+' basket cap'};
  return{entry,sl,dir:scan.dir,lot:0.01,units,riskUsd,sym};
}
function basketCanAdd(session,plan,price,cfg){
  if(plan.reject)return{ok:false,reason:plan.reject};
  if(session&&session.positions.length>=5)return{ok:false,reason:'Five positions reached'};
  if(session&&(session.sym!==plan.sym||session.dir!==plan.dir))
    return{ok:false,reason:'Only one symbol/direction in a basket'};
  if(session&&basketPnlAt(session.positions,price,session.sym)<-1e-8)
    return{ok:false,reason:'No averaging down: existing basket must be non-losing'};
  var total=basketRiskAtStops([...(session?session.positions:[]),plan],plan.sym);
  if(total>cfg.maxLoss+1e-6)return{ok:false,
    reason:'Combined stop risk $'+total.toFixed(2)+' exceeds $'+cfg.maxLoss};
  return{ok:true,totalRiskUsd:total};
}
function basketRecordId(id){return (currentUser?currentUser.username:'unknown')+':'+id;}
function basketPersistSession(session){
  if(!currentUser||currentUser.role==='guest'||!session)return;
  riyanQueue('basket-sessions',basketRecordId(session.id),Object.assign({},
    session,{symbol:session.sym,owner:currentUser.username,paperOnly:true,
      source:'browser-basket-demo',updatedAt:session.updatedAt||session.createdAt}));
}
function basketPersistPosition(session,p){
  if(!currentUser||currentUser.role==='guest')return;
  riyanQueue('basket-positions',basketRecordId(p.id),Object.assign({},
    p,{basketId:session.id,symbol:session.sym,owner:currentUser.username,
      paperOnly:true,source:'browser-basket-demo',updatedAt:p.updatedAt||p.openedAt}));
}
function basketEvent(session,action,details){
  var e={id:'ev-'+Date.now()+'-'+Math.floor(Math.random()*100000),
    basketId:session.id,symbol:session.sym,action,details:details||{},
    createdAt:Date.now(),actor:currentUser?currentUser.username:'unknown',
    paperOnly:true};
  basketDemo.events.unshift(e);basketDemo.events=basketDemo.events.slice(0,250);
  if(currentUser&&currentUser.role!=='guest')
    riyanQueue('basket-events',basketRecordId(e.id),e);
}
function basketClose(price,why,time){
  var s=basketDemo.active;if(!s)return;
  var at=time||Date.now(),net=basketPnlAt(s.positions,price,s.sym);
  s.status='CLOSED';s.exit=price;s.closedAt=at;s.updatedAt=at;s.closeReason=why;s.netPnl=+net.toFixed(4);
  for(var p of s.positions){
    p.status='CLOSED';p.exit=price;p.closedAt=at;p.updatedAt=at;p.closeReason=why;
    p.pnl=+((price-p.entry)*(p.dir==='BUY'?1:-1)*p.units-
      (SPREAD[s.sym]||0)*p.units).toFixed(4);
    basketPersistPosition(s,p);
  }
  basketEvent(s,'CLOSE_ALL',{reason:why,exit:price,netPnl:s.netPnl,
    positions:s.positions.length});
  basketPersistSession(s);
  basketDemo.history.unshift(s);basketDemo.history=basketDemo.history.slice(0,100);
  basketDemo.active=null;basketSave();
  if(typeof showToast==='function')showToast('🧺 PAPER '+why+' · '+basketMoney(s.netPnl),
    s.netPnl>=0?'var(--grn)':'var(--red)');
}
function basketToday(){
  var day=istDayKey(Date.now()),closed=basketDemo.history.filter(s=>
    s.status==='CLOSED'&&istDayKey(s.closedAt)===day);
  return{closed,pnl:closed.reduce((v,s)=>v+(s.netPnl||0),0)};
}
function basketProfitTrigger(s,target){
  var units=s.positions.reduce((sum,p)=>sum+p.units,0),
    weighted=s.positions.reduce((sum,p)=>sum+p.entry*p.units,0);
  return units>0?(weighted+(s.dir==='BUY'?1:-1)*
    (target+(SPREAD[s.sym]||0)*units))/units:null;
}
// Conservative OHLC: per-position stops are tested before net basket target.
// In an ambiguous same-candle move assume the adverse fill happens first.
function basketCandleCheck(){
  var s=basketDemo.active;if(!s)return;
  var closed=kmrClosed(scalpData[s.sym]||[]).filter(k=>
    k.t+300000<=Date.now()&&k.t>=s.createdAt&&k.t>(s.lastCheckedBar||0));
  for(var k of closed){
    var stops=s.positions.filter(p=>s.dir==='BUY'?k.l<=p.sl:k.h>=p.sl);
    if(stops.length){
      var px=s.dir==='BUY'?Math.min(...stops.map(p=>p.sl)):
        Math.max(...stops.map(p=>p.sl));
      basketClose(px,'POSITION_STOP',k.t+300000);return;
    }
    var trigger=basketProfitTrigger(s,scalpCfg.target);
    if(trigger!=null&&(s.dir==='BUY'?k.h>=trigger:k.l<=trigger)){
      basketClose(trigger,'NET_TP_CANDLE',k.t+300000);return;
    }
    s.lastCheckedBar=k.t;
  }
}
function basketManage(){
  var s=basketDemo.active;if(!s)return;
  var quote=prices[s.sym],feed=scalpState[s.sym]||{};
  if(!Number.isFinite(quote)||quote<=0||feed.feedError||
     !feed.feedAt||Date.now()-feed.feedAt>12*60000){
    s.warning='Fresh quote unavailable: paper risk exit cannot be verified';return;
  }
  s.warning='';
  var net=basketPnlAt(s.positions,quote,s.sym);
  if(s.positions.some(p=>s.dir==='BUY'?quote<=p.sl:quote>=p.sl)){
    basketClose(quote,'POSITION_STOP');return;
  }
  if(net<=-scalpCfg.maxLoss){basketClose(quote,'NET_STOP');return;}
  if(scalpToday().pnl+basketToday().pnl+net<=-scalpCfg.dayStop){
    basketClose(quote,'DAILY_STOP');return;
  }
  if(net>=scalpCfg.target){basketClose(quote,'NET_TP');return;}
  if(scalpCfg.stopAtGoal&&scalpToday().pnl+basketToday().pnl+net>=scalpCfg.goal){
    basketClose(quote,'DAILY_GOAL');return;
  }
  if(Date.now()-s.createdAt>=scalpCfg.timeStopMin*60000){
    basketClose(quote,'TIME_STOP');return;
  }
}
function basketEvaluate(sym){
  if(!currentUser||currentUser.role==='guest'||!basketDemo.enabled||
     !scalpCfg.auto||!scalpCfg.assets[sym])return;
  if(scalpHist.some(t=>t.status==='OPEN'))return;
  var s=basketDemo.active,st=scalpState[sym]||{},scan=st.scan,
    quote=prices[sym],c5=kmrClosed(scalpData[sym]||[]);
  if(!scan||!scan.dir||!scan.gatesOk||st.block||st.feedError||
     !Number.isFinite(quote)||quote<=0||c5.length<60)return;
  var latest=c5[c5.length-1];
  if(!latest||Date.now()-latest.t>12*60000)return;
  if(s&&(s.sym!==sym||s.dir!==scan.dir))return;
  if(basketDemo.lastBars[sym]===scan.barT)return;
  var ran=(scan.dir==='BUY'?1:-1)*(quote-scan.price);
  if(ran>0.4*scan.A||ran<-0.5*scan.A)return;
  var plan=basketPlan(sym,scan,quote,c5,scalpCfg),
    decision=basketCanAdd(s,plan,quote,scalpCfg);
  if(!decision.ok){basketDemo.blockReason=decision.reason;return;}
  var day=scalpToday(),basketDay=basketToday();
  if(day.stopHit||(day.goalHit&&scalpCfg.stopAtGoal)||
     (scalpCfg.stopAtGoal&&day.pnl+basketDay.pnl>=scalpCfg.goal)||
     day.pnl+basketDay.pnl<=-scalpCfg.dayStop)return;
  var session=s;
  if(!session){
    session={id:'basket-'+Date.now()+'-'+Math.floor(Math.random()*10000),
      sym,dir:scan.dir,status:'OPEN',createdAt:Date.now(),
      positions:[],lastCheckedBar:scan.barT,paperOnly:true,netPnl:0};
    basketDemo.active=session;
  }
  var pos={id:'paper-'+Date.now()+'-'+Math.floor(Math.random()*100000),
    sym,dir:scan.dir,status:'OPEN',entry:quote,sl:plan.sl,
    units:plan.units,lot:0.01,estimatedStopLossUsd:plan.riskUsd,
    openedAt:Date.now(),confirmed5mBar:scan.barT,setup:scan.setup,
    reason:scan.setup,why:scan.why,
    conditions:{trend:scan.trend,adx:scan.adx,rsi7:scan.rsi7,relVolume:scan.relVol,
      atr5m:scan.A,gates:scan.gates,strategyVersion:scan.strategyVersion||'v28-original'},
    feedSource:st.feedSource||'unknown',paperOnly:true,brokerOrderId:null};
  session.positions.push(pos);session.updatedAt=Date.now();basketDemo.lastBars[sym]=scan.barT;
  basketDemo.blockReason='';
  basketEvent(session,'OPEN_POSITION',{positionId:pos.id,entry:quote,sl:pos.sl,
    risk:plan.riskUsd,combinedRisk:decision.totalRiskUsd,conditions:pos.conditions});
  basketPersistPosition(session,pos);basketPersistSession(session);basketSave();
  showToast('🧺 PAPER '+scan.dir+' '+sym+' 0.01 lot ('+
    session.positions.length+'/5) · basket risk $'+decision.totalRiskUsd.toFixed(2),
    'var(--acc)');
}
async function basketDbRestore(){
  if(!currentUser||currentUser.role==='guest')return;
  try{
    var rows=await riyanApi('/api/v1/records/basket-sessions?limit=1000');
    if(!Array.isArray(rows))return;
    var parsed=rows.map(r=>{try{return typeof r.payload==='string'?JSON.parse(r.payload):r.payload;}catch(e){return null;}})
      .filter(s=>s&&s.id&&s.paperOnly&&s.owner===currentUser.username);
    var latest=new Map((basketDemo.history||[]).map(s=>[s.id,s]));
    for(var s of parsed.filter(s=>s.status==='CLOSED')){
      var prev=latest.get(s.id);
      if(!prev||(s.updatedAt||s.closedAt||0)>(prev.updatedAt||prev.closedAt||0))latest.set(s.id,s);
    }
    basketDemo.history=[...latest.values()].sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)).slice(0,100);
    var sessions=parsed.filter(s=>s.status==='OPEN').sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    if(sessions.length>1){
      basketDemo.enabled=false;
      basketDemo.conflict='Multiple open baskets in DB; disabled pending reconciliation';
    }else if(sessions.length===1){
      var remote=sessions[0],local=basketDemo.active;
      if(!local || (local.id===remote.id&&(remote.updatedAt||0)>(local.updatedAt||0))){
        basketDemo.active=remote;
      }else if(local.id!==remote.id){
        basketDemo.enabled=false;
        basketDemo.conflict='Local/DB active basket mismatch; disabled pending reconciliation';
      }
    }
    basketSave();
  }catch(e){console.warn('Paper basket DB restore skipped; retaining local cache',e);}
}
function basketToggle(){
  if(!currentUser||currentUser.role==='guest'){
    showToast('User/admin login required for paper baskets','var(--red)');return;
  }
  if(!basketDemo.enabled&&scalpHist.some(t=>t.status==='OPEN')){
    showToast('Close existing Low Profit positions before starting Basket Demo','var(--red)');return;
  }
  if(!basketDemo.enabled&&!confirm('Enable simulated basket trades? New original scalps pause while this mode is selected. Existing positions remain protected. No MT5 orders. P&L is hypothetical.'))return;
  basketDemo.enabled=!basketDemo.enabled;basketSave();renderScalpTab();
}
function basketCloseNow(){
  var s=basketDemo.active;if(!s)return;
  var price=prices[s.sym];
  if(!Number.isFinite(price)||scalpState[s.sym].feedError){
    showToast('Cannot close simulated basket with an unavailable quote','var(--red)');return;
  }
  if(confirm('Close all '+s.positions.length+' simulated positions?'))
    basketClose(price,'MANUAL');
  renderScalpLive();
}
function renderBasketDemo(){
  var root=document.getElementById('basketDemoPanel');if(!root)return;
  var b=basketDemo,s=b.active,quote=s?prices[s.sym]:null;
  var pnl=s&&Number.isFinite(quote)?basketPnlAt(s.positions,quote,s.sym):null;
  var risk=s?basketRiskAtStops(s.positions,s.sym):0;
  var html='<div class="ic"><div class="it">🧺 Basket Scalping — DEMO only</div><div class="ib">';
  html+='<div class="sc-row"><span class="sc-dim">Confirmed 5m signals · paper orders only</span>'+
    '<button class="sc-switch '+(b.enabled?'on':'')+'" onclick="basketToggle()">'+
    (b.enabled?'PAPER ON':'PAPER OFF')+'</button></div>';
  html+='<div class="sc-note">Target <b>+$'+scalpCfg.target.toFixed(2)+'</b> net, '+
    'combined estimated risk <b>$'+scalpCfg.maxLoss.toFixed(2)+'</b>, '+
    'maximum <b>5 × 0.01 lot</b>. Only new confirmed setups can add. '+
    'No averaging down, no martingale, no MT5 orders. While PAPER ON, new regular scalps pause; existing scalps keep their stops. '+
    'Browser must remain active. Gaps/slippage may exceed simulated risk.</div>';
  if(s){
    html+='<div class="sc-row"><b>'+basketTxt(s.sym)+' '+basketTxt(s.dir)+
      ' · '+s.positions.length+'/5 OPEN</b><b class="'+
      (pnl==null?'':pnl>=0?'up':'dn')+'">'+basketMoney(pnl)+'</b></div>';
    html+='<div class="sc-note">Estimated total stop risk $'+risk.toFixed(2)+
      ' / $'+scalpCfg.maxLoss.toFixed(2)+
      (s.warning?' · ⚠ '+basketTxt(s.warning):'')+'</div>';
    for(var pos of s.positions){
      html+='<div class="lvl-row"><span>0.01 lot '+basketTxt(pos.dir)+' · '+
        basketTxt(pos.setup)+'</span><span class="sc-dim">Entry '+
        fmtP(s.sym,pos.entry)+' · SL '+fmtP(s.sym,pos.sl)+'</span></div>';
    }
    html+='<button class="anal-refresh" onclick="basketCloseNow()">Close entire PAPER basket</button>';
  }else html+='<div class="sc-note">No paper positions. Enable PAPER and AUTO; wait for a real, confirmed closed-candle setup that fits the risk budget.</div>';
  if(b.conflict)html+='<div class="sc-note">⚠ '+basketTxt(b.conflict)+'</div>';
  if(b.blockReason)html+='<div class="sc-note">Last rejected entry: '+
    basketTxt(b.blockReason)+'</div>';
  if(b.history.length){
    html+='<div class="sec-ttl">Recent simulated baskets</div>';
    for(var item of b.history.slice(0,6)){
      html+='<div class="lvl-row"><span>'+basketTxt(item.sym)+' '+basketTxt(item.dir)+
        ' · '+item.positions.length+' × 0.01 · '+basketTxt(item.closeReason)+
        '</span><b class="'+(item.netPnl>=0?'up':'dn')+'">'+
        basketMoney(item.netPnl)+'</b></div>';
    }
  }
  if(typeof basketReplayHtml==='function')html+=basketReplayHtml();
  root.innerHTML=html+'</div></div>';
}
