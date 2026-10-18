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
  const workspaces={
    chart:{panel:'tc',title:'Markets',group:'Market desk',description:'Price action, market context and setup quality in one view.',links:['prices','analysis','signals']},
    prices:{panel:'tp',title:'Live Prices',group:'Market desk',description:'Follow gold, silver and Bitcoin, then open the chart or investigate the setup.',links:['chart','analysis','flow']},
    signals:{panel:'ts',title:'Auto Signals',group:'Trading desk',description:'Review confirmed setups, locked levels and the conditions the engine is waiting for.',links:['scalp','manual','history','analysis']},
    scalp:{panel:'tsc',title:'Low Profit',group:'Trading desk',description:'Monitor small-target paper setups, risk limits and the live watch.',links:['signals','manual','analytics']},
    manual:{panel:'tma',title:'Trade Planner',group:'Trading desk',description:'Build an on-demand plan with entry, structure, targets and clear reasons to wait.',links:['analysis','chart','signals']},
    analysis:{panel:'tan',title:'Market Analysis',group:'Research desk',description:'Connect higher-timeframe bias with key levels, order blocks and upcoming events.',links:['manual','chart','session','flow']},
    session:{panel:'tse',title:'Sessions & Events',group:'Research desk',description:'Understand session timing and event context before reviewing a setup.',links:['analysis','flow','research']},
    flow:{panel:'tfl',title:'Flow & Volume',group:'Research desk',description:'Explore recurring time-of-day patterns and the available volume references.',links:['analysis','session','research']},
    research:{panel:'tre',title:'Historical Research',group:'Research desk',description:'Compare today’s conditions with real historical samples and review the limitations.',links:['flow','analytics','analysis']},
    analytics:{panel:'tay',title:'Strategy Lab',group:'Research desk',description:'Inspect technical consensus, trade plans and candle-by-candle backtests.',links:['manual','research','scalp']},
    dashboard:{panel:'tdb',title:'Daily Overview',group:'Portfolio',description:'Review today’s paper results, market pulse and open signals.',links:['pnl','history','signals']},
    history:{panel:'th',title:'Trade Journal',group:'Portfolio',description:'Trace signal outcomes, entry details and the records behind performance.',links:['pnl','dashboard','signals']},
    pnl:{panel:'tpn',title:'Performance',group:'Portfolio',description:'Explore paper results by period, strategy and instrument.',links:['history','dashboard','analytics']},
    admin:{panel:'tad',title:'Settings & Access',group:'Workspace',description:'Manage the existing account, appearance and alert controls.',links:['info','dashboard','pnl']},
    info:{panel:'ti',title:'Trading Guide',group:'Workspace',description:'Understand the rules, data sources and risk limits behind this workspace.',links:['signals','analysis','admin']}
  };
  function routeTarget(hash,allowed){
    let key;try{key=decodeURIComponent(String(hash||'').replace(/^#/,''));}catch(e){return null;}
    return Object.prototype.hasOwnProperty.call(workspaces,key)&&allowed.includes(key)?key:null;
  }
  root.OrbitalUI={qualityModel,workspaces,routeTarget};
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);
  const symbols=['XAUUSD','XAGUSD','BTCUSD'];
  let frame=0,lastScan=0,scanSym='',lastCandle=null,cached=null,lastWorkspaceKey='',pendingRoute=true;
  function navigate(tab){const b=document.querySelector('#tabsRow [data-tab="'+tab+'"]');if(b&&b.style.display!=='none')b.click();}
  function allowedTabs(){return Object.keys(workspaces).filter(tab=>{const b=document.querySelector('#tabsRow [data-tab="'+tab+'"]');return b&&b.style.display!=='none';});}
  function makeLink(tab,current){
    const a=document.createElement('a');a.href='#'+tab;a.dataset.workspaceTab=tab;a.textContent=workspaces[tab].title;
    if(tab===current)a.setAttribute('aria-current','page');return a;
  }
  function syncWorkspace(user,tab){
    const shell=$('orbitalWorkspace');shell.hidden=!user||!workspaces[tab];
    if(!user||!workspaces[tab]){lastWorkspaceKey='';return false;}
    const allowed=allowedTabs();
    if(pendingRoute){pendingRoute=false;const target=routeTarget(location.hash,allowed);if(target&&target!==tab){navigate(target);return true;}}
    document.body.dataset.workspaceTab=tab;
    const key=tab+'|'+allowed.join(',');
    if(key!==lastWorkspaceKey){
      lastWorkspaceKey=key;const page=workspaces[tab];
      $('workspaceGroup').textContent=page.group;$('workspaceTitle').textContent=page.title;$('workspaceDescription').textContent=page.description;
      $('workspaceArtwork').src='assets/orbital-'+(page.group==='Trading desk'?'gold':page.group==='Research desk'?'silver':'bitcoin')+'.webp';
      $('workspaceRelated').replaceChildren(...[tab,...page.links].filter((x,i,a)=>allowed.includes(x)&&a.indexOf(x)===i).map(x=>makeLink(x,tab)));
      const directory=$('workspaceAllLinks');directory.replaceChildren();
      for(const group of [...new Set(Object.values(workspaces).map(x=>x.group))]){
        const pages=allowed.filter(x=>workspaces[x].group===group);if(!pages.length)continue;
        const section=document.createElement('section'),title=document.createElement('h2');title.textContent=group;section.append(title,...pages.map(x=>makeLink(x,tab)));directory.append(section);
      }
      $('workspaceDirectory').open=false;
    }
    if(location.hash!=='#'+tab)history.replaceState(null,'','#'+tab);
    return false;
  }
  function decoratePanel(tab){
    const panel=$(workspaces[tab]?.panel);if(!panel)return;
    for(const title of panel.querySelectorAll('.it:not([data-orbit-decorated]),.sec-ttl:not([data-orbit-decorated])')){
      title.dataset.orbitDecorated='true';
      const text=title.firstChild;if(text?.nodeType===3)text.textContent=text.textContent.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u,'');
      const icon=document.createElement('i');icon.className='bi bi-'+(/risk|rule|signal/i.test(title.textContent)?'bullseye':/news|research/i.test(title.textContent)?'search':/time|session|event/i.test(title.textContent)?'clock':/setting|theme|access|user/i.test(title.textContent)?'gear':'activity');icon.setAttribute('aria-hidden','true');title.prepend(icon);
      title.setAttribute('role','heading');title.setAttribute('aria-level','2');
    }
    for(const cell of panel.querySelectorAll('.trend-cell:not([data-orbit-decorated])')){
      cell.dataset.orbitDecorated='true';const text=cell.querySelector('.trend-sym')?.textContent||'';
      const asset=text.includes('XAU')?'gold':text.includes('XAG')?'silver':'bitcoin';
      const img=document.createElement('img');img.className='workspace-trend-art';img.src='assets/orbital-'+asset+'.webp';img.alt='';img.width=84;img.height=64;cell.prepend(img);
    }
    for(const card of panel.querySelectorAll('.pc')){
      const ico=card.querySelector('.ico');if(!ico||ico.querySelector('img'))continue;
      const asset=card.classList.contains('gold')?'gold':card.classList.contains('silver')?'silver':'bitcoin';
      const img=document.createElement('img');img.src='assets/orbital-'+asset+'.webp';img.alt='';img.width=76;img.height=58;ico.replaceChildren(img);
    }
  }
  function routeFromLocation(){
    if(typeof currentUser==='undefined'||!currentUser){pendingRoute=true;return;}
    const target=routeTarget(location.hash,allowedTabs());
    const active=document.querySelector('#tabsRow .tab.active')?.dataset.tab;
    if(target&&target!==active)navigate(target);else schedule();
  }
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
    if(syncWorkspace(user,tab))return;
    if(user&&workspaces[tab])decoratePanel(tab);
    const visible=!!user&&tab==='chart';
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
  $('orbitalWorkspace').addEventListener('click',event=>{
    const link=event.target.closest('a[data-workspace-tab]');if(!link||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;
    event.preventDefault();if(routeTarget(link.hash,allowedTabs()))navigate(link.dataset.workspaceTab);
  });
  $('tabsRow').addEventListener('click',event=>{
    const button=event.target.closest('.tab[data-tab]');if(!button||!button.classList.contains('active'))return;
    if(location.hash!=='#'+button.dataset.tab)history.pushState(null,'','#'+button.dataset.tab);
  });
  addEventListener('hashchange',routeFromLocation);addEventListener('popstate',routeFromLocation);
  const contentObserver=new MutationObserver(records=>{
    if(records.some(r=>!r.target.closest?.('#orbitalWorkspace,#orbitalOverview,.orbit-quality,[data-orbit-decorated]')))schedule();
  });
  contentObserver.observe($('mainScroll'),{subtree:true,childList:true});
  $('tp').addEventListener('click',schedule);
  const observer=new MutationObserver(schedule);
  observer.observe($('tabsRow'),{subtree:true,attributes:true,attributeFilter:['class','style']});
  observer.observe($('appRoot'),{attributes:true,attributeFilter:['style']});
  document.addEventListener('visibilitychange',schedule);
  $('tc').addEventListener('click',()=>{scanSym='';schedule();});
  setInterval(schedule,5000);
  schedule();
})(typeof window==='undefined'?globalThis:window);
