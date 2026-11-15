// Broker tab (admin only): links the admin's MT5 account through the bridge EA and shows every
// mirrored order with its broker evidence. The server enforces admin role, CSRF and all limits;
// this file is presentation only.
(function(){
  let brokerTimer=null,brokerToken='',brokerSelected=null,brokerBusy=false;
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>v==null||v===''?'—':Number(v).toLocaleString('en-IN',{maximumFractionDigits:5});
  const when=v=>v?new Date(v).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
  const stateColor={FILLED:'var(--grn)',DONE:'var(--grn)',CLOSED:'var(--acc2,#4fc3f7)',QUEUED:'var(--acc,#f6c90e)',DISPATCHED:'var(--acc,#f6c90e)',
    DRY_RUN:'var(--dim)',BLOCKED:'var(--red)',REJECTED:'var(--red)',UNKNOWN:'var(--red)',EXPIRED:'var(--dim)',CANCELLED:'var(--dim)'};

  async function api(path,opts={}){
    const headers={'Accept':'application/json'};
    if(opts.body)headers['Content-Type']='application/json';
    if(opts.method&&opts.method!=='GET')headers['X-CSRF-Token']=typeof riyanCsrf==='undefined'?'':riyanCsrf;
    const r=await fetch(path,{...opts,headers,credentials:'same-origin',cache:'no-store'});
    let body=null;try{body=await r.json();}catch(e){}
    if(!r.ok)throw Error((body&&body.reason)||('HTTP '+r.status));
    return body;
  }
  const toast=(m,c)=>{if(typeof showToast==='function')showToast(esc(m),c);};
  const isAdmin=()=>typeof currentUser!=='undefined'&&currentUser&&currentUser.role==='admin';
  const visible=()=>{const el=document.getElementById('tbk');return el&&el.style.display!=='none';};

  function chip(text,color){return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;border:1px solid ${color};color:${color};font-size:10.5px;font-weight:700">${esc(text)}</span>`;}
  function row(label,sub,control){return `<div class="perm-row"><div><div class="perm-label">${label}</div>${sub?`<div class="perm-sub">${sub}</div>`:''}</div>${control}</div>`;}
  function toggle(id,on){return `<label class="toggle-sw"><input type="checkbox" id="${id}" ${on?'checked':''}><span class="toggle-slider"></span></label>`;}
  function input(id,val,type='text',extra=''){return `<input id="${id}" type="${type}" value="${esc(val)}" ${extra} style="width:130px;background:var(--sur);color:var(--txt);border:1px solid var(--bdr);border-radius:8px;padding:6px 8px;font-size:12px">`;}

  function render(view,orders){
    const panel=document.getElementById('brokerPanel');if(!panel)return;
    const a=view.account||{},info=a.connector_info?JSON.parse(a.connector_info):{},map=a.symbol_map?JSON.parse(a.symbol_map):{};
    const online=!!a.connector_online,mode=a.mode||'DRY_RUN';
    const acctType=(info.mode||'').toUpperCase();
    let html='';
    // Status
    html+=`<div class="ic"><div class="it">🔌 OctaFX MT5 link</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        ${chip(online?'EA online':'EA offline',online?'var(--grn)':'var(--red)')}
        ${chip(mode==='EXECUTE'?'EXECUTE':'DRY-RUN',mode==='EXECUTE'?'var(--acc,#f6c90e)':'var(--dim)')}
        ${acctType?chip(acctType==='REAL'?'REAL MONEY':acctType,acctType==='REAL'?'var(--red)':'var(--grn)'):''}
        ${a.kill_switch?chip('KILL SWITCH ON','var(--red)'):''}
        ${a.enabled?'':chip('Mirroring off','var(--dim)')}
      </div>
      <div class="ib" style="line-height:1.7">
        Terminal: <b>${esc(info.login||'—')}</b> on <b>${esc(info.server||'—')}</b> · ${esc(info.company||'')}<br>
        Balance ${num(info.balance)} · Equity ${num(info.equity)} ${esc(info.currency||'')} · EA open positions ${num(info.openPositions)} · floating ${num(info.floatingUsd)}<br>
        Last seen ${when(a.connector_last_seen)} · Today closed P&amp;L ${num(view.todayClosedUsd)} USD · Orders today ${num(view.ordersToday)}
      </div>
      <button class="login-btn" style="margin-top:10px;background:${a.kill_switch?'var(--grn)':'var(--red)'}" onclick="brokerKill(${!a.kill_switch})">${a.kill_switch?'Release kill switch':'⛔ Kill switch: stop new entries'}</button>
      <button class="login-btn" style="margin-top:8px;background:var(--sur);color:var(--txt);border:1px solid var(--bdr);box-shadow:none" onclick="brokerPing()">Test link (account + all 3 symbols)</button>
    </div>`;
    // Settings
    html+=`<div class="ic"><div class="it">⚙️ Account &amp; limits</div>
      <div class="ib" style="margin-bottom:8px">Mirrors new app entries to the linked account. DRY-RUN records every intended order without sending it. Low Profit always stays paper-only.</div>
      ${row('MT5 login','Numeric account number shown in MT5',input('bkLogin',a.account_login||'','text','inputmode="numeric" autocomplete="off"'))}
      ${row('Server','e.g. OctaFX-Demo',input('bkServer',a.account_server||''))}
      ${row('Mode','EXECUTE sends orders to the EA',`<select id="bkMode" style="background:var(--sur);color:var(--txt);border:1px solid var(--bdr);border-radius:8px;padding:6px"><option value="DRY_RUN" ${mode==='DRY_RUN'?'selected':''}>Dry-run</option><option value="EXECUTE" ${mode==='EXECUTE'?'selected':''}>Execute</option></select>`)}
      ${row('Mirroring enabled','',toggle('bkEnabled',a.enabled))}
      ${row('Mirror Auto signals','',toggle('bkAuto',a.mirror_auto!==false))}
      ${row('Mirror Manual signals','',toggle('bkManual',!!a.mirror_manual))}
      ${row('Max lot per order','Capped at 1.00',input('bkMaxLot',a.max_lot??0.01,'number','step="0.01" min="0.01" max="1"'))}
      ${row('Daily loss limit (USD)','Closed + floating, IST day',input('bkLoss',a.max_daily_loss_usd??20,'number','step="1" min="1"'))}
      ${row('Max open positions','',input('bkOpen',a.max_open_positions??2,'number','min="1" max="20"'))}
      ${row('Max orders per day','',input('bkDay',a.max_orders_per_day??10,'number','min="1" max="200"'))}
      ${row('Max signal age (s)','Older queued entries expire, never chased',input('bkAge',a.max_signal_age_seconds??90,'number','min="10" max="3600"'))}
      ${row('Max slippage (%)','EA refuses if price moved further',input('bkSlip',a.max_slippage_pct??0.15,'number','step="0.01" min="0.01" max="5"'))}
      ${row('Allowed symbols','',input('bkSyms',a.allowed_symbols||'XAUUSD,XAGUSD,BTCUSD'))}
      ${['XAUUSD','XAGUSD','BTCUSD'].map(s=>row(s+' broker symbol','',input('bkMap'+s,map[s]||s))).join('')}
      <button class="login-btn" style="margin-top:10px" onclick="brokerSave()">Save settings</button>
    </div>`;
    // Token
    html+=`<div class="ic"><div class="it">🔑 Connector token</div>
      <div class="ib">Paste this token into the RiyanLabBridge EA inputs. Only a hash is stored; generating a new one disconnects the old EA. Your MT5 password is never entered here.</div>
      <div class="ib" style="margin-top:6px">Token ${a.token_set?'created '+when(a.connector_token_created_at):'not created yet'}</div>
      ${brokerToken?`<div style="margin-top:8px;padding:8px;border:1px dashed var(--acc,#f6c90e);border-radius:8px;word-break:break-all;font-family:monospace;font-size:11.5px">${esc(brokerToken)}</div>
        <div class="ib" style="color:var(--red)">Copy it now. It will not be shown again.</div>
        <button class="login-btn" style="margin-top:6px;background:var(--sur);color:var(--txt);border:1px solid var(--bdr);box-shadow:none" onclick="brokerCopy()">Copy token</button>`:''}
      <button class="login-btn" style="margin-top:8px;background:var(--sur);color:var(--txt);border:1px solid var(--bdr);box-shadow:none" onclick="brokerRotate()">${a.token_set?'Generate new token':'Generate token'}</button>
      <div class="ib" style="margin-top:8px">Setup guide: <a href="https://github.com/moohanakmp/riyan-lab/blob/staging/backend-auth-20261016/docs/broker-bridge.md" target="_blank" rel="noopener" style="color:var(--acc2,#4fc3f7)">docs/broker-bridge.md</a></div>
    </div>`;
    // Live
    html+=`<div class="ic"><div class="it">🛑 Real-money trading</div>
      <div class="ib">Real accounts are refused unless the server has <code>RIYAN_BROKER_LIVE_ENABLED=true</code> <b>and</b> you confirm here by typing the login. Server flag: <b>${view.liveEnabledByServer?'ON':'OFF'}</b> · Confirmed: <b>${a.live_confirmed_at?'yes, '+esc(a.live_confirmed_by)+' '+when(a.live_confirmed_at):'no'}</b></div>
      ${a.live_confirmed_at?`<button class="login-btn" style="margin-top:8px;background:var(--red)" onclick="brokerLive(false)">Revoke live confirmation</button>`
        :view.liveEnabledByServer?`${row('Type the MT5 login to confirm','',input('bkLiveLogin','','text','autocomplete="off"'))}<button class="login-btn" style="margin-top:8px;background:var(--red)" onclick="brokerLive(true)">Confirm real-money mirroring</button>`:''}
    </div>`;
    // Orders
    html+=`<div class="ic"><div class="it">📒 Mirrored orders</div><div class="ib" style="margin-bottom:6px">Every entry and broker response is stored in the database with a full event trail. Tap an order for its history.</div>`;
    if(!orders.length)html+=`<div class="ib">No mirrored orders yet.</div>`;
    for(const o of orders){
      const pl=o.profit_usd!=null?` · P&amp;L <b style="color:${Number(o.profit_usd)>=0?'var(--grn)':'var(--red)'}">${num(o.profit_usd)}</b>`:'';
      html+=`<div onclick="brokerEvents(${Number(o.id)})" style="cursor:pointer;padding:9px 4px;border-bottom:1px solid var(--bdr)">
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:center"><div style="font-size:12.5px;font-weight:700">${esc(o.action)} ${esc(o.side||'')} ${esc(o.symbol||'')} ${o.volume!=null?num(o.volume):''}</div>${chip(o.state,stateColor[o.state]||'var(--dim)')}</div>
        <div class="perm-sub">${esc(o.client_order_id)} · ${when(o.created_at)}${o.signal_type?' · '+esc(o.signal_type)+' #'+esc(o.signal_source_id):''}</div>
        <div class="perm-sub">Entry ${num(o.entry_ref)} · SL ${num(o.stop_loss)} · TP ${num(o.take_profit)}${o.broker_ticket?' · Ticket '+esc(o.broker_ticket):''}${o.fill_price!=null?' · Fill '+num(o.fill_price):''}${pl}</div>
        ${o.state_reason?`<div class="perm-sub">${esc(o.state_reason)}${o.broker_message?' · '+esc(o.broker_message):''}</div>`:''}
        <div id="bkEv${Number(o.id)}"></div>
      </div>`;
    }
    html+=`</div>`;
    panel.innerHTML=html;
    if(brokerSelected)loadEvents(brokerSelected);
  }

  async function loadEvents(id){
    const box=document.getElementById('bkEv'+id);if(!box)return;
    try{
      const evs=await api('/api/v1/broker/events?orderId='+encodeURIComponent(id));
      box.innerHTML='<div style="margin-top:6px;padding:6px;border-left:2px solid var(--bdr)">'+evs.map(e=>`<div class="perm-sub"><b>${esc(e.event)}</b> · ${esc(e.actor)} · ${when(e.created_at)}<br><span style="font-family:monospace;font-size:10.5px;word-break:break-all">${esc(e.details)}</span></div>`).join('')+'</div>';
    }catch(e){box.innerHTML=`<div class="perm-sub">${esc(e.message)}</div>`;}
  }

  async function refresh(){
    if(!isAdmin()||brokerBusy)return;
    try{
      const [view,orders]=await Promise.all([api('/api/v1/broker/account'),api('/api/v1/broker/orders?limit=50')]);
      const active=document.activeElement&&document.activeElement.closest&&document.activeElement.closest('#brokerPanel');
      if(active&&/INPUT|SELECT/.test(document.activeElement.tagName))return; // don't wipe what the admin is typing
      render(view,orders||[]);
    }catch(e){const p=document.getElementById('brokerPanel');if(p)p.innerHTML=`<div class="ic"><div class="it">🔌 Broker link</div><div class="ib">${esc(e.message)}</div></div>`;}
  }

  async function act(fn,ok){
    if(brokerBusy)return;brokerBusy=true;
    try{await fn();if(ok)toast(ok,'var(--grn)');}catch(e){toast(e.message,'var(--red)');}
    finally{brokerBusy=false;refresh();}
  }
  const val=id=>{const el=document.getElementById(id);return el?el.value:'';};
  const chk=id=>{const el=document.getElementById(id);return !!(el&&el.checked);};

  window.renderBrokerPanel=function(){
    if(!isAdmin())return;
    refresh();
    clearInterval(brokerTimer);
    brokerTimer=setInterval(()=>{if(visible())refresh();else{clearInterval(brokerTimer);brokerTimer=null;}},10000);
  };
  window.brokerSave=()=>act(()=>api('/api/v1/broker/account',{method:'PUT',body:JSON.stringify({
    accountLogin:val('bkLogin').trim(),accountServer:val('bkServer').trim(),mode:val('bkMode'),enabled:chk('bkEnabled'),
    mirrorAuto:chk('bkAuto'),mirrorManual:chk('bkManual'),maxLot:val('bkMaxLot'),maxDailyLossUsd:val('bkLoss'),
    maxOpenPositions:Number(val('bkOpen')),maxOrdersPerDay:Number(val('bkDay')),maxSignalAgeSeconds:Number(val('bkAge')),
    maxSlippagePct:val('bkSlip'),allowedSymbols:val('bkSyms'),
    symbolMap:{XAUUSD:val('bkMapXAUUSD').trim()||'XAUUSD',XAGUSD:val('bkMapXAGUSD').trim()||'XAGUSD',BTCUSD:val('bkMapBTCUSD').trim()||'BTCUSD'}
  })}),'Broker settings saved');
  window.brokerRotate=()=>{
    if(!confirmInline('Generate a new connector token? The current EA will stop until you paste the new one.'))return;
    act(async()=>{const r=await api('/api/v1/broker/account/token',{method:'POST'});brokerToken=r.token;},'New token created');
  };
  window.brokerCopy=()=>{try{navigator.clipboard.writeText(brokerToken);toast('Token copied','var(--grn)');}catch(e){toast('Copy failed; select the text manually','var(--red)');}};
  window.brokerKill=on=>act(()=>api('/api/v1/broker/kill-switch',{method:'POST',body:JSON.stringify({on})}),on?'Kill switch ON':'Kill switch released');
  window.brokerPing=()=>act(()=>api('/api/v1/broker/ping',{method:'POST'}),'Link test queued; the EA checks the account and each symbol on its next poll');
  window.brokerLive=confirm=>act(()=>api('/api/v1/broker/live-confirmation',{method:'POST',body:JSON.stringify({confirm,accountLogin:val('bkLiveLogin')})}),
    confirm?'Real-money mirroring confirmed':'Live confirmation revoked');
  window.brokerEvents=id=>{brokerSelected=brokerSelected===id?null:id;const box=document.getElementById('bkEv'+id);if(box&&!brokerSelected){box.innerHTML='';return;}loadEvents(id);};
  // Two-tap confirmation without a blocking browser dialog.
  let pendingConfirm=0;
  function confirmInline(msg){if(Date.now()-pendingConfirm<6000){pendingConfirm=0;return true;}pendingConfirm=Date.now();toast(msg+' Tap again to confirm.','var(--acc,#f6c90e)');return false;}
})();
