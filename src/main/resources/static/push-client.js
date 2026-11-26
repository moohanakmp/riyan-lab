/* Device alerts: subscribes this phone or laptop to server Web Push so new paper signals from the
   server scan reach it while the app is closed. Only alert settings are sent; nothing here touches a
   trade, a strategy setting or the broker. */
(function(root){
  'use strict';
  const $=id=>document.getElementById(id);
  const user=()=>typeof currentUser!=='undefined'?currentUser:null;
  const api=(path,opts)=>typeof riyanApi==='function'?riyanApi(path,opts):Promise.reject(Error('Not signed in'));
  const note=t=>{const n=$('pushNote');if(n)n.textContent=t;};
  const supported=()=>'serviceWorker' in navigator&&'PushManager' in root&&'Notification' in root;
  const isIos=()=>/iPhone|iPad|iPod/.test(navigator.userAgent||'');
  const standalone=()=>root.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone===true;
  function keyBytes(b64){const pad='='.repeat((4-b64.length%4)%4),raw=atob((b64+pad).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
  function sameKey(sub,key){try{const a=new Uint8Array(sub.options.applicationServerKey),b=keyBytes(key);return a.length===b.length&&a.every((v,i)=>v===b[i]);}catch(e){return true;}}
  function device(){const ua=navigator.userAgent||'';const os=/Android/.test(ua)?'Android':isIos()?'iPhone/iPad':/Windows/.test(ua)?'Windows':/Mac/.test(ua)?'Mac':/Linux/.test(ua)?'Linux':'Device';
    const br=/Edg\//.test(ua)?'Edge':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'Browser';return os+' '+br;}
  // ready never settles when the service worker failed to install: give up after 8 s with a clear message.
  async function reg(){return Promise.race([navigator.serviceWorker.ready,new Promise((_,no)=>setTimeout(()=>no(Error('the app\'s service worker is not running; reload the page')),8000))]);}
  function buttons(on){const a=$('pushOnBtn'),t=$('pushTestBtn'),o=$('pushOffBtn');if(!a)return;a.hidden=on;t.hidden=!on;o.hidden=!on;}
  async function save(sub){await api('/api/v1/push/subscribe',{method:'POST',body:JSON.stringify({endpoint:sub.endpoint,device:device()})});}
  async function sync(){
    const u=user();if(!$('pushOnBtn'))return;
    if(!u||!['admin','user'].includes(u.role)){buttons(false);$('pushOnBtn').hidden=true;note('Device alerts need a user account. Guests can still see signals in the app.');return;}
    if(!supported()){$('pushOnBtn').hidden=true;
      note(isIos()&&!standalone()?'On iPhone or iPad: tap Share, then Add to Home Screen, open KMR from the Home Screen and come back here to turn on alerts. Telegram alerts work on any phone.':'This browser cannot receive push alerts. Telegram alerts (Tools → Settings) work instead.');return;}
    try{
      const r=await reg(),sub=await r.pushManager.getSubscription();
      if(sub&&Notification.permission==='granted'){
        const {publicKey}=await api('/api/v1/push/key');
        if(!sameKey(sub,publicKey)){await sub.unsubscribe();buttons(false);note('Alerts were reset on the server. Tap the button to turn them on again.');return;}
        await save(sub);buttons(true);
        note('Alerts are on for this device. The server tells it about new paper signals even when the app is closed (while the server is awake).');
      }else{buttons(false);note(Notification.permission==='denied'?'Notifications are blocked for this site. Allow them in the browser or phone settings, then reload.':'Turn on alerts to be told about new paper signals when the app is closed.');}
    }catch(e){note('Alert status unavailable: '+String(e?.message||e).slice(0,80));}
  }
  async function on(){
    try{
      const perm=await Notification.requestPermission();
      if(perm!=='granted'){note('Notifications were not allowed, so alerts stay off.');return;}
      const {publicKey}=await api('/api/v1/push/key');const r=await reg();
      let sub=await r.pushManager.getSubscription();if(sub&&!sameKey(sub,publicKey)){await sub.unsubscribe();sub=null;}
      sub=sub||await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(publicKey)});
      await save(sub);buttons(true);note('Alerts are on. Tap "Send a test alert" to check this device.');
    }catch(e){note('Could not turn on alerts: '+String(e?.message||e).slice(0,100));}
  }
  async function off(){
    try{const r=await reg(),sub=await r.pushManager.getSubscription();
      if(sub){await api('/api/v1/push/unsubscribe',{method:'POST',body:JSON.stringify({endpoint:sub.endpoint})}).catch(()=>{});await sub.unsubscribe();}
      buttons(false);note('Alerts are off for this device.');
    }catch(e){note('Could not turn off alerts: '+String(e?.message||e).slice(0,100));}
  }
  async function test(){
    try{const r=await api('/api/v1/push/test',{method:'POST'});note(r.sent?'Test alert sent. It should appear in a few seconds.':'The push service did not accept the test. Try turning alerts off and on again.');}
    catch(e){note('Test failed: '+String(e?.message||e).slice(0,100));}
  }
  function wire(){
    if(!$('pushOnBtn'))return;
    $('pushOnBtn').addEventListener('click',on);$('pushOffBtn').addEventListener('click',off);$('pushTestBtn').addEventListener('click',test);
    // Sign-in can finish after this deferred file loads: check again until a user is known.
    let tries=0;const wait=setInterval(()=>{if(user()||++tries>60){clearInterval(wait);sync();}},1000);
    if(user()){clearInterval(wait);sync();}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
  root.KmrPush={sync,_test:{keyBytes,device}};
})(window);
