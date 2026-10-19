'use strict';
var quoteAt={};
var paperEngine={id:crypto.randomUUID(),user:null,until:0,leaseUntil:0,busy:false,lastCheck:0,reason:'Connecting to paper engine'};
function freshQuote(sym){return PaperMath.positive(prices[sym])&&Date.now()-(quoteAt[sym]||0)<30000&&Date.now()>=(quoteAt[sym]||0);}
function paperReady(){return !!currentUser&&currentUser.role!=='guest'&&paperEngine.user===currentUser.username&&Date.now()<paperEngine.until;}
// Lease renewal is independent of slow queue/ledger restoration.
async function paperRenewLease(){
  const user=currentUser?.username;
  if(!user||currentUser.role==='guest')return false;
  if(paperEngine.user!==user){paperEngine.until=0;paperEngine.leaseUntil=0;paperEngine.lastLeaseAttempt=0;}
  if(paperEngine.leaseBusy)return paperEngine.user===user&&Date.now()<paperEngine.leaseUntil;
  if(Date.now()-(paperEngine.lastLeaseAttempt||0)<10000&&Date.now()<paperEngine.leaseUntil)return true;
  paperEngine.leaseBusy=true;paperEngine.lastLeaseAttempt=Date.now();
  try{
    const result=await riyanApi('/api/v1/paper/lease',{method:'POST'});
    if(currentUser?.username!==user)return false;
    if(!result.owned){paperEngine.until=0;paperEngine.leaseUntil=0;paperEngine.reason='Another engine owns this account';return false;}
    paperEngine.user=user;paperEngine.leaseUntil=Date.now()+30000;return true;
  }finally{paperEngine.leaseBusy=false;}
}
async function paperHeartbeat(){
  if(!currentUser||currentUser.role==='guest')return;
  try{if(!await paperRenewLease())return;}
  catch(e){if(Date.now()>=paperEngine.leaseUntil){paperEngine.until=0;paperEngine.reason='Paper engine paused: '+e.message;}return;}
  if(paperEngine.busy||Date.now()-paperEngine.lastCheck<10000)return;
  paperEngine.busy=true;paperEngine.lastCheck=Date.now();
  const user=currentUser.username,wasReady=paperReady();
  try{
    if(!wasReady){
      paperEngine.reason='Synchronizing paper ledger';
      if(typeof riyanRepairManualPlans==='function')riyanRepairManualPlans(user);
      if(paperPendingTrades(user)){
        const sync=await riyanProcessQueue(true);
        if(!sync||sync.error||paperPendingTrades(user))throw Error(paperSyncReason(user));
      }
      paperLedgerCache=null;
      if(!await riyanRestore())throw Error('Trade history unavailable');
      if(!await basketDbRestore())throw Error('Basket restoration unavailable');
    }
    if(currentUser?.username!==user||Date.now()>=paperEngine.leaseUntil)throw Error('Ownership changed while restoring');
    paperEngine.until=Math.min(Date.now()+20000,paperEngine.leaseUntil);
    paperEngine.reason='Paper engine active';
  }catch(e){paperEngine.until=0;paperEngine.reason='Paper engine paused: '+e.message;}
  finally{paperEngine.busy=false;}
}
var paperLedgerCache=null;
async function paperReadLedger(){
  const user=currentUser?.username;
  if(!user||currentUser.role==='guest')throw Error('Authenticated ledger required');
  if(paperLedgerCache?.user===user&&Date.now()-paperLedgerCache.at<5000)return paperLedgerCache.promise;
  const entry={user,at:Date.now(),promise:null};
  entry.promise=(async()=>{
    const grouped={};
    for(let offset=0;;offset+=1000){
      const rows=await riyanApi('/api/v1/paper/ledger?limit=1000&offset='+offset);
      if(currentUser?.username!==user||!Array.isArray(rows))throw Error('Ledger owner changed or response invalid');
      for(const row of rows)(grouped[row.record_type]||(grouped[row.record_type]=[])).push(row);
      if(rows.length<1000){entry.at=Date.now();return grouped;}
    }
  })().catch(e=>{if(paperLedgerCache===entry)paperLedgerCache=null;throw e;});
  paperLedgerCache=entry;return entry.promise;
}
async function paperSaveEntry(type,id,record){
  if(!paperReady())return false;
  const user=currentUser.username;
  try{
    const safe=await riyanSafeRecordId(type,id);
    const data=safe===String(id)?record:{...record,originalSourceId:String(id)};
    await riyanApi('/api/v1/records/'+type+'/'+safe,{method:'PUT',body:JSON.stringify(data)});
    // Do not attach an accepted response to a different logged-in account.
    if(currentUser?.username!==user)return false;
    return true;
  }catch(e){
    // An uncertain response may already be committed. Reconcile before another entry.
    paperEngine.until=0;
    paperEngine.reason='Entry paused: '+(e.detail||e.message)+' — reconciling server ledger';
    showToast(paperEngine.reason,'var(--acc)');return false;
  }
}

function paperSyncReason(user){
  try{
    const trade=r=>['auto-signals','manual-signals','low-profit','basket-positions','basket-sessions'].includes(r.type);
    const pending=Object.values(JSON.parse(localStorage.getItem('riyan_pending_'+user)||'{}')).filter(trade);
    const failed=Object.values(JSON.parse(localStorage.getItem('riyan_failed_'+user)||'{}')).filter(trade);
    return failed.length?failed.length+' rejected paper records require review in DB Sync':pending.length+' paper records awaiting synchronization; automatic retry active';
  }catch(e){return 'Local synchronization records could not be read';}
}
function paperPendingTrades(user){
  try{return ['riyan_pending_','riyan_failed_'].some(prefix=>Object.values(JSON.parse(localStorage.getItem(prefix+user)||'{}')).some(r=>['auto-signals','manual-signals','low-profit','basket-positions','basket-sessions'].includes(r.type)));}
  catch(e){return true;}
}
async function riyanReadAll(type){
  const all=[];
  for(let offset=0;;offset+=1000){
    const rows=await riyanApi('/api/v1/records/'+type+'?limit=1000&offset='+offset);
    if(!Array.isArray(rows))throw Error('Invalid ledger response');
    all.push(...rows);if(rows.length<1000)return all;
  }
}

async function paperReconcileConflict(item,user){
  if(!['auto-signals','manual-signals','low-profit','basket-positions','basket-sessions'].includes(item.type))return false;
  try{
    const id=await riyanSafeRecordId(item.type,item.id);
    const row=await riyanApi('/api/v1/records/'+item.type+'/'+id);
    const remote=typeof row.payload==='string'?JSON.parse(row.payload):row.payload,local=JSON.parse(item.value);
    const oldState=local.outcome||local.status,newState=remote.outcome||remote.status;
    if((newState&&newState!=='OPEN'&&oldState==='OPEN')||(remote.updatedAt||0)>(local.updatedAt||0)){
      const key='riyan_conflicts_'+user,log=JSON.parse(localStorage.getItem(key)||'{}');
      log[item.type+'|'+item.id]={...item,remote,at:Date.now(),resolution:'Server state retained'};
      localStorage.setItem(key,JSON.stringify(log));return true;
    }
  }catch(e){}return false;
}
