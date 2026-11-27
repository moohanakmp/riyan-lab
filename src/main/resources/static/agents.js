/* Agents desk, opening roll call and voice assistant.
   Presentation only: every agent reads state the app already has (or a read-only status API).
   Nothing here places, closes or changes a trade, a setting or a broker order. */
(function(root){
  'use strict';
  const STATE_LABEL={ok:'Working',busy:'Busy',warn:'Needs attention',off:'Offline',idle:'Idle'};
  const fmtAge=ms=>!Number.isFinite(ms)||ms<0?'unknown':ms<90e3?Math.round(ms/1e3)+' seconds':ms<90*60e3?Math.round(ms/60e3)+' minutes':Math.round(ms/36e5)+' hours';
  const money=v=>(v>=0?'plus ':'minus ')+Math.abs(v).toFixed(2)+' dollars';
  const NAMES={XAUUSD:'Gold',XAGUSD:'Silver',BTCUSD:'Bitcoin'};
  // Top-level let/const in the page script are not window properties, so read them by name (no eval: CSP).
  const G={currentUser:()=>typeof currentUser!=='undefined'?currentUser:undefined,riyanApi:()=>typeof riyanApi!=='undefined'?riyanApi:undefined,activeSignals:()=>typeof activeSignals!=='undefined'?activeSignals:undefined,signalHistory:()=>typeof signalHistory!=='undefined'?signalHistory:undefined,prices:()=>typeof prices!=='undefined'?prices:undefined,scalpCfg:()=>typeof scalpCfg!=='undefined'?scalpCfg:undefined,scalpHist:()=>typeof scalpHist!=='undefined'?scalpHist:undefined,LiveVolume:()=>typeof LiveVolume!=='undefined'?LiveVolume:undefined,volumeTrapSym:()=>typeof volumeTrapSym!=='undefined'?volumeTrapSym:undefined,backgroundStatus:()=>typeof backgroundStatus!=='undefined'?backgroundStatus:undefined,backgroundEnabled:()=>typeof backgroundEnabled!=='undefined'?backgroundEnabled:undefined,calendarHealth:()=>typeof calendarHealth!=='undefined'?calendarHealth:undefined,PAPER_LIMITS:()=>typeof PAPER_LIMITS!=='undefined'?PAPER_LIMITS:undefined,showToast:()=>typeof showToast!=='undefined'?showToast:undefined,hasAccess:()=>typeof hasAccess!=='undefined'?hasAccess:undefined,isMetalsMarketOpen:()=>typeof isMetalsMarketOpen!=='undefined'?isMetalsMarketOpen:undefined,computeSignal:()=>typeof computeSignal!=='undefined'?computeSignal:undefined,autoEntryCheck:()=>typeof autoEntryCheck!=='undefined'?autoEntryCheck:undefined,istDayKey:()=>typeof istDayKey!=='undefined'?istDayKey:undefined,allPaperRows:()=>typeof allPaperRows!=='undefined'?allPaperRows:undefined,sigTime:()=>typeof sigTime!=='undefined'?sigTime:undefined,pnlStats:()=>typeof pnlStats!=='undefined'?pnlStats:undefined,freshQuote:()=>typeof freshQuote!=='undefined'?freshQuote:undefined,fmtP:()=>typeof fmtP!=='undefined'?fmtP:undefined,scalpToday:()=>typeof scalpToday!=='undefined'?scalpToday:undefined,calendarReady:()=>typeof calendarReady!=='undefined'?calendarReady:undefined};
  const g=name=>{try{return G[name]?G[name]():root[name];}catch(e){return undefined;}};
  const call=(name,...a)=>{const f=g(name);return typeof f==='function'?f(...a):undefined;};
  const can=f=>!!call('hasAccess',f);
  const isAdmin=()=>g('currentUser')?.role==='admin';

  // Read-only server facts, refreshed at most every 30 s while the desk or roll call is open.
  const server={at:0,busy:false,telegram:null,news:null,broker:null,lead:null,errors:{}};
  async function refreshServer(force=false){
    if(server.busy||(!force&&Date.now()-server.at<30e3)||!g('currentUser'))return;
    server.busy=true;
    const api=g('riyanApi');
    const get=async(key,path)=>{try{server[key]=await api(path);delete server.errors[key];}catch(e){server[key]=null;server.errors[key]=String(e?.message||e).slice(0,80);}};
    try{
      const jobs=[get('news','/api/v1/news/latest?symbol=XAUUSD'),get('lead','/api/v1/agents/lead')];
      if(['admin','user'].includes(g('currentUser')?.role))jobs.push(get('telegram','/api/v1/telegram/status'));
      if(isAdmin())jobs.push(get('broker','/api/v1/broker/account'));
      await Promise.all(jobs);server.at=Date.now();
    }finally{server.busy=false;}
  }

  function assetState(sym){
    try{
      const active=g('activeSignals')||{},hist=g('signalHistory')||[];
      if(active[sym]){const r=hist.find(x=>x.id===active[sym]&&x.outcome==='OPEN');return {tag:'OPEN',why:(r?.dir||'')+' trade open'};}
      if(sym!=='BTCUSD'&&!call('isMetalsMarketOpen'))return {tag:'CLOSED',why:'market closed'};
      const sig=call('computeSignal',sym);if(!sig)return {tag:'WAIT',why:'no data yet'};
      const ok=sig.smart?.tier?call('autoEntryCheck',sym,sig):null;
      if(sig.smart?.tier&&ok?.ok)return {tag:'SETUP',why:sig.state+' setup, waiting for server acceptance'};
      return {tag:sig.smart?.tier?'BLOCKED':'WAIT',why:(ok&&!ok.ok?ok.reason:sig.reason)||'waiting for a confirmed setup'};
    }catch(e){return {tag:'WAIT',why:'signal check unavailable'};}
  }
  function todayPnl(){
    try{const sod=call('istDayKey',Date.now())*864e5-19800000;const rows=(call('allPaperRows')||[]).filter(r=>call('sigTime',r)>=sod);return call('pnlStats',rows);}catch(e){return null;}
  }

  // Each agent maps to a real part of the app. report() returns {state, line} in plain words.
  const AGENTS=[
    {id:'ticker',name:'TICKER',role:'Price feeds',hue:'#f6c90e',show:()=>can('prices')||can('dashboard')||can('chart'),report(){
      const syms=['XAUUSD','XAGUSD','BTCUSD'],fresh=syms.filter(s=>call('freshQuote',s));
      const metalsOpen=call('isMetalsMarketOpen')!==false;
      const p=s=>{const v=g('prices')?.[s];return Number.isFinite(v)?NAMES[s]+' '+call('fmtP',s,v):null;};
      const line=syms.map(p).filter(Boolean).join(', ');
      if(fresh.length===3)return {state:'ok',line:'All three prices are live. '+line+'.'};
      if(!metalsOpen&&fresh.includes('BTCUSD'))return {state:'idle',line:'Metals market is closed. Bitcoin is live at '+call('fmtP','BTCUSD',g('prices').BTCUSD)+'.'};
      return {state:fresh.length?'warn':'off',line:fresh.length+' of 3 prices are live. '+(line?line+'.':'Waiting for quotes.')};
    }},
    {id:'hunter',name:'HUNTER',role:'Auto signals',hue:'#38baff',show:()=>can('signals'),report(){
      const states=['XAUUSD','XAGUSD','BTCUSD'].map(s=>({s,...assetState(s)}));
      const open=states.filter(x=>x.tag==='OPEN'),setup=states.filter(x=>x.tag==='SETUP');
      const summary=states.map(x=>NAMES[x.s]+' '+x.tag.toLowerCase()).join(', ');
      if(open.length||setup.length)return {state:'busy',line:summary+'.'};
      return {state:'ok',line:'Scanning. '+summary+'. No clean setup yet.'};
    }},
    {id:'sparrow',name:'SPARROW',role:'Low Profit scalper',hue:'#22c55e',show:()=>can('signals'),report(){
      const cfg=g('scalpCfg')||{},t=call('scalpToday');
      const open=(g('scalpHist')||[]).filter(x=>x.status==='OPEN').length;
      if(!t)return {state:'off',line:'Low Profit data is not loaded yet.'};
      const goal=' Today '+money(t.pnl)+' of the '+(cfg.goal||10)+' dollar goal.';
      if(t.stopHit)return {state:'warn',line:'Daily stop reached. Paused for today.'+goal};
      if(t.goalHit)return {state:'idle',line:'Goal reached for today.'+goal};
      return {state:cfg.auto?(open?'busy':'ok'):'idle',line:(cfg.auto?'Auto is on, paper only.':'Auto is off.')+(open?' '+open+' paper scalp open.':'')+goal};
    }},
    {id:'trapper',name:'TRAPPER',role:'Volume Trap & order flow',hue:'#a78bfa',show:()=>can('flow'),report(){
      const LV=g('LiveVolume'),sym=g('volumeTrapSym')||'XAUUSD';
      if(!LV)return {state:'off',line:'Live volume is not loaded.'};
      const s=LV.snapshot(sym),name=NAMES[sym];
      if(s.status==='live')return {state:'ok',line:name+' one-minute stream is live.'};
      if(s.status==='quiet')return {state:'ok',line:name+' stream is connected. The market is quiet, waiting for trades.'};
      if(s.status==='connecting'||s.status==='reconnecting')return {state:'busy',line:'Connecting to the '+name+' trade stream.'};
      if(s.status==='unavailable')return {state:'warn',line:name+' stream error: '+String(s.error||'unknown').slice(0,80)+'. Retrying.'};
      return {state:'idle',line:name+' stream is off. Turn on flow alerts in Volume Trap to keep it running.'};
    }},
    {id:'nightowl',name:'NIGHT OWL',role:'Server scanner',hue:'#5cc8ff',show:()=>can('signals'),report(){
      const s=g('backgroundStatus'),on=g('backgroundEnabled');
      if(!s)return {state:'idle',line:'Waiting for the server scanner status.'};
      if(on===false)return {state:'warn',line:'Background scanning is paused.'};
      if(s.owner==='BROWSER')return {state:'ok',line:'This browser is scanning. I take over when the app closes.'};
      if(s.owner==='SERVER')return {state:'busy',line:'Scanning on the server right now.'};
      return {state:'idle',line:'Standing by for the next scan.'};
    }},
    {id:'scout',name:'SCOUT',role:'News & calendar',hue:'#f59e0b',show:()=>true,report(){
      const h=g('calendarHealth'),ready=call('calendarReady');
      const items=server.news,newest=Array.isArray(items)&&items.length?Date.parse(items[0].checked_at):NaN;
      const news=Number.isFinite(newest)?' News checked '+fmtAge(Date.now()-newest)+' ago.':server.errors.news?' News check unavailable.':'';
      if(ready)return {state:'ok',line:'Economic calendar is ready.'+news};
      return {state:'warn',line:'Calendar not confirmed'+(h?.calendarError?': '+h.calendarError:'')+'.'+news};
    }},
    {id:'warden',name:'WARDEN',role:'Risk guard',hue:'#ef4444',show:()=>can('signals'),report(){
      const L=g('PAPER_LIMITS')||{riskUsd:4,dayLossUsd:8,maxOpen:5};
      const open=(call('allPaperRows')||[]).filter(r=>(r.outcome||r.status)==='OPEN').length;
      const st=todayPnl(),loss=st&&st.pnl<0?-st.pnl:0;
      const line=open+' of '+L.maxOpen+' positions open. Daily loss '+loss.toFixed(2)+' of '+L.dayLossUsd+' dollars. Max '+L.riskUsd+' dollars risk per trade.';
      return {state:loss>=L.dayLossUsd||open>=L.maxOpen?'warn':'ok',line};
    }},
    {id:'courier',name:'COURIER',role:'Telegram alerts',hue:'#29b6f6',show:()=>['admin','user'].includes(g('currentUser')?.role),report(){
      const t=server.telegram;
      if(!t)return {state:'idle',line:server.errors.telegram?'Telegram status unavailable.':'Checking Telegram.'};
      if(!t.configured)return {state:'off',line:'Telegram is not set up.'};
      if(!t.enabled)return {state:'idle',line:'Telegram alerts are turned off.'};
      const c=Object.fromEntries((t.counts||[]).map(x=>[x.state,+x.count]));
      const failed=(c.FAILED||0)+(c.RETRY||0);
      return {state:failed?'warn':'ok',line:'Telegram is on. '+(c.SENT||0)+' alerts delivered'+(failed?', '+failed+' waiting to retry.':'.')};
    }},
    {id:'vault',name:'VAULT',role:'Ledger & sync',hue:'#94a3b8',show:()=>true,report(){
      const b=document.getElementById('riyanSyncBtn'),txt=(b?.textContent||'').replace(/[^\w &]/g,'').trim();
      if(/synced/i.test(txt))return {state:'ok',line:'Database synced. Paper ledger is safe on the server.'};
      if(/fail|error|offline/i.test(txt))return {state:'warn',line:'Database sync failed. Tap DB Sync to retry.'};
      if(/pending/i.test(txt))return {state:'busy',line:(txt.match(/\d+/)||['Some'])[0]+' records waiting to save to the server.'};
      return {state:'idle',line:'Waiting for the next database sync.'};
    }},
    {id:'bridge',name:'BRIDGE',role:'MT5 broker (admin)',hue:'#fb7185',show:isAdmin,report(){
      const b=server.broker,a=b?.account;
      if(!b)return {state:'idle',line:server.errors.broker?'Broker status unavailable.':'Checking the broker bridge.'};
      if(!a)return {state:'off',line:'No broker account linked.'};
      if(a.kill_switch)return {state:'warn',line:'Kill switch is on. Nothing will be mirrored.'};
      return {state:a.connector_online?'ok':'idle',line:(a.mode||'DRY_RUN')+' mode. MT5 connector '+(a.connector_online?'online':'offline')+'.'};
    }}
  ];
  // ATLAS's tasks for the day come from the server (LeadAgent.java); each agent shows its own.
  const TASK_LABEL={DONE:'Done',BLOCKED:'Blocked',ASSIGNED:'Assigned',SKIPPED:'Skipped'};
  function tasks(){const t=server.lead?.tasks;return Array.isArray(t)?t:[];}
  function taskFor(name){const mine=tasks().filter(t=>t.agent===name);if(!mine.length)return null;
    return mine.find(t=>t.status==='BLOCKED')||mine.find(t=>t.status==='ASSIGNED')||mine[0];}
  function planSummary(){
    const t=tasks();if(!t.length)return null;
    const done=t.filter(x=>x.status==='DONE'||x.status==='SKIPPED').length,blocked=t.filter(x=>x.status==='BLOCKED');
    return {total:t.length,done,blocked,line:'Today\'s plan: '+t.length+' tasks, '+done+' done'+(blocked.length?', '+blocked.length+' blocked ('+[...new Set(blocked.map(x=>x.agent))].join(', ')+')':'')+'.'};
  }
  function visibleAgents(){return AGENTS.filter(a=>{try{return a.show();}catch(e){return false;}});}
  function reports(){
    const list=visibleAgents().map(a=>{let r;try{r=a.report();}catch(e){r={state:'warn',line:'Status check failed.'};}return {...a,...r,task:taskFor(a.name)};});
    const attention=list.filter(r=>r.state==='warn'||r.state==='off').length,plan=planSummary();
    const lead={id:'atlas',name:'ATLAS',role:'Lead (CEO)',hue:'#e9b949',state:attention||plan?.blocked.length?'warn':'ok',task:null,
      line:'Atlas online. '+list.length+' agents on duty'+(attention?', '+attention+(attention>1?' need':' needs')+' attention.':', all reporting normally.')+(plan?' '+plan.line:'')};
    const all=[lead,...list];note(all);return all;
  }
  // Per-agent status history for the Office terminal: one entry each time an agent's state or line changes.
  const log={};
  function note(list){const t=Date.now();for(const r of list){const h=log[r.id]||(log[r.id]=[]),last=h[h.length-1];
    if(!last||last.line!==r.line||last.state!==r.state){h.push({t,state:r.state,line:r.line});if(h.length>40)h.shift();}}}

  // ── Voice ─────────────────────────────────────────────────────────────
  const prefs={get voice(){try{return localStorage.getItem('kmr_agent_voice')!=='off';}catch(e){return true;}},set voice(v){try{localStorage.setItem('kmr_agent_voice',v?'on':'off');}catch(e){}},
    get rollcall(){try{return localStorage.getItem('kmr_rollcall')!=='off';}catch(e){return true;}},set rollcall(v){try{localStorage.setItem('kmr_rollcall',v?'on':'off');}catch(e){}}};
  function pickVoice(){const vs=root.speechSynthesis?.getVoices?.()||[];return vs.find(v=>/en-IN/i.test(v.lang))||vs.find(v=>/^en/i.test(v.lang))||null;}
  function speak(text){
    return new Promise(resolve=>{
      if(!prefs.voice||!root.speechSynthesis||typeof SpeechSynthesisUtterance==='undefined'){setTimeout(resolve,Math.min(3500,600+text.length*45));return;}
      const u=new SpeechSynthesisUtterance(text);const v=pickVoice();if(v){u.voice=v;u.lang=v.lang;}else u.lang='en-IN';
      u.rate=1.02;let done=false;const end=()=>{if(!done){done=true;resolve();}};
      u.onend=end;u.onerror=end;setTimeout(end,Math.min(15000,2000+text.length*90));
      try{root.speechSynthesis.speak(u);}catch(e){end();}
    });
  }
  function stopSpeaking(){try{root.speechSynthesis?.cancel();}catch(e){}}

  // ── Roll call overlay ─────────────────────────────────────────────────
  let rolling=false,cancelRoll=false,rollTimer=null;
  function overlay(){
    let o=document.getElementById('rollCall');if(o)return o;
    o=document.createElement('div');o.id='rollCall';o.setAttribute('role','dialog');o.setAttribute('aria-label','Agent roll call');
    o.innerHTML='<div class="rc-top"><span class="rc-count" id="rcCount"></span><button type="button" class="rc-skip" id="rcSkip">Skip</button></div>'+
      '<div class="rc-stage"><div class="rc-orb" id="rcOrb"><i></i></div><div class="rc-name" id="rcName"></div><div class="rc-role" id="rcRole"></div><p class="rc-line" id="rcLine" aria-live="polite"></p>'+
      '<button type="button" class="rc-start" id="rcStart" hidden>Tap to hear the team report</button></div><div class="rc-dots" id="rcDots"></div>';
    document.body.append(o);
    o.querySelector('#rcSkip').onclick=()=>{cancelRoll=true;stopSpeaking();close();};
    return o;
  }
  function close(){const o=document.getElementById('rollCall');if(o)o.classList.add('rc-out');setTimeout(()=>o?.remove(),350);rolling=false;}
  async function rollCall(opts={}){
    if(rolling||!g('currentUser'))return;rolling=true;cancelRoll=false;
    const o=overlay();o.classList.remove('rc-out');
    // Browsers only allow speech after a tap. After a fresh login the tap already happened.
    const activated=opts.fromTap||navigator.userActivation?.hasBeenActive!==false;
    if(prefs.voice&&!activated){
      const start=o.querySelector('#rcStart');start.hidden=false;o.querySelector('#rcName').textContent='Agents ready';o.querySelector('#rcLine').textContent='Your team is ready to report.';
      await new Promise(res=>{start.onclick=()=>{start.hidden=true;res();};o.querySelector('#rcSkip').addEventListener('click',res,{once:true});});
      if(cancelRoll)return;
    }
    await refreshServer(true);await new Promise(r=>setTimeout(r,400));
    const list=reports();
    o.querySelector('#rcDots').innerHTML=list.map(a=>`<span style="--h:${a.hue}" title="${a.name}"></span>`).join('');
    for(let i=0;i<list.length&&!cancelRoll;i++){
      const a=list[i];
      o.style.setProperty('--h',a.hue);o.querySelector('#rcOrb').className='rc-orb rc-'+a.state;
      o.querySelector('#rcName').textContent=a.name;o.querySelector('#rcRole').textContent=a.role+' · '+STATE_LABEL[a.state];
      o.querySelector('#rcLine').textContent=a.line;o.querySelector('#rcCount').textContent=(i+1)+' / '+list.length;
      o.querySelectorAll('#rcDots span').forEach((d,j)=>d.classList.toggle('on',j<=i));
      const orb=o.querySelector('#rcOrb');orb.classList.remove('rc-pop');void orb.offsetWidth;orb.classList.add('rc-pop');
      await speak(a.name.toLowerCase()+'. '+a.line);
      await new Promise(r=>setTimeout(r,250));
    }
    if(!cancelRoll){
      o.style.setProperty('--h','#e9b949');o.querySelector('#rcOrb').className='rc-orb rc-ok rc-pop';
      o.querySelector('#rcName').textContent='TEAM READY';o.querySelector('#rcRole').textContent='';
      o.querySelector('#rcLine').textContent='All '+list.length+' agents have reported.';
      await speak('All agents have reported. Team ready.');await new Promise(r=>setTimeout(r,900));
    }
    close();render();
  }
  function maybeRollCall(){
    const done=()=>{try{return !prefs.rollcall||!!sessionStorage.getItem('kmr_rollcall_done');}catch(e){return false;}};
    if(done()||rollTimer)return;
    // Mark it done only when it starts: the page can reload itself once on first load (app update), which drops this timer.
    rollTimer=setTimeout(()=>{rollTimer=null;if(done()||rolling)return;try{sessionStorage.setItem('kmr_rollcall_done','1');}catch(e){}rollCall();},2500);
  }

  // ── Voice / text assistant ────────────────────────────────────────────
  const chat=[];
  function symsIn(q){const out=[];if(/gold|xau/.test(q))out.push('XAUUSD');if(/silver|xag/.test(q))out.push('XAGUSD');if(/bitcoin|btc|crypto/.test(q))out.push('BTCUSD');return out;}
  function answer(raw){
    const q=String(raw||'').toLowerCase().trim();if(!q)return 'Ask me about prices, signals, open trades, today\'s profit, Low Profit, news or the team.';
    if(/^(please )?(buy|sell|close|exit|place|open a|enter)\b/.test(q))return 'I can\'t place or close trades by voice. Use the buttons in the app.';
    const syms=symsIn(q),list=syms.length?syms:['XAUUSD','XAGUSD','BTCUSD'];
    if(/plan|task|work|briefing|market (today|view|condition)|ceo|atlas|manager/.test(q)){
      const p=planSummary(),notes=server.lead?.notes;
      if(!p)return 'Atlas has not published today\'s plan yet. The server writes it within a minute of starting.';
      return p.line+(Array.isArray(notes)&&notes.length?' '+notes.slice(0,4).join(' '):'')+(p.blocked.length?' Blocked: '+p.blocked.map(x=>x.agent+', '+x.evidence).join('. ')+'.':'');
    }
    if(/team|agent|everyone|roll ?call|report|status of all|how is everything/.test(q)){const r=reports();return r.map(a=>a.name+': '+a.line).join(' ');}
    if(/price|rate|quote|trading at|how much/.test(q)||(syms.length&&!/signal|setup|trade|position/.test(q)))
      return list.map(s=>{const v=g('prices')?.[s];return Number.isFinite(v)?NAMES[s]+' is '+call('fmtP',s,v)+(call('freshQuote',s)?'':' (not live right now)'):NAMES[s]+' price is not available';}).join('. ')+'.';
    if(/signal|setup|entry|should i|chance/.test(q))return list.map(s=>{const a=assetState(s);return NAMES[s]+': '+a.tag.toLowerCase()+', '+a.why;}).join('. ')+'.';
    if(/open|active|position|running trade/.test(q)){const rows=(call('allPaperRows')||[]).filter(r=>(r.outcome||r.status)==='OPEN');
      return rows.length?rows.length+' paper trade'+(rows.length>1?'s':'')+' open: '+rows.slice(0,5).map(r=>NAMES[r.sym]+' '+(r.dir||'')).join(', ')+'.':'No paper trades are open.';}
    if(/low profit|scalp|sparrow/.test(q)){const t=call('scalpToday');return t?'Low Profit today: '+money(t.pnl)+', '+t.wins+' wins, '+t.losses+' losses.':'Low Profit data is not loaded yet.';}
    if(/profit|p ?& ?l|pnl|loss|money|earn|today/.test(q)){const st=todayPnl();return st?'Today\'s paper result is '+money(st.pnl)+(st.closed?', '+st.w+' wins and '+st.l+' losses.':'. No closed trades yet.'):'P and L is not loaded yet.';}
    if(/news|calendar|event/.test(q))return AGENTS.find(a=>a.id==='scout').report().line;
    if(/volume|trap|flow/.test(q))return AGENTS.find(a=>a.id==='trapper').report().line;
    if(/telegram|alert/.test(q))return AGENTS.find(a=>a.id==='courier').report().line;
    if(/risk|limit/.test(q))return AGENTS.find(a=>a.id==='warden').report().line;
    if(/broker|mt5/.test(q))return isAdmin()?AGENTS.find(a=>a.id==='bridge').report().line:'The broker bridge is for admins only.';
    if(/hello|hi\b|hey/.test(q))return 'Hello '+(g('currentUser')?.username||'')+'. Ask me about prices, signals, trades or the team.';
    return 'I can tell you prices, signals, open trades, today\'s profit, Low Profit, news, risk and the team status.';
  }
  async function ask(text,spoken=false){
    const reply=answer(text);chat.push({who:'you',text},{who:'atlas',text:reply});if(chat.length>40)chat.splice(0,chat.length-40);
    renderChat();if(spoken||prefs.voice)await speak(reply);
    return reply;
  }
  let recog=null,listening=false;
  function micSupported(){return !!(root.SpeechRecognition||root.webkitSpeechRecognition);}
  function listen(){
    if(!micSupported()){toast('Voice input is not supported in this browser. Type your question instead.');return;}
    if(listening){try{recog?.stop();}catch(e){}return;}
    stopSpeaking();
    const R=root.SpeechRecognition||root.webkitSpeechRecognition;recog=new R();recog.lang='en-IN';recog.interimResults=false;recog.maxAlternatives=1;
    listening=true;setMic();
    recog.onresult=e=>{const t=e.results?.[0]?.[0]?.transcript||'';if(t)ask(t,true);};
    recog.onerror=e=>{if(e.error==='not-allowed')toast('Microphone permission is blocked for this site.');};
    recog.onend=()=>{listening=false;setMic();};
    try{recog.start();}catch(e){listening=false;setMic();}
  }
  function toast(t){const f=g('showToast');if(typeof f==='function')f(t);}
  function setMic(){document.querySelectorAll('[data-agent-mic]').forEach(b=>{b.classList.toggle('listening',listening);b.setAttribute('aria-pressed',String(listening));b.querySelector('span')&&(b.querySelector('span').textContent=listening?'Listening…':'Talk');});}

  // ── Agents desk (Tools → Agents) ──────────────────────────────────────
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function renderChat(){
    const box=document.getElementById('agentChat');if(!box)return;
    box.innerHTML=chat.length?chat.map(m=>`<div class="ac-msg ac-${m.who}"><b>${m.who==='you'?'You':'Atlas'}</b><span>${esc(m.text)}</span></div>`).join(''):'<div class="ac-empty">Tap <b>Talk</b> and ask: “gold price”, “any signals?”, “open trades”, “today’s profit”, “team status”.</div>';
    box.scrollTop=box.scrollHeight;
  }
  function render(){
    const grid=document.getElementById('agentGrid');if(!grid||document.getElementById('tag')?.style.display==='none')return;
    const list=reports(),lead=list[0];
    document.getElementById('agentLead').innerHTML=`<span class="ag-dot ag-${lead.state}"></span>${esc(lead.line)}`;
    grid.innerHTML=list.map(a=>`<article class="ag-desk ag-${a.state}" style="--h:${a.hue}">
      <div class="ag-head"><div class="ag-orb" aria-hidden="true"><i></i></div><div><h3>${esc(a.name)}</h3><p>${esc(a.role)}</p></div><span class="ag-pill">${STATE_LABEL[a.state]}</span></div>
      <div class="ag-bubble">${esc(a.line)}</div>${a.task?`<p class="ag-task">Task from Atlas: <b>${esc(a.task.title)}</b> · ${esc(TASK_LABEL[a.task.status]||a.task.status)}</p>`:''}</article>`).join('');
    renderPlan();
    document.getElementById('agentVoiceToggle').checked=prefs.voice;document.getElementById('agentRollToggle').checked=prefs.rollcall;
    document.getElementById('agentMicNote').hidden=micSupported();
    try{root.KmrCommand?.render?.();}catch(e){}
  }
  const hhmm=ms=>{const d=new Date(+ms);return Number.isFinite(d.getTime())?d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Kolkata'}):'';};
  function renderPlan(){
    const L=server.lead,count=document.getElementById('agentPlanCount');if(!count)return;
    const p=planSummary(),hue=Object.fromEntries(AGENTS.map(a=>[a.name,a.hue]));
    count.textContent=p?p.done+' / '+p.total+' done':server.errors.lead?'Unavailable':'Waiting for Atlas';
    document.getElementById('agentNotes').innerHTML=(Array.isArray(L?.notes)?L.notes:[]).map(n=>`<li>${esc(n)}</li>`).join('');
    document.getElementById('agentTasks').innerHTML=tasks().map(t=>`<li style="--h:${hue[t.agent]||'#e9b949'}"><span class="ag-st ag-st-${esc(t.status)}">${esc(TASK_LABEL[t.status]||t.status)}</span><span><span class="ag-who">${esc(t.agent)}</span> ${esc(t.title)}</span><span class="ag-ev">${esc(t.evidence||'')}${t.doneAt&&t.status==='DONE'?' · done '+hhmm(t.doneAt)+' IST':t.doneAt&&t.status==='BLOCKED'?' · was done at '+hhmm(t.doneAt)+' IST':''}</span></li>`).join('');
    const hist=(L?.history||[]).slice(1,7).map(h=>h.day.slice(5)+': '+h.done+'/'+h.total).join(' · ');
    const review=L?.paperReview,rv=review?.lines?.length?' Last 7 days (paper): '+review.lines.join('; ')+'.'+(review.bestSession?' Best session: '+review.bestSession+'.':''):'';
    document.getElementById('agentPlanMeta').textContent=(L?.briefingAt?'Briefing updated '+hhmm(L.briefingAt)+' IST. ':'')+(hist?'Earlier days: '+hist+'.':'')+rv+(review?' '+review.note:'')+' Atlas is rule based, reads real app data only and never places trades.';
    const bg=L?.background,line=document.getElementById('agentBgLine');
    if(line)line.textContent=!bg?(server.errors.lead?'Server status unavailable.':'Checking the server scanner…'):!bg.scannerEnabled?'Server scanner is turned off.':
      (bg.lastScanAgoSeconds>=0&&bg.lastScanAgoSeconds<180?'Server is scanning now (last scan '+bg.lastScanAgoSeconds+' s ago). You can close the app.':'Server scan is not running right now.')+
      (!bg.keepAwakeConfigured?' This server is not kept awake: on free hosting it sleeps after 15 minutes with no visitors.':bg.keepAwake?' Kept awake for the trading week ('+bg.keepAwakeWindow+').':' Weekend: the free server may sleep until someone opens the app.');
  }
  function open(){refreshServer().then(render);render();renderChat();try{root.KmrPush?.sync?.();}catch(e){}}
  function wire(){
    const form=document.getElementById('agentAskForm');
    if(form&&!form.dataset.wired){form.dataset.wired='1';form.addEventListener('submit',e=>{e.preventDefault();const i=document.getElementById('agentAsk');const t=i.value.trim();if(t){i.value='';ask(t);}});}
    document.getElementById('agentVoiceToggle')?.addEventListener('change',e=>{prefs.voice=e.target.checked;if(!e.target.checked)stopSpeaking();});
    document.getElementById('agentRollToggle')?.addEventListener('change',e=>{prefs.rollcall=e.target.checked;});
    document.querySelectorAll('[data-agent-mic]').forEach(b=>b.addEventListener('click',listen));
    document.getElementById('agentRollBtn')?.addEventListener('click',()=>rollCall({fromTap:true}));
    setInterval(()=>{if(document.getElementById('tag')?.style.display!=='none'&&!document.hidden){refreshServer().then(render);}},10e3);

    // This file is deferred, so sign-in may have finished before it loaded: catch up on the desk and the roll call.
    if(g('currentUser')){if(document.getElementById('tag')?.style.display==='block')open();maybeRollCall();}
  }
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();}
  root.KmrAgents={AGENTS,reports,tasks,planSummary,assetState,todayPnl,lead:()=>server.lead,answer,ask,rollCall,maybeRollCall,open,render,listen,log,speak,stopSpeaking,refresh:refreshServer,prefs,STATE_LABEL,_test:{assetState,refreshServer,server}};
})(typeof window==='undefined'?globalThis:window);
