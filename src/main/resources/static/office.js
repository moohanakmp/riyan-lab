/* Office: a pixel-art room where every agent works at its own desk.
   Display only. It reads KmrAgents.reports() (real app state) and never changes a trade or a setting.
   Working agents type at their desks, idle agents walk to the lounge, agents that need attention raise a "!",
   offline agents leave their desk. Tap an agent for its terminal: status history and a question box. */
(function(root){
  'use strict';
  const T=8;// logical pixels per tile; the canvas is scaled up by a whole number so pixels stay sharp
  const SKIN=['#f1c27d','#e0ac69','#c68642','#8d5524','#ffdbac','#d19a66'];
  const HAIR=['#2b1d0e','#4a2f1b','#141414','#6b4226','#b55239','#3b2a20','#d9b26a'];
  const C={floorA:'#cbdcc1',floorB:'#c2d5b6',grid:'#b5caa9',wall:'#ece3cf',wallEdge:'#5b4a3a',base:'#cdbf9f',win:'#a9d8f5',winFrame:'#ffffff',
    wood:'#d9a55b',woodEdge:'#b27c3a',woodLeg:'#8a5a2b',mon:'#2d3440',chair:'#5b4b8a',chairDark:'#463a70',meet:'#c98f4e',meetChair:'#9b3d6b',
    leaf:'#3f8f3a',leaf2:'#57b04f',pot:'#b5651d',sofa:'#7a5fb0',sofaDark:'#5f4790',rug:'#e7d3a8',pants:'#2f3b52',shoe:'#1f2937',eye:'#1b1b1b'};
  const reduce=()=>{try{return root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;}catch(e){return false;}};
  const hash=s=>{let h=0;for(const ch of String(s))h=(h*31+ch.charCodeAt(0))>>>0;return h;};
  const shade=(hex,f)=>{const n=parseInt(hex.slice(1),16),c=[n>>16,n>>8&255,n&255].map(v=>Math.max(0,Math.min(255,Math.round(v*f))));return '#'+c.map(v=>v.toString(16).padStart(2,'0')).join('');};
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const short=s=>{const t=String(s||'').split(/(?<=\.)\s/)[0];return t.length>54?t.slice(0,52)+'…':t;};
  const STATE={ok:'working',busy:'working',warn:'needs attention',off:'away',idle:'idle'};

  let cv,ctx,bg,layer,box,layout=null,actors={},list=[],raf=0,lastTick=0,lastPoll=0,bubbleAt=0,bubbleId=null,selected=null,frame=0;
  const term={};// per-agent question/answer lines typed in the terminal

  function A(){return root.KmrAgents;}
  function visible(){const p=document.getElementById('tof');return !!p&&p.style.display!=='none'&&!document.hidden;}

  // ── Layout: wide room on desktop, tall room on phone. Desks in a grid below a meeting/lounge strip. ──
  function makeLayout(n,wide){
    const per=wide?6:3,W=wide?6:7,cols=wide?per*W+2:per*W+1,deskRows=Math.ceil(n/per),top=9,rows=top+deskRows*5+1;
    const slots=[];for(let i=0;i<n;i++){const r=Math.floor(i/per),c=i%per;const sx=(wide?1:.5)+c*W,sy=top+r*5,cx=(sx+W/2)*T;
      slots.push({sx,sy,cx,deskY:(sy+1)*T,seatY:Math.round((sy+3.6)*T),aisleY:Math.round((sy+4.6)*T),gapX:Math.round((sx+.5)*T)});}
    const meet=wide?{x:4,y:4,w:10}:{x:2,y:4,w:8},lounge=wide?{x:24,y:3}:{x:13,y:3};
    const spots=[];for(let i=0;i<meet.w;i+=2){spots.push([(meet.x+i+1)*T,(meet.y-.2)*T],[(meet.x+i+1)*T,(meet.y+3.4)*T]);}
    spots.push([(lounge.x+1)*T,(lounge.y+3.6)*T],[(lounge.x+3)*T,(lounge.y+3.6)*T],[(lounge.x+5)*T,(lounge.y+3.6)*T],[(cols-2.5)*T,(lounge.y+3)*T]);
    return {wide,cols,rows,w:cols*T,h:rows*T,slots,meet,lounge,spots,topY:(top-1.2)*T};
  }

  // ── Static room, drawn once per layout into an offscreen canvas ──
  function px(g,x,y,w,h,c){g.fillStyle=c;g.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));}
  function plant(g,x,y){px(g,x+1,y+6,6,5,C.pot);px(g,x,y+5,8,2,shade(C.pot,.85));px(g,x+1,y,6,6,C.leaf);px(g,x+2,y-2,4,3,C.leaf2);px(g,x,y+2,2,3,C.leaf2);px(g,x+6,y+1,2,3,C.leaf2);}
  function drawRoom(L){
    bg=document.createElement('canvas');bg.width=L.w;bg.height=L.h;const g=bg.getContext('2d');
    for(let y=0;y<L.rows;y++)for(let x=0;x<L.cols;x++)px(g,x*T,y*T,T,T,((x>>1)+(y>>1))%2?C.floorA:C.floorB);
    g.globalAlpha=.35;for(let x=0;x<=L.cols;x+=2)px(g,x*T,2*T,1,L.h,C.grid);for(let y=2;y<=L.rows;y+=2)px(g,0,y*T,L.w,1,C.grid);g.globalAlpha=1;
    // back wall with windows
    px(g,0,0,L.w,2*T,C.wall);px(g,0,0,L.w,2,C.wallEdge);px(g,0,2*T-3,L.w,3,C.base);
    for(let x=3;x<L.cols-3;x+=(L.wide?7:6)){px(g,x*T,3,3*T,T+2,C.winFrame);px(g,x*T+2,5,3*T-4,T-2,C.win);px(g,x*T+1.5*T,5,1,T-2,C.winFrame);}
    px(g,0,0,2,L.h,C.wallEdge);px(g,L.w-2,0,2,L.h,C.wallEdge);px(g,0,L.h-2,L.w,2,C.wallEdge);
    // meeting table with chairs
    const m=L.meet;px(g,(m.x-.5)*T,(m.y-1)*T,(m.w+1)*T,5*T,C.rug);
    for(let i=0;i<m.w;i+=2){px(g,(m.x+i+.5)*T,(m.y-.2)*T-3,T,T-2,C.meetChair);px(g,(m.x+i+.5)*T,(m.y+2.4)*T,T,T-2,C.meetChair);}
    px(g,m.x*T,(m.y+.6)*T,m.w*T,1.6*T,C.meet);px(g,m.x*T,(m.y+2.2)*T-2,m.w*T,2,shade(C.meet,.75));
    for(let i=1;i<m.w;i+=3)px(g,(m.x+i)*T,(m.y+1)*T,T,4,'#f5f5f5');
    // lounge: sofa, coffee table, water cooler, plants
    const l=L.lounge;px(g,l.x*T,l.y*T,7*T,T,C.sofaDark);px(g,l.x*T,(l.y+1)*T,7*T,1.4*T,C.sofa);px(g,l.x*T-3,l.y*T,3,2.4*T,C.sofaDark);px(g,(l.x+7)*T,l.y*T,3,2.4*T,C.sofaDark);
    px(g,(l.x+2)*T,(l.y+2.8)*T,3*T,4,C.wood);
    const wc=(L.cols-3)*T;px(g,wc,2.2*T,10,6,'#8fd3ff');px(g,wc-1,2.2*T+6,12,14,'#e8f4fb');px(g,wc+3,2.2*T+10,4,2,'#60a5fa');
    plant(g,4,2*T+2);plant(g,L.w-12,L.h-16);plant(g,4,L.h-16);if(L.wide)plant(g,(l.x-3)*T,2*T+2);
    // desks with monitors and keyboards (screens are drawn live)
    for(const s of L.slots){
      px(g,s.cx-2*T,s.deskY,4*T,1.6*T,C.wood);px(g,s.cx-2*T,s.deskY+1.6*T-2,4*T,2,C.woodEdge);
      px(g,s.cx-2*T+1,s.deskY+1.6*T,2,3,C.woodLeg);px(g,s.cx+2*T-3,s.deskY+1.6*T,2,3,C.woodLeg);
      px(g,s.cx-T-1,s.deskY-.7*T,2*T+2,1.3*T,C.mon);px(g,s.cx-2,s.deskY+.6*T,4,3,C.mon);
      px(g,s.cx-6,s.deskY+1.6*T-6,12,2,'#e5e7eb');px(g,s.cx+9,s.deskY+1.6*T-6,3,2,'#e5e7eb');
      px(g,s.cx-2*T+3,s.deskY+3,5,4,'#f8fafc');// paper stack
    }
  }

  // ── Characters ──
  function look(id){const h=hash(id);return {skin:SKIN[h%SKIN.length],hair:HAIR[(h>>4)%HAIR.length],long:(h>>8)%3===0};}
  function seatedSprite(g,a,x,y,t){// back view, at a desk facing the monitor; (x,y)=feet anchor
    const o=a.look,x0=x-4,y0=y-11,typing=(a.state==='ok'||a.state==='busy')&&!reduce(),b=typing&&(t%2)?1:0;
    px(g,x0+1,y0+b,6,5,o.hair);if(o.long)px(g,x0+1,y0+5+b,6,2,o.hair);
    px(g,x0,y0+2+b,1,2,o.skin);px(g,x0+7,y0+2+b,1,2,o.skin);
    px(g,x0,y0+6,8,5,a.hue);px(g,x0,y0+10,8,1,shade(a.hue,.7));
    const arm=typing?((t>>1)%2):0;px(g,x0-1,y0+5-arm,1,3,shade(a.hue,.8));px(g,x0+8,y0+4+arm,1,3,shade(a.hue,.8));
    px(g,x0-1,y0+4-arm,1,1,o.skin);px(g,x0+8,y0+3+arm,1,1,o.skin);
  }
  function standingSprite(g,a,x,y,t,moving){// front view; (x,y)=feet anchor
    const o=a.look,x0=Math.round(x)-4,y0=Math.round(y)-12,step=moving&&!reduce()?(t>>1)%2:0;
    px(g,x0+1,y0+12,6,1,'rgba(0,0,0,.18)');
    px(g,x0+1,y0,6,2,o.hair);px(g,x0+1,y0+2,6,3,o.skin);px(g,x0+1,y0+2,1,2,o.hair);px(g,x0+6,y0+2,1,2,o.hair);if(o.long){px(g,x0,y0+2,1,4,o.hair);px(g,x0+7,y0+2,1,4,o.hair);}
    px(g,x0+2,y0+3,1,1,C.eye);px(g,x0+5,y0+3,1,1,C.eye);
    px(g,x0+1,y0+5,6,4,a.hue);px(g,x0,y0+5,1,3,shade(a.hue,.8));px(g,x0+7,y0+5,1,3,shade(a.hue,.8));px(g,x0,y0+8,1,1,o.skin);px(g,x0+7,y0+8,1,1,o.skin);
    px(g,x0+2,y0+9,4,2,C.pants);
    if(step){px(g,x0+1,y0+11,2,1,C.shoe);px(g,x0+5,y0+10,2,1,C.shoe);}else{px(g,x0+2,y0+11,2,1,C.shoe);px(g,x0+4,y0+11,2,1,C.shoe);}
  }
  function chair(g,s){px(g,s.cx-5,s.seatY-4,10,5,C.chair);px(g,s.cx-5,s.seatY-4,10,1,shade(C.chair,1.25));px(g,s.cx-1,s.seatY+1,2,2,C.chairDark);}
  function screen(g,s,a,t){
    const x=s.cx-T+1,y=s.deskY-.7*T+1,w=2*T,h=1.3*T-2;
    if(!a||a.state==='off'){px(g,x,y,w,h,'#0b0f17');return;}
    if(a.state==='warn'){px(g,x,y,w,h,(t>>2)%2?'#7f1d1d':'#b91c1c');px(g,x+w/2-1,y+2,2,4,'#fee2e2');px(g,x+w/2-1,y+7,2,1,'#fee2e2');return;}
    if(a.state==='idle'||a.mode!=='seated'){px(g,x,y,w,h,'#111827');const d=(t>>1)%(w-2);px(g,x+1+d,y+h/2,2,1,shade(a.hue,.7));return;}
    px(g,x,y,w,h,'#0d1b2a');const off=reduce()?0:t%6;
    for(let i=0;i<4;i++){const ly=y+1+((i*2+off)%(h-1));px(g,x+1,ly,3+((i*5+t)%(w-5)),1,i%2?shade(a.hue,1.2):'#9ae6b4');}
  }
  function marker(g,a,x,y,t){
    if(a.state==='warn'){const yy=y-19-((t>>2)%2);px(g,x-2,yy-1,4,7,'#7f1d1d');px(g,x-1,yy,2,3,'#fecaca');px(g,x-1,yy+4,2,1,'#fecaca');}
    if(a.state==='busy'){for(let i=0;i<3;i++)px(g,x-4+i*3,y-17,2,2,(t>>1)%3===i?'#ffffff':'rgba(255,255,255,.45)');}
  }

  // ── Movement: seat → aisle → gap column → destination (and back), so walkers do not cross desks ──
  function pathTo(a,dest){
    const s=layout.slots[a.slot],pts=[],here={x:a.x,y:a.y};
    if(a.mode==='seated'||here.y>layout.topY){pts.push([here.x,s.aisleY],[s.gapX,s.aisleY],[s.gapX,layout.topY]);}
    if(dest==='seat'){pts.push([s.gapX,layout.topY],[s.gapX,s.aisleY],[s.cx,s.aisleY],[s.cx,s.seatY]);}
    else pts.push(dest);
    a.path=pts;a.mode='walking';
  }
  function want(a){return a.state==='off'?'away':a.state==='idle'?'wander':'seat';}
  function placeAt(a){
    const s=layout.slots[a.slot],w=want(a);a.path=[];
    if(w==='seat'){a.mode='seated';a.x=s.cx;a.y=s.seatY;}
    else{const sp=layout.spots[(hash(a.id)+a.slot)%layout.spots.length];a.mode=w==='away'?'away':'pause';a.x=sp[0];a.y=sp[1];a.wait=2000+Math.random()*4000;}
  }
  function step(a,dt){
    const w=want(a);
    if(reduce()){if(a.lastWant!==w)placeAt(a);a.lastWant=w;return;}
    if(w==='seat'&&a.mode!=='seated'&&a.mode!=='walking-seat'){if(a.mode==='away')placeAt(a);else{pathTo(a,'seat');a.mode='walking-seat';}}
    if(w==='wander'&&a.mode==='seated'){pathTo(a,layout.spots[Math.floor(Math.random()*layout.spots.length)]);}
    if(w==='away'&&a.mode!=='away'){a.mode='away';a.path=[];}
    if(w==='wander'&&a.mode==='away')placeAt(a);
    if(a.mode==='pause'){a.wait-=dt;if(a.wait<=0)pathTo(a,layout.spots[Math.floor(Math.random()*layout.spots.length)]);}
    if(a.mode==='walking'||a.mode==='walking-seat'){
      let dist=32*dt/1000;
      while(dist>0&&a.path.length){const [tx,ty]=a.path[0],dx=tx-a.x,dy=ty-a.y,d=Math.hypot(dx,dy);
        if(d<=dist){a.x=tx;a.y=ty;a.path.shift();dist-=d;}else{a.x+=dx/d*dist;a.y+=dy/d*dist;dist=0;}}
      if(!a.path.length){if(a.mode==='walking-seat'){a.mode='seated';}else{a.mode='pause';a.wait=2500+Math.random()*5000;}}
    }
  }

  // ── Frame ──
  function draw(t){
    if(!layout)return;ctx.setTransform(layout.scale,0,0,layout.scale,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(bg,0,0);
    const items=[];
    layout.slots.forEach((s,i)=>{const a=list[i]&&actors[list[i].id];screen(ctx,s,a,t);items.push({y:s.seatY+.5,f:()=>chair(ctx,s)});});
    for(const r of list){const a=actors[r.id];if(!a||a.mode==='away')continue;
      items.push({y:a.y,f:()=>{if(a.mode==='seated')seatedSprite(ctx,a,a.x,a.y,t);else standingSprite(ctx,a,a.x,a.y,t,a.mode.startsWith('walking'));}});
      items.push({y:9999,f:()=>marker(ctx,a,a.x,a.y,t)});}
    items.sort((p,q)=>p.y-q.y).forEach(i=>i.f());
    if(selected&&actors[selected]&&actors[selected].mode!=='away'){const a=actors[selected];ctx.strokeStyle='#fde047';ctx.lineWidth=1;ctx.strokeRect(Math.round(a.x)-6.5,Math.round(a.y)-14.5,13,17);}
    placeTags();
  }
  function placeTags(){
    for(const r of list){const a=actors[r.id],tag=a&&a.tag;if(!tag)continue;
      const away=a.mode==='away',s=layout.slots[a.slot],x=away?s.cx:a.x,y=away?s.seatY:a.y;
      tag.style.left=(x/layout.w*100)+'%';tag.style.top=((y+3)/layout.h*100)+'%';tag.classList.toggle('away',away);
      if(a.bubble){a.bubble.style.left=(x/layout.w*100)+'%';a.bubble.style.top=((y-15)/layout.h*100)+'%';a.bubble.hidden=away||!(bubbleId===r.id||r.state==='warn');}}
  }
  function loop(now){
    raf=0;if(!visible()){return;}
    if(now-lastTick>=100){const dt=Math.min(400,now-(lastTick||now));lastTick=now;frame++;
      for(const r of list){const a=actors[r.id];if(a)step(a,dt);}
      if(now-lastPoll>5000){lastPoll=now;poll();}
      if(now-bubbleAt>4200){bubbleAt=now;const talkers=list.filter(r=>r.state==='ok'||r.state==='busy'||r.state==='idle');
        const i=talkers.findIndex(r=>r.id===bubbleId);bubbleId=talkers.length?talkers[(i+1)%talkers.length].id:null;}
      draw(frame);}
    raf=requestAnimationFrame(loop);
  }
  function start(){if(!raf&&visible())raf=requestAnimationFrame(loop);}

  // ── Data ──
  function poll(){
    const K=A();if(!K)return;K.refresh?.().catch?.(()=>{});
    const next=K.reports();const ids=next.map(r=>r.id).join(',');
    const rebuild=!layout||ids!==list.map(r=>r.id).join(',')||layout.wide!==isWide();
    list=next;
    if(rebuild)build();else{for(const r of list){const a=actors[r.id];Object.assign(a,{state:r.state,line:r.line,role:r.role});if(a.bubble)a.bubble.textContent=short(r.line);}}
    renderRoster();renderSummary();if(selected)renderTerm();
  }
  function isWide(){return (box?.clientWidth||root.innerWidth)>=720;}
  function build(){
    layout=makeLayout(list.length,isWide());drawRoom(layout);
    const dpr=root.devicePixelRatio||1,avail=Math.max(200,(box.clientWidth||320))*dpr;
    layout.scale=Math.max(1,Math.floor(avail/layout.w));cv.width=layout.w*layout.scale;cv.height=layout.h*layout.scale;
    cv.style.aspectRatio=layout.w+' / '+layout.h;
    layer.innerHTML='';const old=actors;actors={};
    list.forEach((r,i)=>{const prev=old[r.id];
      const a=prev&&prev.slot===i?Object.assign(prev,{state:r.state,line:r.line}):{id:r.id,slot:i,look:look(r.id),hue:r.hue,state:r.state,line:r.line,path:[]};
      if(!prev||prev.slot!==i)placeAt(a);
      a.tag=document.createElement('button');a.tag.type='button';a.tag.className='of-tag';a.tag.style.setProperty('--h',r.hue);a.tag.textContent=r.name;a.tag.setAttribute('aria-label',r.name+', '+STATE[r.state]+'. Open terminal');
      a.tag.onclick=()=>openTerm(r.id);
      a.bubble=document.createElement('div');a.bubble.className='of-bubble';a.bubble.textContent=short(r.line);a.bubble.hidden=true;
      layer.append(a.tag,a.bubble);actors[r.id]=a;});
    draw(frame);
  }

  // ── Roster strip, summary, terminal ──
  function avatar(id,hue){
    const c=document.createElement('canvas');c.width=30;c.height=30;c.className='of-av';const g=c.getContext('2d');g.setTransform(3,0,0,3,0,0);
    px(g,0,0,10,10,shade(hue,.35));standingSprite(g,{look:look(id),hue},5,12,0,false);return c;
  }
  function renderRoster(){
    const el=document.getElementById('officeRoster');if(!el)return;
    const sig=list.map(r=>r.id+r.state).join('|');if(el.dataset.sig===sig)return;el.dataset.sig=sig;el.innerHTML='';
    for(const r of list){const b=document.createElement('button');b.type='button';b.className='of-card'+(r.id===selected?' on':'');b.style.setProperty('--h',r.hue);
      b.append(avatar(r.id,r.hue));const tx=document.createElement('span');tx.className='of-card-tx';
      tx.innerHTML='<b>'+esc(r.name)+'</b><small>'+esc(r.role)+'</small>';b.append(tx);
      const pill=document.createElement('span');pill.className='of-pill s-'+r.state;pill.textContent=STATE[r.state];b.append(pill);
      b.onclick=()=>openTerm(r.id);el.append(b);}
  }
  function renderSummary(){
    const el=document.getElementById('officeSummary');if(!el)return;
    const n=s=>list.filter(r=>s.includes(r.state)).length;
    el.textContent=n(['ok','busy'])+' working · '+n(['idle'])+' idle · '+n(['warn'])+' need attention · '+n(['off'])+' away';
  }
  const hhmm=t=>new Date(t).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  function openTerm(id){selected=id;const p=document.getElementById('officeTerm');if(!p)return;p.hidden=false;document.getElementById('officeRoster').dataset.sig='';renderRoster();renderTerm(true);setTimeout(()=>document.getElementById('officeTermAsk')?.focus({preventScroll:true}),50);}
  function closeTerm(){selected=null;const p=document.getElementById('officeTerm');if(p)p.hidden=true;const r=document.getElementById('officeRoster');if(r){r.dataset.sig='';renderRoster();}}
  function renderTerm(scroll){
    const r=list.find(x=>x.id===selected);if(!r){closeTerm();return;}
    const head=document.getElementById('officeTermHead'),body=document.getElementById('officeTermBody');
    head.style.setProperty('--h',r.hue);head.innerHTML='';head.append(avatar(r.id,r.hue));
    const t=document.createElement('div');t.innerHTML='<b>'+esc(r.name)+'</b><small>'+esc(r.role)+'</small>';head.append(t);
    const pill=document.createElement('span');pill.className='of-pill s-'+r.state;pill.textContent=STATE[r.state];head.append(pill);
    const hist=(A()?.log?.[r.id]||[]).map(h=>({t:h.t,k:'log',s:h.state,txt:h.line}));
    const lines=[...hist,...(term[r.id]||[])].sort((p,q)=>p.t-q.t).slice(-60);
    const atEnd=body.scrollHeight-body.scrollTop-body.clientHeight<24;
    body.innerHTML='<div class="ot-l ot-dim">'+esc(r.name.toLowerCase())+'@kmr ~ $ status --watch</div>'+lines.map(l=>
      l.k==='log'?'<div class="ot-l"><span class="ot-t">['+hhmm(l.t)+']</span> <span class="ot-s s-'+l.s+'">'+esc(STATE[l.s].toUpperCase())+'</span> '+esc(l.txt)+'</div>':
      l.k==='q'?'<div class="ot-l ot-q">'+esc(r.name.toLowerCase())+'@kmr ~ $ ask "'+esc(l.txt)+'"</div>':'<div class="ot-l ot-a">'+esc(l.txt)+'</div>').join('')+
      '<div class="ot-l ot-dim">▍</div>';
    if(scroll||atEnd)body.scrollTop=body.scrollHeight;
  }
  function askTerm(text){
    const K=A();if(!K||!selected)return;const id=selected,now=Date.now(),reply=K.answer(text);
    (term[id]=term[id]||[]).push({t:now,k:'q',txt:text},{t:now+1,k:'a',txt:reply});if(term[id].length>40)term[id].splice(0,term[id].length-40);
    renderTerm(true);if(K.prefs?.voice)K.speak(reply);
  }

  function wire(){
    cv=document.getElementById('officeCanvas');if(!cv||cv.dataset.wired)return;cv.dataset.wired='1';
    ctx=cv.getContext('2d');layer=document.getElementById('officeLayer');box=document.getElementById('officeRoom');
    cv.addEventListener('click',e=>{if(!layout)return;const b=cv.getBoundingClientRect(),x=(e.clientX-b.left)/b.width*layout.w,y=(e.clientY-b.top)/b.height*layout.h;
      let best=null,bd=14;for(const r of list){const a=actors[r.id];if(!a||a.mode==='away')continue;const d=Math.hypot(a.x-x,a.y-6-y);if(d<bd){bd=d;best=r.id;}}
      if(best)openTerm(best);});
    document.getElementById('officeTermClose')?.addEventListener('click',closeTerm);
    document.getElementById('officeTermForm')?.addEventListener('submit',e=>{e.preventDefault();const i=document.getElementById('officeTermAsk'),v=i.value.trim();if(v){i.value='';askTerm(v);}});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&selected&&visible())closeTerm();});
    let rs=0;root.addEventListener('resize',()=>{clearTimeout(rs);rs=setTimeout(()=>{if(visible()&&layout&&(layout.wide!==isWide()||Math.floor(Math.max(200,box.clientWidth)*(root.devicePixelRatio||1)/layout.w)!==layout.scale))build();},200);});
    document.addEventListener('visibilitychange',start);
  }
  function open(){wire();if(!cv)return;layout=null;lastPoll=0;poll();start();}
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();}
  root.KmrOffice={open,openTerm,closeTerm,_test:{makeLayout,look,short,hash}};
})(typeof window==='undefined'?globalThis:window);
