/* Command center: the top of the Agents tab, drawn as one monitoring screen.
   Display only. It reads KmrAgents (real agent status) and the page's own market state.
   It makes no network calls and never places, closes or changes a trade or a setting. */
(function(root){
  'use strict';
  const NAMES={XAUUSD:'Gold',XAGUSD:'Silver',BTCUSD:'Bitcoin'},SYMS=['XAUUSD','XAGUSD','BTCUSD'];
  const IST=19800000;
  // Top-level let/const in the page script are not window properties, so read them by name (no eval: CSP).
  const G={prices:()=>typeof prices!=='undefined'?prices:undefined,freshQuote:()=>typeof freshQuote!=='undefined'?freshQuote:undefined,fmtP:()=>typeof fmtP!=='undefined'?fmtP:undefined,
    computeSignal:()=>typeof computeSignal!=='undefined'?computeSignal:undefined,isMetalsMarketOpen:()=>typeof isMetalsMarketOpen!=='undefined'?isMetalsMarketOpen:undefined,
    sessionSummaryLine:()=>typeof sessionSummaryLine!=='undefined'?sessionSummaryLine:undefined,allPaperRows:()=>typeof allPaperRows!=='undefined'?allPaperRows:undefined,
    sigTime:()=>typeof sigTime!=='undefined'?sigTime:undefined,hasAccess:()=>typeof hasAccess!=='undefined'?hasAccess:undefined,showTab:()=>typeof showTab!=='undefined'?showTab:undefined};
  const g=n=>{try{return G[n]?G[n]():root[n];}catch(e){return undefined;}};
  const call=(n,...a)=>{const f=g(n);try{return typeof f==='function'?f(...a):undefined;}catch(e){return undefined;}};
  const A=()=>root.KmrAgents;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const $=id=>typeof document!=='undefined'?document.getElementById(id):null;
  const istParts=ms=>{const d=new Date(ms+IST);return {y:d.getUTCFullYear(),m:d.getUTCMonth(),d:d.getUTCDate(),wd:d.getUTCDay(),hh:d.getUTCHours(),mi:d.getUTCMinutes(),ss:d.getUTCSeconds()};};
  const pad=n=>String(n).padStart(2,'0');
  const dayKey=ms=>{const p=istParts(ms);return p.y+'-'+pad(p.m+1)+'-'+pad(p.d);};
  const hms=ms=>{const p=istParts(ms);return pad(p.hh)+':'+pad(p.mi)+':'+pad(p.ss);};
  const usd=v=>(v<0?'−':v>0?'+':'')+'$'+Math.abs(v).toFixed(2);
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const healthy=s=>s==='ok'||s==='busy'||s==='idle';

  // Ring per market: setup quality 0..100 from the same scan the Signals tab uses.
  function pulse(sym){
    const live=!!call('freshQuote',sym),px=g('prices')?.[sym];
    const st=A()?.assetState?.(sym)||{tag:'WAIT',why:''};
    let score=null;
    if(live&&st.tag!=='CLOSED'){const sig=call('computeSignal',sym),s=sig&&!sig.dataUnavailable&&!sig.referenceOnly&&!sig.quoteUnavailable?sig.smart:null;if(s&&Number.isFinite(s.score)&&Array.isArray(s.gates)&&s.gates.length)score=Math.max(0,Math.min(100,Math.round(s.score)));}
    return {sym,name:NAMES[sym],live,price:Number.isFinite(px)?call('fmtP',sym,px)??String(px):null,tag:st.tag,why:st.why,score};
  }
  // Closed paper results per IST day, for the calendar dots. Paper only.
  function paperDays(){
    const out={};
    for(const r of call('allPaperRows')||[]){
      if(!r||r.outcome==='OPEN'||!Number.isFinite(r.pnlUsd))continue;
      const t=Number(r.closedAt)||call('sigTime',r)||Number(r.ts);if(!Number.isFinite(t))continue;
      const k=dayKey(t),o=out[k]||(out[k]={n:0,pnl:0});o.n++;o.pnl+=r.pnlUsd;
    }
    return out;
  }
  // Share of time each agent has been healthy (not "needs attention" or "offline") since the app opened.
  function uptime(id,now=Date.now()){
    const h=A()?.log?.[id];if(!h||!h.length)return null;
    let good=0,total=0;
    for(let i=0;i<h.length;i++){const end=i+1<h.length?h[i+1].t:now,span=Math.max(0,end-h[i].t);total+=span;if(healthy(h[i].state))good+=span;}
    return total<=0?(healthy(h[h.length-1].state)?100:0):Math.round(good/total*100);
  }
  function feed(reps,limit=14){
    const log=A()?.log||{},names=Object.fromEntries((reps||[]).map(r=>[r.id,{name:r.name,hue:r.hue}]));
    const rows=[];for(const id of Object.keys(log))for(const e of log[id])rows.push({...e,id,name:names[id]?.name||id.toUpperCase(),hue:names[id]?.hue||'#94a3b8'});
    return rows.sort((a,b)=>b.t-a.t).slice(0,limit);
  }
  function model(now=Date.now()){
    const reps=A()?.reports?.()||[],team=reps.slice(1);
    const tasks=A()?.tasks?.()||[],plan=A()?.planSummary?.();
    const open=(call('allPaperRows')||[]).filter(r=>(r.outcome||r.status)==='OPEN').length;
    const today=A()?.todayPnl?.();
    return {now,lead:reps[0]||null,team,tasks,plan,open,pnl:Number.isFinite(today?.pnl)?today.pnl:null,
      working:team.filter(r=>r.state==='ok'||r.state==='busy').length,attention:team.filter(r=>r.state==='warn'||r.state==='off').length,
      pulses:SYMS.map(pulse),metalsOpen:call('isMetalsMarketOpen')!==false,session:call('sessionSummaryLine')||'',days:paperDays(),feed:feed(reps)};
  }

  // ── Drawing ─────────────────────────────────────────────────────────────
  const STATE_SHORT={ok:'Working',busy:'Busy',warn:'Attention',off:'Offline',idle:'Idle'};
  function ringSvg(score,hue){
    const r=26,c=2*Math.PI*r,f=score==null?0:score/100;
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${r}" class="cmd-ring-bg"/><circle cx="32" cy="32" r="${r}" class="cmd-ring-fg" style="stroke:${hue}" stroke-dasharray="${(c*f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/></svg>`;
  }
  const PULSE_HUE={OPEN:'#38baff',SETUP:'#4ade80',BLOCKED:'#fbbf24',WAIT:'#7dd3fc',CLOSED:'#64748b'};
  function drawPulse(m){
    $('cmdRings').innerHTML=m.pulses.map(p=>`<div class="cmd-ring" title="${esc(p.why)}">
      <div class="cmd-ring-dial">${ringSvg(p.score,PULSE_HUE[p.tag]||'#7dd3fc')}<b>${p.score==null?'—':p.score}</b></div>
      <span class="cmd-ring-name">${esc(p.name)}</span><span class="cmd-ring-px">${p.price?esc(p.price):'no quote'}</span>
      <span class="cmd-tag cmd-tag-${esc(p.tag)}">${esc(p.tag)}</span></div>`).join('');
  }
  const TASK_MARK={DONE:'✓',SKIPPED:'–',BLOCKED:'!',ASSIGNED:'›'};
  function drawQueue(m){
    $('cmdQueueCount').textContent=m.plan?m.plan.done+' / '+m.plan.total:'';
    $('cmdQueue').innerHTML=m.tasks.length?m.tasks.map(t=>`<li class="cmd-q-${esc(t.status)}"><i>${TASK_MARK[t.status]||'›'}</i><span><b>${esc(t.agent)}</b> ${esc(t.title)}</span></li>`).join('')
      :'<li class="cmd-empty">Waiting for Atlas to post today\'s plan.</li>';
  }
  function drawLog(m){
    $('cmdLog').innerHTML=m.feed.length?m.feed.map(e=>`<li class="cmd-log-${esc(e.state)}"><time>${hms(e.t)}</time><b style="color:${esc(e.hue)}">${esc(e.name)}</b><span>${esc(e.line)}</span></li>`).join('')
      :'<li class="cmd-empty">No status changes yet.</li>';
  }
  function drawStage(m){
    const stage=$('cmdNodes'),lines=$('cmdLines');if(!stage||!lines)return;
    const n=m.team.length||1,R=40;
    const pts=m.team.map((a,i)=>{const ang=(-90+i*360/n)*Math.PI/180;return {a,x:50+R*Math.cos(ang),y:50+R*Math.sin(ang)};});
    lines.innerHTML=pts.map(p=>`<line x1="50" y1="50" x2="${p.x.toFixed(2)}" y2="${p.y.toFixed(2)}" class="cmd-link cmd-link-${p.a.state}"/>`).join('');
    stage.innerHTML=pts.map(p=>`<button type="button" class="cmd-node cmd-${p.a.state}" data-agent="${esc(p.a.id)}" style="left:${p.x.toFixed(2)}%;top:${p.y.toFixed(2)}%;--h:${esc(p.a.hue)}" title="${esc(p.a.line)}" aria-label="${esc(p.a.name+', '+p.a.role+': '+(STATE_SHORT[p.a.state]||p.a.state)+'. Open terminal')}">
      <i></i><b>${esc(p.a.name)}</b><span>${esc(STATE_SHORT[p.a.state]||p.a.state)}</span></button>`).join('');
    const core=$('cmdCore');if(core)core.className='cmd-core cmd-'+(m.lead?.state||'idle');
  }
  function drawCenter(m){
    const big=$('cmdBig');if(big){big.textContent=m.pnl==null?'—':usd(m.pnl);big.className='cmd-big'+(m.pnl>0?' up':m.pnl<0?' down':'');}
    const done=m.plan?m.plan.done+'/'+m.plan.total:'—';
    $('cmdStats').innerHTML=[[m.team.length,'on duty'],[m.working,'working'],[m.attention,'attention'],[done,'tasks done'],[m.open,'open paper']]
      .map(([v,l],i)=>`<div class="${i===2&&m.attention?'warn':''}"><b>${esc(v)}</b><span>${l}</span></div>`).join('');
  }
  function drawSession(m){
    $('cmdSession').textContent=m.metalsOpen?'OPEN':'CLOSED';$('cmdSession').className='cmd-session '+(m.metalsOpen?'open':'closed');
    $('cmdSessionLine').textContent=m.session.replace(/^🔥\s*/,'')||'Metals market';
    $('cmdQuotes').innerHTML=m.pulses.map(p=>`<div class="${p.live?'live':''}"><span>${esc(p.name)}</span><b>${p.price?esc(p.price):'—'}</b><i>${p.live?'live':'stale'}</i></div>`).join('');
  }
  function drawCalendar(m){
    const p=istParts(m.now),first=new Date(Date.UTC(p.y,p.m,1)).getUTCDay(),days=new Date(Date.UTC(p.y,p.m+1,0)).getUTCDate();
    $('cmdMonth').textContent=MONTHS[p.m]+' '+p.y;
    let cells='';for(let i=0;i<first;i++)cells+='<span></span>';
    let traded=0;
    for(let d=1;d<=days;d++){const k=p.y+'-'+pad(p.m+1)+'-'+pad(d),r=m.days[k];if(r)traded++;
      cells+=`<span class="${d===p.d?'today':''}${r?(r.pnl>=0?' win':' loss'):''}" ${r?`title="${esc(r.n+' closed paper trade'+(r.n>1?'s':'')+', '+usd(r.pnl))}"`:''}>${d}</span>`;}
    $('cmdCal').innerHTML=cells;
    $('cmdCalNote').textContent=traded?'Dots: days with closed paper trades (green net up, red net down).':'No closed paper trades this month yet.';
  }
  function drawLoad(m){
    $('cmdLoad').innerHTML=m.team.map(a=>{const u=uptime(a.id,m.now);return `<li style="--h:${esc(a.hue)}" class="cmd-${a.state}"><b>${esc(a.name)}</b><span class="cmd-bar"><i style="width:${u??0}%"></i></span><em>${u==null?'—':u+'%'}</em></li>`;}).join('');
  }
  function tick(){
    const now=Date.now(),p=istParts(now),c=$('cmdClock');if(!c)return;
    c.textContent=pad(p.hh)+':'+pad(p.mi)+':'+pad(p.ss);
    $('cmdDate').textContent=DAYS[p.wd]+', '+p.d+' '+MONTHS[p.m]+' '+p.y+' · IST';
  }
  function visible(){const t=$('tag');return !!t&&t.style.display!=='none'&&!(typeof document!=='undefined'&&document.hidden);}
  function render(){
    if(!$('cmdDeck')||!visible()||!A())return;
    const m=model();
    tick();drawStage(m);drawCenter(m);drawPulse(m);drawQueue(m);drawLog(m);drawSession(m);drawCalendar(m);drawLoad(m);
    const can=f=>{const h=g('hasAccess');return typeof h!=='function'||!!h(f);};
    const vt=$('cmdVolumeTrap'),tp=$('cmdPlanner');if(vt)vt.hidden=!can('flow');if(tp)tp.hidden=!can('manual');
  }
  function go(tab){const b=document.querySelector('.tab[data-tab="'+tab+'"]');call('showTab',tab,b);}
  function wire(){
    const deck=$('cmdDeck');if(!deck||deck.dataset.wired)return;deck.dataset.wired='1';
    $('cmdNodes')?.addEventListener('click',e=>{const b=e.target.closest('[data-agent]');if(!b)return;go('office');setTimeout(()=>{try{root.KmrOffice?.openTerm?.(b.dataset.agent);}catch(err){}},60);});
    $('cmdCore')?.addEventListener('click',()=>{go('office');setTimeout(()=>{try{root.KmrOffice?.openTerm?.('atlas');}catch(err){}},60);});
    $('cmdOffice')?.addEventListener('click',()=>go('office'));
    $('cmdVolumeTrap')?.addEventListener('click',()=>go('volumeTrap'));
    $('cmdPlanner')?.addEventListener('click',()=>go('manual'));
    setInterval(()=>{if(visible())tick();},1000);
    setInterval(()=>{if(visible())render();},5000);
    render();
  }
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();}
  root.KmrCommand={render,_test:{model,uptime,paperDays,pulse,dayKey,feed}};
})(typeof window==='undefined'?globalThis:window);
