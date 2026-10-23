'use strict';
// Background status/settings only; the existing browser signal loops remain intact.
let backgroundUser='',backgroundEnabled=true,backgroundDigest='',backgroundBusy=false,backgroundStatus=null;
async function backgroundRefresh(){
  if(typeof currentUser==='undefined'||!currentUser||currentUser.role==='guest')return;
  if(backgroundBusy)return;backgroundBusy=true;
  const user=currentUser.username;
  try{
    const status=await riyanApi('/api/v1/paper/background/status');
    if(currentUser?.username!==user)return;
    if(backgroundUser!==user){backgroundUser=user;backgroundDigest='';backgroundEnabled=status.enabled!==false;}
    backgroundStatus=status;
    if(status.calendarHealth){
      const health=status.calendarHealth;
      if(health.ready===false){calendarCache=null;calendarCacheAt=0;calendarHealth=health;feedError.calendar=health.calendarError||'Calendar unavailable';}
      else if(health.fetchedAt>calendarCacheAt)fetchEconCalendar(true).catch(()=>{});
      renderCalendarHealth();
    }
    const settings={enabled:backgroundEnabled,scalp:scalpCfg,basketEnabled:!!basketDemo.enabled};
    const digest=JSON.stringify(settings);
    if(digest!==backgroundDigest){await riyanApi('/api/v1/paper/background/settings',{method:'POST',body:digest});backgroundDigest=digest;}
    backgroundRender(status);
  }catch(e){backgroundRender({state:'UNAVAILABLE',reason:'Background status unavailable — '+e.message});}
  finally{backgroundBusy=false;renderCalendarHealth();}
}
function backgroundRender(status){
  for(const id of ['ts','tsc','tad']){
    const panel=document.getElementById(id);if(!panel)continue;
    let box=panel.querySelector('[data-background-scanner]');
    if(!box){box=document.createElement('details');box.className='notice';box.dataset.backgroundScanner='';box.style.marginBottom='16px';panel.prepend(box);}
    const stamp=Date.parse(status.checked_at),age=Number.isFinite(stamp)?Math.max(0,Math.round((Date.now()-stamp)/1000)):null;
    const recent=age!==null&&age<120;
    const state=!backgroundEnabled?'Background scanner paused':status.owner==='BROWSER'?'Browser active · server takes over after it closes':status.owner==='SERVER'&&recent&&status.state==='SCANNING'&&status.phase!=='ERROR'?'Server scanning · app can be closed':status.state==='ERROR'||status.phase==='ERROR'?'Server scanner needs attention':status.state==='UNAVAILABLE'?'Background status unavailable':recent?'Server checked recently':'Waiting for server background check';
    box.replaceChildren();const summary=document.createElement('summary');summary.textContent=state+(age!==null?' · last server check '+age+'s ago':'');box.append(summary);
    const text=document.createElement('p');text.style.marginTop='10px';text.textContent='Auto Signals and enabled Low Profit strategies use the same paper rules in the server worker. Fresh candles, a fresh quote, news checks and account risk limits still apply. Existing basket simulation remains browser managed.';box.append(text);
    const hosting=document.createElement('p');hosting.textContent='Hosting: Render free can sleep after 15 minutes without incoming traffic. Uninterrupted background scanning requires an always-on service. Background scanning does not deliver device push, Telegram or email while the browser is closed.';box.append(hosting);
    let detail;try{detail=typeof status.details==='string'?JSON.parse(status.details):status.details;}catch(e){}
    if(detail){const lines=document.createElement('p');lines.textContent=detail.reason||Object.entries(detail.instruments||{}).map(([sym,s])=>sym+': '+s.auto+' / '+s.lowProfit).join(' · ');box.append(lines);}
    if(status.cycleError){const error=document.createElement('p');error.textContent=status.cycleError;box.append(error);}
    if(detail?.calendarError){const news=document.createElement('p');news.textContent=detail.calendarError;box.append(news);}
    if(status.reason){const reason=document.createElement('p');reason.textContent=status.reason;box.append(reason);}
    const button=document.createElement('button');button.className='qa';button.type='button';button.textContent=backgroundEnabled?'Pause background scanner':'Enable background scanner';button.onclick=async()=>{backgroundEnabled=!backgroundEnabled;backgroundDigest='';await backgroundRefresh();};box.append(button);
  }
}
setInterval(backgroundRefresh,10000);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',backgroundRefresh);else backgroundRefresh();
