'use strict';
var quoteAt={};
var paperEngine={id:crypto.randomUUID(),until:0,leaseUntil:0,busy:false,lastCheck:0,reason:'Connecting to paper engine'};
function freshQuote(sym){return PaperMath.positive(prices[sym])&&Date.now()-(quoteAt[sym]||0)<30000&&Date.now()>=(quoteAt[sym]||0);}
function paperReady(){return !!currentUser&&currentUser.role!=='guest'&&Date.now()<paperEngine.until;}
async function paperHeartbeat(){
  if(!currentUser||currentUser.role==='guest'||paperEngine.busy||Date.now()-paperEngine.lastCheck<10000)return;
  paperEngine.busy=true;paperEngine.lastCheck=Date.now();
  try{
    const user=currentUser.username,wasReady=paperReady();
    const result=await riyanApi('/api/v1/paper/lease',{method:'POST'});
    if(currentUser?.username!==user)return;
    if(!result.owned){paperEngine.until=0;paperEngine.leaseUntil=0;paperEngine.reason='Another browser owns the paper engine';return;}
    paperEngine.leaseUntil=Date.now()+30000;
    if(!wasReady){
      // Flush this user's durable updates before authoritative restoration.
      const sync=await riyanProcessQueue();
      if(!sync||sync.error||paperPendingTrades(user))throw Error('Pending or rejected records need synchronization');
      if(!await riyanRestore())throw Error('Trade history unavailable');
      if(!await basketDbRestore())throw Error('Basket restoration unavailable');
    }
    paperEngine.until=Date.now()+20000;
    paperEngine.reason='Paper engine active — keep this browser open';
  }catch(e){paperEngine.until=0;paperEngine.reason='Paper engine paused: '+e.message;}
  finally{paperEngine.busy=false;}
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
    paperEngine.reason='Entry paused: '+e.message+' — reconciling server ledger';
    showToast(paperEngine.reason,'var(--acc)');return false;
  }
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
