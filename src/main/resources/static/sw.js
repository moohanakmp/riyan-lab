const CACHE='riyan-lab-v32-lead-agent';
const ASSETS=['/','/index.html','/manifest.json'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    await Promise.all((await caches.keys()).filter(key=>key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
    // This release changes the browser/server entry protocol. Refresh open same-origin
    // documents once on activation so an old inline engine cannot load newer modules.
    // Accepted entries and pending snapshots are already durable/idempotent.
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    await Promise.all(clients.map(client=>client.navigate(client.url).catch(()=>null)));
  })());
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.pathname.startsWith('/api/') || url.origin!==self.location.origin)return;
  event.respondWith(
    fetch(event.request,event.request.mode==='navigate'?{cache:'no-store'}:{}).then(response=>{
      if(response.ok){
        const clone=response.clone();
        caches.open(CACHE).then(cache=>cache.put(event.request,clone));
      }
      return response;
    }).catch(()=>caches.match(event.request))
  );
});
self.addEventListener('message',event=>{
  if(event.data&&event.data.type==='NOTIFY'){
    self.registration.showNotification(event.data.title,{
      body:event.data.body,
      icon:'/icon-192.png',badge:'/icon-192.png',
      tag:event.data.tag||'kmr',
      renotify:true
    });
  }
});
// Server push for new paper signals. Pushes carry no data: fetch the alert text with the
// signed-in session. A notification is always shown (browsers require it for every push).
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let title='KMR: new paper signal',body='Open the app to see the signal.',tag='kmr-push';
    try{
      const r=await fetch('/api/v1/push/inbox',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
      if(r.ok){const list=await r.json();const a=Array.isArray(list)&&list[0];
        if(a){title=String(a.title||title).slice(0,120);body=String(a.body||body).slice(0,400)+(list.length>1?' (+'+(list.length-1)+' more)':'');tag='kmr-alert-'+a.id;}}
      else if(r.status===401)body='Sign in to KMR to see the new signal.';
    }catch(e){}
    await self.registration.showNotification(title,{body,icon:'/icon-192.png',badge:'/icon-192.png',tag,renotify:true,data:{url:'/'}});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const open=await clients.matchAll({type:'window',includeUncontrolled:true});
    const own=open.find(c=>new URL(c.url).origin===self.location.origin);
    if(own&&'focus' in own)return own.focus();
    return clients.openWindow('/');
  })());
});
