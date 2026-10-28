const CACHE='riyan-lab-v26-active-basket2';
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
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
