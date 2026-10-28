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
    basketDemo.replays={};basketDemo.modePending=false;
    basketDemo.enabled=basketDemo.modeVersion===2&&basketDemo.enabled===true;
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
  var spread=SPREAD[sym];
  if(!Number.isFinite(spread)||spread<0||!Array.isArray(positions))return NaN;
  return positions.reduce((sum,p)=>{
    if(!p||!['BUY','SELL'].includes(p.dir)||
       !Number.isFinite(p.entry)||!Number.isFinite(p.sl)||
       !Number.isFinite(p.units)||p.entry<=0||p.sl<=0||p.units<=0||
       (p.dir==='BUY'&&p.sl>=p.entry)||
       (p.dir==='SELL'&&p.sl<=p.entry))return NaN;
    var risk=(p.entry-p.sl)*(p.dir==='BUY'?1:-1)*p.units+spread*p.units;
    return sum+Math.max(0,risk);
  },0);
}
// Always start at 0.01 lot; adding positions is not a way to evade max risk.


function basketCanAdd(session,plan,price,cfg){
  if(!plan||plan.reject)return{ok:false,reason:plan?.reject||'No valid entry plan'};
  if(!cfg||!Number.isFinite(cfg.maxLoss)||cfg.maxLoss<=0||
     !Number.isFinite(price)||price<=0)
    return{ok:false,reason:'Invalid quote or basket risk limit'};
  if(session&&(!Array.isArray(session.positions)||session.status&&session.status!=='OPEN'))
    return{ok:false,reason:'Invalid or closed basket session'};
  if(session&&session.positions.length>=5)return{ok:false,reason:'Five positions reached'};
  if(session&&(session.sym!==plan.sym||session.dir!==plan.dir))
    return{ok:false,reason:'Only one symbol/direction in a basket'};
  if(session&&basketPnlAt(session.positions,price,session.sym)<-1e-8)
    return{ok:false,reason:'No averaging down: existing basket must be non-losing'};
  var total=basketRiskAtStops([...(session?session.positions:[]),plan],plan.sym);
  if(!Number.isFinite(total))return{ok:false,reason:'Invalid position data: risk cannot be verified'};
  if(total>cfg.maxLoss+1e-6)return{ok:false,
    reason:'Combined stop risk $'+total.toFixed(2)+' exceeds $'+cfg.maxLoss};
  return{ok:true,totalRiskUsd:total};
}
function basketPlan(sym,scan,entry,c5,cfg){
  if(!scan?.dir||!scan.gatesOk||!['sr-volume-v1','ob-volume-v1'].includes(scan.strategyVersion))return{reject:'Confirmed price-structure setup required'};
  const plan=scalpLevels(sym,scan.dir,entry,scan,c5,cfg);
  return plan.reject?plan:{...plan,dir:scan.dir,sym,riskUsd:plan.slUsd};
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
  var s=basketDemo.active;if(!s||!paperReady())return;
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
  basketDemo.history.unshift(s);
  basketDemo.cooldown=at+(net<0?15:5)*60000;basketDemo.active=null;basketSave();
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
  var s=basketDemo.active;if(!s||!paperReady())return;
  var closed=kmrClosed(scalpData[s.sym]||[]).filter(k=>
    !k.analysisOnly&&k.t+300000<=Date.now()&&k.t>=Math.max(s.createdAt,...s.positions.map(p=>p.openedAt))&&k.t>(s.lastCheckedBar||0));
  for(var k of closed){
    var stops=s.positions.filter(p=>s.dir==='BUY'?k.l<=p.sl:k.h>=p.sl);
    if(stops.length){
      var px=s.dir==='BUY'?Math.min(...stops.map(p=>p.sl)):
        Math.max(...stops.map(p=>p.sl));
      basketClose(PaperMath.stopFill(s.dir,px,k.o),'POSITION_STOP',k.t+300000);return;
    }
    var trigger=basketProfitTrigger(s,scalpCfg.target);
    if(trigger!=null&&(s.dir==='BUY'?k.h>=trigger:k.l<=trigger)){
      basketClose(trigger,'NET_TP_CANDLE',k.t+300000);return;
    }
    s.lastCheckedBar=k.t;
  }
}
function basketManage(){
  var s=basketDemo.active;if(!s||!paperReady())return;
  var quote=prices[s.sym],feed=scalpState[s.sym]||{};
  if(!freshQuote(s.sym)||!Number.isFinite(quote)||quote<=0||feed.feedError||
     !feed.feedAt||Date.now()-feed.feedAt>12*60000){
    s.warning='Fresh quote unavailable: paper risk exit cannot be verified';return;
  }
  s.warning='';
  var net=basketPnlAt(s.positions,quote,s.sym);
  if(!Number.isFinite(net)||!Number.isFinite(basketRiskAtStops(s.positions,s.sym))){
    s.warning='Saved position data invalid — paper basket paused; inspect audit';
    basketDemo.enabled=false;basketSave();return;
  }
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
async function basketEvaluate(sym){
  if(!paperReady()||!freshQuote(sym)||Date.now()<(basketDemo.cooldown||0)||basketDemo.entryBusy||!currentUser||currentUser.role==='guest'||!basketDemo.enabled||
     !scalpCfg.auto||!scalpCfg.assets[sym])return;
  if(scalpHist.some(t=>t.status==='OPEN'))return;
  var s=basketDemo.active,st=scalpState[sym]||{},scan=st.scan,
    quote=prices[sym],c5=kmrClosed(scalpData[sym]||[]);
  if(c5.some(k=>k.analysisOnly)||!scan||!scan.dir||!scan.gatesOk||st.block||st.feedError||
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
  const account=paperAccountRisk(sym,scan.dir,quote,plan.sl,plan.units);
  if(!account.ok){basketDemo.blockReason=account.reason;return;}
  var day=scalpToday(),basketDay=basketToday();
  if(day.stopHit||(day.goalHit&&scalpCfg.stopAtGoal)||
     (scalpCfg.stopAtGoal&&day.pnl+basketDay.pnl>=scalpCfg.goal)||
     day.pnl+basketDay.pnl<=-scalpCfg.dayStop)return;
  var session=s;
  if(!session){
    session={id:'basket-'+Date.now()+'-'+Math.floor(Math.random()*10000),
      sym,dir:scan.dir,status:'OPEN',createdAt:Date.now(),
      positions:[],lastCheckedBar:scan.barT,paperOnly:true,netPnl:0};

  }
  var pos={id:'paper-'+Date.now()+'-'+Math.floor(Math.random()*100000),
    sym,dir:scan.dir,status:'OPEN',entry:quote,sl:plan.sl,tp:plan.tp,
    units:plan.units,lot:0.01,estimatedStopLossUsd:plan.riskUsd,
    openedAt:Date.now(),confirmed5mBar:scan.barT,setup:scan.setup,
    reason:scan.setup,why:scan.why,
    conditions:{trend:scan.trend,adx:scan.adx,rsi7:scan.rsi7,relVolume:scan.relVol,
      atr5m:scan.A,gates:scan.gates,strategyVersion:scan.strategyVersion||'v28-original'},
    feedSource:st.feedSource||'unknown',paperOnly:true,brokerOrderId:null};
  pos.accountingVersion=2;pos.updatedAt=pos.openedAt;pos.spreadPerUnit=SPREAD[sym]||0;
  pos.owner=currentUser.username;pos.signalKey='basket:'+sym+':5m:'+scan.barT+':'+scan.dir;
  pos.basketId=session.id;
  basketDemo.entryBusy=true;
  try{if(!await paperSaveEntry('basket-positions',basketRecordId(pos.id),pos))return;}
  finally{basketDemo.entryBusy=false;}
  // The position is durable before the browser creates the session or alerts.
  basketDemo.active=session;
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
  if(!currentUser||currentUser.role==='guest')return false;
  const user=currentUser.username;
  try{
    const ledger=typeof paperReadLedger==='function'?await paperReadLedger():null;
    const [records,positions]=ledger?[ledger['basket-sessions']||[],ledger['basket-positions']||[]]:await Promise.all([
      riyanReadAll('basket-sessions'),riyanReadAll('basket-positions')]);
    if(currentUser?.username!==user)return false;
    const parse=r=>{try{return typeof r.payload==='string'?JSON.parse(r.payload):r.payload;}catch(e){return null;}};
    const sessions=new Map(records.map(parse).filter(s=>s&&s.owner===user).map(s=>[s.id,s]));
    // A position may have committed immediately before a lost response / closed tab.
    // Rebuild sessions from durable positions so accepted entries cannot disappear.
    const grouped=new Map();
    for(const p of positions.map(parse).filter(p=>p&&p.basketId)){
      if(!grouped.has(p.basketId))grouped.set(p.basketId,[]);
      grouped.get(p.basketId).push(p);
    }
    for(const [id,ps] of grouped){
      const meta=sessions.get(id)||{},open=ps.some(p=>p.status==='OPEN');
      sessions.set(id,{...meta,id,sym:ps[0].sym,dir:ps[0].dir,positions:ps,
        owner:user,paperOnly:true,status:open?'OPEN':'CLOSED',
        createdAt:meta.createdAt||Math.min(...ps.map(p=>p.openedAt)),
        closedAt:open?null:Math.max(...ps.map(p=>p.closedAt||0)),
        netPnl:ps.reduce((v,p)=>v+(p.pnl||0),0)});
    }
    basketDemo.history=[...sessions.values()].filter(s=>s.status==='CLOSED');
    const open=[...sessions.values()].filter(s=>s.status==='OPEN');
    basketDemo.active=open.length===1?open[0]:null;
    basketDemo.conflict=open.length>1?'Multiple open baskets require reconciliation':'';
    if(open.length>1){basketDemo.enabled=false;throw Error(basketDemo.conflict);}
    basketSave();return true;
  }catch(e){console.warn('Paper basket restoration unavailable',e);return false;}
}
async function basketToggle(){
  if(!currentUser||currentUser.role==='guest'||basketDemo.modePending)return;
  if(typeof backgroundBusy!=='undefined'&&backgroundBusy){showToast('Settings are synchronizing — try the toggle again shortly','var(--acc)');return;}
  const next=!basketDemo.enabled;
  if(next&&scalpHist.some(t=>t.status==='OPEN')){showToast('Close existing Low Profit positions before enabling Basket paper','var(--acc)');return;}
  const user=currentUser.username;basketDemo.modePending=true;
  try{
    const status=await riyanApi('/api/v1/paper/background/status');
    if(currentUser?.username!==user)return;
    await riyanApi('/api/v1/paper/background/settings',{method:'POST',body:JSON.stringify({enabled:status.enabled!==false,scalp:scalpCfg,basketEnabled:next,basketModeVersion:2})});
    if(currentUser?.username!==user)return;
    basketDemo.enabled=next;basketDemo.modeVersion=2;basketSave();
    if(typeof backgroundDigest!=='undefined')backgroundDigest='';
  }catch(e){showToast('Basket mode unchanged: '+(e.detail||e.message),'var(--red)');}
  finally{basketDemo.modePending=false;renderScalpTab();}
}
function basketCloseNow(){
  var s=basketDemo.active;if(!s||!paperReady())return;
  var price=prices[s.sym];
  if(!freshQuote(s.sym)||!Number.isFinite(price)||scalpState[s.sym].feedError){
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
  if(!b.enabled&&!s&&!b.conflict){root.innerHTML='';return;}
  var html='<div class="ic"><div class="it">Basket paper scalping</div><div class="ib"><p class="sc-note">Opt-in paper simulation · maximum 5 × 0.01 lot · no averaging down · combined account risk applies. Turning this mode off prevents new entries; existing positions keep exit management. Keep this browser open.</p>';
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
        fmtP(s.sym,pos.entry)+' · SL '+fmtP(s.sym,pos.sl)+' · TP '+(Number.isFinite(pos.tp)?fmtP(s.sym,pos.tp):'Basket net target')+'</span></div>';
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

  root.innerHTML=html+'</div></div>';
}
