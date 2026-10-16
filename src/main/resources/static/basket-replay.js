'use strict';
// Candle-by-candle, per-symbol replay of paper baskets. Existing strategy rules
// are reused. News events and broker-specific execution are NOT replayed.
// A trigger detected at the close of bar i enters no earlier than bar i+1 open.
function basketReplaySimulation(sym,history,cfg){
  if(!history||history.length<240)return{ok:false,reason:'Insufficient 5m candle history'};
  var all=history.slice(0,-1),start=Math.max(200,all.length-799);
  var baskets=[],active=null,blocked=0,entries=0,maxPositions=0;
  var acceptedBars=new Set(),rejects={},daily=new Map(),cool=0;
  var countReject=reason=>{blocked++;rejects[reason]=(rejects[reason]||0)+1;};
  var spread=SPREAD[sym]||0,sgn,xNet;
  function close(price,reason,at){
    if(!active)return;
    var net=basketPnlAt(active.positions,price,sym);
    baskets.push({id:active.id,symbol:sym,dir:active.dir,
      positions:active.positions.map(p=>({entry:p.entry,sl:p.sl,lot:p.lot,
        openedAt:p.openedAt,setup:p.setup})),
      openedAt:active.createdAt,closedAt:at,
      exit:price,netPnl:+net.toFixed(4),reason});
    var key=istDayKey(at);
    daily.set(key,(daily.get(key)||0)+net);
    cool=at+(net<0?15:5)*60000;
    active=null;
  }
  for(var i=start;i<all.length-1;i++){
    var candle=all[i],at=candle.t+300000;
    if(active&&candle.t>=active.createdAt){
      var stops=active.positions.filter(p=>
        active.dir==='BUY'?candle.l<=p.sl:candle.h>=p.sl);
      if(stops.length){
        var stop=active.dir==='BUY'?Math.min(...stops.map(p=>p.sl)):
          Math.max(...stops.map(p=>p.sl));
        // Opening gap beyond an SL is filled at the adverse opening price.
        var fill=active.dir==='BUY'?Math.min(candle.o,stop):Math.max(candle.o,stop);
        close(fill,'POSITION_STOP',at);
      }else{
        var trigger=basketProfitTrigger(active,cfg.target);
        if(trigger!=null&&(active.dir==='BUY'?candle.h>=trigger:candle.l<=trigger)){
          close(trigger,'NET_TP',at);
        }else{
          var pnl=basketPnlAt(active.positions,candle.c,sym);
          if(pnl<=-cfg.maxLoss)close(candle.c,'NET_STOP',at);
          else if(at-active.createdAt>=cfg.timeStopMin*60000)
            close(candle.c,'TIME_STOP',at);
        }
      }
    }
    if(at<cool || (active&&active.positions.length>=5))continue;
    var dayPnl=daily.get(istDayKey(at))||0;
    if(dayPnl<=-cfg.dayStop||(cfg.stopAtGoal&&dayPnl>=cfg.goal))continue;
    var bars=all.slice(0,i+1),c15=aggMinutes(bars,15).filter(k=>k.t+900000<=at);
    var scan=scalpScan(sym,bars,c15,null,{now:at,events:[],
      isMetal:sym!=='BTCUSD',marketOpen:true,spread,
      dec:ASSETS[sym].dec,continuation:!!cfg.continuation});
    if(!scan.dir||!scan.gatesOk){if(scan.dir)countReject('SAFETY_GATES');continue;}
    if(acceptedBars.has(scan.barT))continue;
    if(active&&(active.sym!==sym||active.dir!==scan.dir))continue;
    var entry=all[i+1].o;
    if(!Number.isFinite(entry)||entry<=0)continue;
    var ran=(scan.dir==='BUY'?1:-1)*(entry-scan.price);
    if(ran>0.4*scan.A||ran<-0.5*scan.A){countReject('PRICE_RAN');continue;}
    var plan=basketPlan(sym,scan,entry,bars,cfg);
    var check=basketCanAdd(active,plan,entry,cfg);
    if(!check.ok){countReject(check.reason);continue;}
    if(!active)active={id:'bt-'+i,sym,dir:scan.dir,
      positions:[],createdAt:all[i+1].t};
    active.positions.push({dir:scan.dir,entry,sl:plan.sl,units:plan.units,
      lot:0.01,openedAt:all[i+1].t,setup:scan.setup});
    entries++;maxPositions=Math.max(maxPositions,active.positions.length);
    acceptedBars.add(scan.barT);
  }
  if(active)close(all[all.length-1].c,'END_OF_SAMPLE',all[all.length-1].t+300000);
  var wins=baskets.filter(b=>b.netPnl>0.005).length;
  var net=baskets.reduce((sum,b)=>sum+b.netPnl,0),eq=0,peak=0,dd=0;
  for(var b of baskets){
    eq+=b.netPnl;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);
  }
  return{ok:true,symbol:sym,version:'basket-paper-v1',
    baskets:baskets.length,positions:entries,maxPositions,
    wins,losses:baskets.filter(b=>b.netPnl<-.005).length,
    winRate:baskets.length?wins/baskets.length*100:0,
    net:+net.toFixed(2),maxDrawdown:+dd.toFixed(2),rejected:blocked,
    rejects,barsUsed:all.length-start,history:baskets.slice(-120),
    assumptions:['Next candle open after completed 5m confirmation',
      'Stop before target if both touched inside one candle',
      'Simplified spread; no commission, slippage or MT5 execution',
      'No historical news pauses; per-symbol baskets, not combined portfolio',
      'Past replay results are not a forecast']};
}
async function basketRunReplay(){
  if(basketReplayBusy||!currentUser||currentUser.role==='guest')return;
  basketReplayBusy=true;
  try{
    for(var sym of SYMS){
      basketDemo.replays[sym]={ok:false,reason:'Loading history'};
      renderBasketDemo();
      try{
        var candles=await scalpFetch(sym,1000);
        basketDemo.replays[sym]=basketReplaySimulation(sym,candles,scalpCfg);
      }catch(e){basketDemo.replays[sym]={ok:false,reason:String(e.message||e)};}
      renderBasketDemo();
    }
    var report={symbol:'MULTI',generatedAt:Date.now(),
      scenario:'basket-paper-v1',paperOnly:true,
      target:scalpCfg.target,maxLoss:scalpCfg.maxLoss,
      dailyGoal:scalpCfg.goal,dailyStop:scalpCfg.dayStop,
      continuation:!!scalpCfg.continuation,
      results:basketDemo.replays};
    basketSave();
    riyanQueue('basket-replays',basketRecordId('replay-'+report.generatedAt),report);
    riyanProcessQueue();
  }finally{basketReplayBusy=false;renderBasketDemo();}
}
function basketReplayHtml(){
  var b=basketDemo.replays||{},html='<div class="sec-ttl">🧪 Paper basket replay</div>';
  html+='<div class="sc-note">Approximate per-symbol replay (~2.8 traded days after 200 warm-up bars). '+
    'Uses next-bar openings and conservative stops but excludes news pauses, actual broker costs, '+
    'network latency and multi-asset overlap. Backtest results are NOT live profits.</div>';
  html+='<button class="anal-refresh" onclick="basketRunReplay()"'+
    (basketReplayBusy?' disabled':'')+'>'+
    (basketReplayBusy?'Replaying paper baskets…':'Replay baskets (~2.8 traded days)')+
    '</button>';
  for(var sym of SYMS){
    var result=b[sym];if(!result)continue;
    if(!result.ok){
      html+='<div class="sc-note">'+basketTxt(sym)+': '+basketTxt(result.reason)+'</div>';continue;
    }
    html+='<div class="lvl-row"><span>'+basketTxt(sym)+' · '+
      result.baskets+' baskets · '+result.positions+' positions · '+
      result.winRate.toFixed(0)+'% won · max '+result.maxPositions+
      ' positions · '+result.rejected+' risk/entry rejects</span>'+
      '<b class="'+(result.net>=0?'up':'dn')+'">'+basketMoney(result.net)+'</b></div>';
    html+='<div class="sc-note">Worst drawdown: −$'+result.maxDrawdown.toFixed(2)+
      ' · per-symbol paper simulation only</div>';
  }
  return html;
}
