const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const context={};vm.createContext(context);
vm.runInContext(fs.readFileSync('src/main/resources/static/orbital-ui.js','utf8'),context);
const model=context.OrbitalUI.qualityModel;
const feed={last:{t:1},stale:false,reference:false,message:'Completed provider candles'};
const scan={score:82,tier:'MED',gatesOk:true,gates:[{key:'htf',ok:true},{key:'adx',ok:false},{key:'rsi',ok:true},{key:'trigger',ok:false},{key:'vol',ok:true},{key:'spike',ok:true},{key:'value',ok:false},{key:'struct',ok:true}]};
for(const bad of [{...feed,last:null},{...feed,stale:true},{...feed,reference:true}])assert.equal(model(bad,scan,true).score,null);
assert.equal(model(feed,scan,false).score,null);
assert.equal(model(feed,{...scan,score:NaN},true).score,null);
assert.equal(model(feed,{...scan,gates:[]},true).score,null);
assert.equal(model(feed,null,true).score,null);
const good=model(feed,scan,true);assert.equal(good.score,82);assert.equal(good.groups[0].passed,1);assert.equal(good.groups[0].total,2);
assert.equal(model(feed,{...scan,tier:null,gatesOk:false},true).state,'WAIT / WATCH');
assert.equal(model(feed,{...scan,score:105},true).score,100);
const src=fs.readFileSync('src/main/resources/static/orbital-ui.js','utf8');
assert.ok(!/\b(?:fetch|localStorage|sessionStorage|dbPut|riyanApi)\s*[.(]/.test(src),'Presentation adapter must not fetch or persist');
const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(new Set(ids).size,ids.length,'Duplicate UI IDs');
for(const sym of ['XAUUSD','XAGUSD','BTCUSD'])for(const part of ['card','price','status','change'])assert.ok(ids.includes('orbit-'+part+'-'+sym));
console.log('PASS Orbital quality: missing/stale/reference history, stale quotes, malformed scores, actual gate counts, WAIT state; no feed/persistence calls; unique controls');

const css=fs.readFileSync('src/main/resources/static/workspace-ui.css','utf8');
const cardRule=css.match(/\.ic,\.sig-card,\.pc,\.pulse,\.dash-hero,\.quality-card,\.ev-card\{([^}]+)\}/)[1];
assert.ok(!cardRule.includes('!important'),'Generic card styles must allow existing selected, outcome and uploaded hero styles to win');
console.log('PASS original semantic style cascade and custom hero-image styles preserved');

assert.ok(/\.pc\.sel\{border-color:var\(--acc\)!important/.test(css),'Selected prices must remain visible above the legacy glass border');

const pages=context.OrbitalUI.workspaces,route=context.OrbitalUI.routeTarget,all=Object.keys(pages);
assert.equal(all.length,15);
for(const tab of all){
 assert.equal(route('#'+tab,all),tab);
 assert.equal(route('#'+tab,[]),null);
 assert.ok(html.includes('id="'+pages[tab].panel+'"'));
 for(const link of pages[tab].links)assert.ok(all.includes(link),'Missing related destination '+link);
}
for(const bad of ['#admin','#constructor','#__proto__','#%ZZ','#unknown','#javascript:alert(1)'])assert.equal(route(bad,['chart','analysis']),null);
assert.equal(route('#%61nalysis',['analysis']),'analysis');
assert.ok(src.includes("history.pushState(null,'','#'+button.dataset.tab)"));
assert.ok(src.includes("addEventListener('popstate',routeFromLocation)"));
assert.ok(!html.includes('border:1px solid var(--glass-bd)!important'),'Legacy glass skin must not override workspace surfaces');
console.log('PASS all 15 deep links, permission filtering, malformed/unknown routes, destination integrity and retired legacy skin');
