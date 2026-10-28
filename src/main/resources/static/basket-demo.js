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
    basketDemo.replays={};basketDemo.enabled=false;
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
async function basketEvaluate(){return;}
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
function basketToggle(){basketDemo.enabled=false;basketSave();}
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
  if(!s&&!b.history.length&&!b.conflict){root.innerHTML='';return;}
  var html='<div class="ic"><div class="it">Legacy paper positions and history</div><div class="ib"><p class="sc-note">New basket entries are retired. Existing positions keep their stop/exit management.</p>';
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

  root.innerHTML=html+'</div></div>';
}
