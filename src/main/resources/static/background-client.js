'use strict';
// Background status/settings only; the existing browser signal loops remain intact.
let backgroundUser='',backgroundEnabled=true,backgroundDigest='',backgroundBusy=false,backgroundStatus=null;
async function backgroundRefresh(){
  if(typeof currentUser==='undefined'||!currentUser||currentUser.role==='guest')return;
  if(backgroundBusy||basketDemo.modePending)return;backgroundBusy=true;
  const user=currentUser.username;
  try{
    const status=await riyanApi('/api/v1/paper/background/status');
    if(currentUser?.username!==user)return;
    if(backgroundUser!==user){
      backgroundUser=user;backgroundDigest='';backgroundEnabled=status.enabled!==false;
      // Opening the app on another device must not silently replace the active server
      // strategy. Adopt the saved server settings; only a later local change is sent.
      if(backgroundAdoptSettings(status.settings))backgroundDigest=JSON.stringify(backgroundSettings());
    }
    backgroundStatus=status;
    if(status.calendarHealth){
      const health=status.calendarHealth;
      if(health.ready===false){calendarCache=null;calendarCacheAt=0;calendarHealth=health;feedError.calendar=health.calendarError||'Calendar unavailable';}
      else if(health.fetchedAt>calendarCacheAt)fetchEconCalendar(true).catch(()=>{});
      renderCalendarHealth();
    }
    const digest=JSON.stringify(backgroundSettings());
    if(digest!==backgroundDigest){await riyanApi('/api/v1/paper/background/settings',{method:'POST',body:digest});backgroundDigest=digest;}
    backgroundRender(status);
  }catch(e){backgroundRender({state:'UNAVAILABLE',reason:'Background status unavailable — '+e.message});}
  finally{backgroundBusy=false;renderCalendarHealth();}
}
function backgroundSettings(){return {enabled:backgroundEnabled,scalp:scalpCfg,basketEnabled:!!basketDemo.enabled,basketModeVersion:2};}
function backgroundAdoptSettings(saved){
  const scalp=saved&&typeof saved==='object'?saved.scalp:null;
  if(!scalp||typeof scalp!=='object'||!scalp.assets||typeof scalp.assets!=='object')return false;
  const next={...SCALP_DEF,...scalp,assets:{...SCALP_DEF.assets,...scalp.assets}};
  // Same bounds as the settings form and the server validator.
  for(const k of ['target','maxLoss','goal','dayStop','timeStopMin'])if(!(Number.isFinite(+next[k])&&+next[k]>0))next[k]=SCALP_DEF[k];else next[k]=+next[k];
  next.maxLoss=Math.min(next.maxLoss,4);next.dayStop=Math.min(next.dayStop,8);
  scalpCfg=next;saveScalpCfg();
  try{if(typeof renderScalpLive==='function'&&document.getElementById('tsc')?.style.display!=='none')renderScalpLive();}catch(e){}
  return true;
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
    const text=document.createElement('p');text.style.marginTop='10px';text.textContent='Auto Signals and enabled Low Profit strategies use the same paper rules in the server worker. Low Profit uses news-independent order blocks and support/resistance. Fresh candles, quotes and account risk limits still apply. Optional Basket paper is off by default and requires this browser for entry/exit management. Regular Low Profit continues on the server when Basket mode is off.';box.append(text);
    const hosting=document.createElement('p');hosting.textContent='Hosting: Render free can sleep after 15 minutes without incoming traffic. Uninterrupted background scanning requires an always-on service. Telegram uses the server delivery queue while the service is running; device push and browser email require the browser.';box.append(hosting);
    let detail;try{detail=typeof status.details==='string'?JSON.parse(status.details):status.details;}catch(e){}
    if(detail){const lines=document.createElement('p');lines.textContent=detail.reason||Object.entries(detail.instruments||{}).map(([sym,s])=>sym+': Auto — '+s.auto+'; Low Profit — '+s.lowProfit+(s.quoteError?'; Quote — '+s.quoteError:'')+Object.entries(s.frameErrors||{}).map(([tf,error])=>'; '+tf+' — '+error).join('')).join(' · ');box.append(lines);}
    const past=Array.isArray(status.reasonHistory)?status.reasonHistory.filter(r=>r.strategy==='auto'):[];
    if(past.length){
      const head=document.createElement('p');head.style.marginTop='10px';head.textContent='Why Auto did not trade (last 24 h, newest first, IST):';box.append(head);
      const list=document.createElement('ul');list.style.cssText='margin:4px 0 8px 16px;padding:0;font-size:11px';
      const ist=t=>{const d=new Date(t);return Number.isFinite(d.getTime())?d.toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}):'—';};
      past.slice(0,20).forEach(r=>{const li=document.createElement('li');li.textContent=ist(r.first_seen)+'–'+ist(r.last_seen)+' '+r.symbol+': '+r.reason;list.append(li);});
      box.append(list);
    }
    if(status.cycleError){const error=document.createElement('p');error.textContent=status.cycleError;box.append(error);}
    if(detail?.calendarError){const news=document.createElement('p');news.textContent=detail.calendarError;box.append(news);}
    if(status.reason){const reason=document.createElement('p');reason.textContent=status.reason;box.append(reason);}
    const button=document.createElement('button');button.className='qa';button.type='button';button.textContent=backgroundEnabled?'Pause background scanner':'Enable background scanner';button.onclick=async()=>{backgroundEnabled=!backgroundEnabled;backgroundDigest='';await backgroundRefresh();};box.append(button);
  }
}
setInterval(backgroundRefresh,10000);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',backgroundRefresh);else backgroundRefresh();
