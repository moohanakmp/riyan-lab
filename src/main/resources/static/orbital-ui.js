/* Presentation adapter only. No orders, persistence, feed requests or engine mutations. */
(function(root){
  'use strict';
  function qualityModel(feed,scan,quoteFresh){
    if(!feed||!feed.last||feed.stale||feed.reference||!quoteFresh||!scan||!Array.isArray(scan.gates)||!scan.gates.length||!Number.isFinite(scan.score)){
      return {score:null,state:feed?.reference?'REFERENCE ONLY':'DATA UNAVAILABLE',reason:feed?.message||'Waiting for complete candle history',groups:['Trend alignment','Momentum','Volatility','Market structure'].map(label=>({label,passed:0,total:0}))};
    }
    const groups=[['Trend alignment',['htf','adx']],['Momentum',['rsi','trigger']],['Volatility',['vol','spike']],['Market structure',['value','struct']]].map(([label,keys])=>{
      const gates=scan.gates.filter(g=>keys.includes(g.key));
      return {label,passed:gates.filter(g=>g.ok===true).length,total:gates.length};
    });
    return {score:Math.max(0,Math.min(100,Math.round(scan.score))),state:scan.tier&&scan.gatesOk?'SETUP FOUND':'WAIT / WATCH',reason:scan.wait||scan.reason||'Wait for a confirmed setup. Check Signals for all entry gates.',groups};
  }
  root.OrbitalUI={qualityModel};
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);
  const symbols=['XAUUSD','XAGUSD','BTCUSD'];
  let frame=0,lastScan=0,scanSym='',lastCandle=null,cached=null;
  function navigate(tab){const b=document.querySelector('#tabsRow [data-tab="'+tab+'"]');if(b&&b.style.display!=='none')b.click();}
  // Real data visualizations only: observed quote samples and the engine quality score.
  function drawGauge(score){
    const ctx=$('orbit-gauge-chart').getContext('2d');if(!ctx)return;
    ctx.clearRect(0,0,340,180);ctx.lineWidth=20;ctx.lineCap='round';
    ctx.beginPath();ctx.arc(170,164,140,Math.PI,Math.PI*2);ctx.strokeStyle='#293d62';ctx.stroke();
    if(score!=null&&score>0){ctx.beginPath();ctx.arc(170,164,140,Math.PI,Math.PI+Math.PI*score/100);ctx.strokeStyle='#38baff';ctx.stroke();}
  }
  function drawTrend(sym,change){
    const canvas=$('orbit-spark-'+sym),data=(sparkBuf[sym]||[]).filter(Number.isFinite);
    canvas.hidden=data.length<2;if(data.length<2)return;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const low=Math.min(...data),range=Math.max(...data)-low;
    ctx.clearRect(0,0,96,44);ctx.lineWidth=1.5;ctx.strokeStyle=change==null?'#89a7d8':change>=0?'#26c9b8':'#f2667d';ctx.beginPath();
    data.forEach((value,index)=>{const x=index/(data.length-1)*94+1,y=range?40-(value-low)/range*36:22;if(index)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();
  }
  function update(){
    frame=0;
    const user=typeof currentUser==='undefined'?null:currentUser;
    const tab=document.querySelector('#tabsRow .tab.active')?.dataset.tab;
    const visible=!!user&&['dashboard','chart','prices'].includes(tab);
    $('orbitalOverview').hidden=!visible;
    if(!visible||document.hidden)return;
    for(const sym of symbols){
      const value=prices[sym],fresh=freshQuote(sym),el=$('orbit-price-'+sym),status=$('orbit-status-'+sym);
      el.textContent=Number.isFinite(value)?fmtP(sym,value):'—';
      const change=Number.isFinite(value)&&dayOpen[sym]>0?(value/dayOpen[sym]-1)*100:null;
      $('orbit-change-'+sym).textContent=change==null?'Change unavailable':(change>=0?'+':'')+change.toFixed(2)+'%';
      $('orbit-change-'+sym).className='orbit-change '+(change==null?'':change>=0?'up':'dn');
      status.textContent=fresh?'Latest quote':'Quote unavailable / stale';
      drawTrend(sym,change);
      const btn=$('orbit-card-'+sym);btn.classList.toggle('selected',selAsset===sym);
      btn.setAttribute('aria-pressed',String(selAsset===sym));
      btn.disabled=!hasAccess('chart');
    }
    if(tab!=='chart')return;
    const sym=selAsset;
    const fs=feedStatus(sym);
    if(scanSym!==sym||lastCandle!==fs.last?.t||Date.now()-lastScan>=30000){
      let scan=null;try{if(fs.last&&!fs.stale&&!fs.reference)scan=kmrScan(sym);}catch(e){/* unavailable state below */}
      cached=scan;scanSym=sym;lastCandle=fs.last?.t;lastScan=Date.now();
    }
    const model=qualityModel(fs,cached,freshQuote(sym));
    $('orbit-quality-symbol').textContent=ASSETS[sym].sym;
    $('orbit-quality-state').textContent=model.state;
    $('orbit-score').textContent=model.score==null?'—':model.score;
    drawGauge(model.score);
    $('orbit-quality-reason').textContent=model.reason;
    $('orbit-quality-source').textContent=fs.source;
    $('orbit-gauge').value=model.score==null?0:model.score;
    $('orbit-gauge').setAttribute('aria-valuetext',model.score==null?'Quality unavailable':model.score+' out of 100; setup quality, not win probability');
    const groups=$('orbit-quality-groups');groups.replaceChildren();
    for(const group of model.groups){
      const row=document.createElement('div');row.className='orbit-factor';
      const label=document.createElement('span');label.textContent=group.label;
      const bar=document.createElement('progress');bar.max=group.total||1;bar.value=group.passed;bar.setAttribute('aria-label',group.label);
      const value=document.createElement('b');value.textContent=group.total?group.passed+'/'+group.total:'—';
      row.append(label,bar,value);groups.append(row);
    }
    $('orbit-ideas').hidden=!hasAccess('signals');
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(update);}
  symbols.forEach(sym=>$('orbit-card-'+sym).addEventListener('click',()=>{
    if(!hasAccess('chart'))return;
    // Use original symbol selector and tab button, including their existing permission gates.
    navigate('chart');pickChart(sym);lastScan=0;schedule();
  }));
  $('orbit-ideas').addEventListener('click',()=>navigate('signals'));
  $('tabsRow').addEventListener('click',event=>{if(event.target.closest('.tab'))$('orbitalMore').open=false;});
  document.addEventListener('click',event=>{if(!$('orbitalMore').contains(event.target))$('orbitalMore').open=false;});
  $('orbitalMore').addEventListener('keydown',event=>{if(event.key==='Escape'){$('orbitalMore').open=false;$('orbitalMore').querySelector('summary').focus();}});
  const observer=new MutationObserver(schedule);
  observer.observe($('tabsRow'),{subtree:true,attributes:true,attributeFilter:['class','style']});
  observer.observe($('appRoot'),{attributes:true,attributeFilter:['style']});
  document.addEventListener('visibilitychange',schedule);
  $('tc').addEventListener('click',()=>{scanSym='';schedule();});
  setInterval(schedule,5000);
  schedule();
})(typeof window==='undefined'?globalThis:window);
