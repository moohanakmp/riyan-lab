// Single "Today" page (2026-11-26 UI review): merged pages stay reachable, permissions unchanged.
const fs=require('fs'),assert=require('assert'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'../src/main/resources/static/index.html'),'utf8');
const bar=html.slice(html.indexOf('<div class="tabs" id="tabsRow"'),html.indexOf('<div class="scroll" id="mainScroll"'));
assert(/data-tab="today"[^>]*onclick="showTab\('today',this\)"/.test(bar),'Today button first in the tab bar');
assert(bar.indexOf('data-tab="today"')<bar.indexOf('data-tab="history"'),'Today comes before Tools');
const merged=bar.slice(bar.indexOf('<div class="today-merged" hidden>'),bar.indexOf('</div>',bar.indexOf('today-merged')));
for(const t of ['chart','prices','signals','analysis','dashboard','scalp','volumeTrap'])assert(merged.includes('data-tab="'+t+'"'),t+' kept as hidden route/permission button');
for(const t of ['history','session','flow','manual','research','analytics','pnl','admin','broker','info'])assert(bar.includes('data-tab="'+t+'"')&&!merged.includes('data-tab="'+t+'"'),t+' stays in Tools');
const nav=html.slice(html.indexOf('<nav id="todayModules"'),html.indexOf('</nav>',html.indexOf('<nav id="todayModules"')));
for(const m of ['signals','scalp','volumeTrap','analysis'])assert(nav.includes(`showToday('${m}')`),'module '+m+' on Today (Auto signals, Low Profit, Volume Trap, Levels must stay)');
for(const id of ['tdb','tp','tc','ts','tsc','tvt','tan','pv-XAUUSD','pc-XAUUSD','c-XAUUSD','signalGlance','triggeredSignals','todayChartBar'])assert(html.includes('id="'+id+'"'),'element #'+id+' kept');
const show=html.slice(html.indexOf('function showTab(n,el){'),html.indexOf('function showTab(n,el){')+2600);
assert(show.indexOf("if(n==='today'||TODAY_MERGED.includes(n))")>show.indexOf("if(n==='broker'&&(!currentUser||currentUser.role!=='admin'))return;"),'permission gates run before the Today redirect');
const today=html.slice(html.indexOf('const TODAY_MERGED='),html.indexOf('function showTab(n,el){'));
assert(/hasAccess\('dashboard'\)\)show\('tdb'\)/.test(today)&&/hasAccess\('signals'\)/.test(today)&&/hasAccess\('chart'\)/.test(today),'Today sections gated by the same access keys');
assert(/m==='volumeTrap'\?hasAccess\('flow'\)/.test(today)&&/m==='analysis'\?hasAccess\('analysis'\)/.test(today),'module access keys unchanged');
console.log('PASS Today page: merged routes kept, modules present, permissions gate first');
