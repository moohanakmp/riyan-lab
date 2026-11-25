'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {extract}=require('../src/main/resources/background/scanner.cjs');
const PaperMath=require('../src/main/resources/static/trading-core.js');
(async()=>{
 const calls=[];const news=vm.createContext({Date,URL,encodeURIComponent,NEWS_QUERY:{XAUUSD:'gold'},feedError:{},tagSentiment:()=> 'nt',
  riyanApi:async()=>{calls.push('server');return [{headline:'Actual headline',url:'https://example.org/article',source_name:'RSS',published_at:new Date().toISOString()}];},
  throttleFeedCall:async()=>{},fetchJsonRobust:async()=>{calls.push('external');return{data:null,error:'unavailable'};}});
 vm.runInContext(['fetchStoredNews','fetchNews'].filter(n=>{try{extract(n);return true;}catch{return false;}}).map(n=>extract(n)).join('\n'),news);
 const articles=await news.fetchNews('XAUUSD');assert.equal(articles[0].title,'Actual headline');assert.deepEqual(calls,['server'],'healthy stored RSS must not wait behind six external failures');
 news.riyanApi=async()=>[{headline:'Unsafe URL',url:'javascript:alert(1)',published_at:new Date().toISOString()},{headline:'Old',url:'https://example.org/old',published_at:'2000-01-01'}];assert.equal(await news.fetchStoredNews('XAUUSD'),null,'invalid or ancient headlines must be rejected');
 news.riyanApi=async()=>{throw Error('offline');};news.fetchJsonRobust=async()=>({data:{items:[{title:'Fallback - Paper',link:'https://example.org/fallback',pubDate:new Date().toISOString()}]},error:null});assert.equal((await news.fetchNews('XAUUSD'))[0].title,'Fallback','external feeds remain available when stored RSS fails');
 const nodes=new Map(),tabs=['chart','scalp','admin'].map(tab=>({style:{display:''},getAttribute:()=>tab,classList:{contains:()=>tab==='chart'}}));let selected;nodes.set('adminTabBtn',tabs[2]);
 const role=vm.createContext({currentUser:{username:'fixture',role:'admin'},location:{hash:'#scalp'},hasAccess:()=>true,renderAdminPanel(){},applyTheme(){},showTab:n=>selected=n,
  document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,{style:{}});return nodes.get(id);},querySelectorAll:()=>tabs}});
 vm.runInContext(extract('applyRoleUI'),role);role.applyRoleUI();assert.equal(selected,'scalp','refresh must preserve an allowed deep link');
 role.currentUser.role='user';role.location.hash='#admin';role.applyRoleUI();assert.notEqual(selected,'admin','deep links cannot bypass role filtering');
 role.location.hash='#%ZZ';assert.doesNotThrow(()=>role.applyRoleUI());
 let releases=[];const box={innerHTML:''};const analytics=vm.createContext({analyticsSym:'XAUUSD',ASSETS:{XAUUSD:{sym:'Gold'},BTCUSD:{sym:'Bitcoin'}},
  document:{getElementById:()=>box},fetchLiveCrypto:()=>new Promise(r=>releases.push(r)),fetchLiveMetals:async()=>{},runManualAnalysis:sym=>({sym}),manualResultBodyHtml:(sym)=>sym});
 vm.runInContext('let analyticsEntryRequest=0;'+extract('loadAnalyticsEntry'),analytics);
 const first=analytics.loadAnalyticsEntry('XAUUSD');analytics.analyticsSym='BTCUSD';const second=analytics.loadAnalyticsEntry('BTCUSD');
 releases[1]();await second;releases[0]();await first;assert(box.innerHTML.includes('BTCUSD')&&!box.innerHTML.includes('XAUUSD'),'a late response must not overwrite the currently selected asset');
 const now=Math.floor(Date.now()/300000)*300000;const bars=Array.from({length:30},(_,i)=>({t:now-(30-i)*300000,ms:300000,o:100+i,h:102+i,l:99+i,c:101+i,v:10}));
 const mtf=vm.createContext({Date,PaperMath,ema:(xs,n)=>xs.length>=n?xs.slice(-n).reduce((a,b)=>a+b,0)/n:null,
  scalpData:{XAUUSD:bars},volumeTrapMinuteCache:new Map(),ohlcData:{XAUUSD:{'1h':[],'4h':[]}},buildTFFromTicks:()=>[],marketTrend:{XAUUSD:'BULL'},mtfTrend:{}});
 vm.runInContext(['mtfClosedCandles','tfTrendFromCandles','computeMTFTrend'].filter(n=>{try{extract(n);return true;}catch{return false;}}).map(n=>extract(n)).join('\n'),mtf);
 assert.equal(mtf.computeMTFTrend('XAUUSD')['5m'],'BULL','loaded provider 5m history must be available to Analysis without an hour of ticks');
 mtf.scalpData.XAUUSD=bars.map(k=>({...k,analysisOnly:true}));assert.equal(mtf.computeMTFTrend('XAUUSD')['5m'],null,'reference candles cannot produce live reversal warnings');
 mtf.scalpData.XAUUSD=bars.map(k=>({...k,t:k.t-86400000}));assert.equal(mtf.computeMTFTrend('XAUUSD')['5m'],null,'stale provider history cannot imply a live trend');
 const dashboardBody={innerHTML:''};const dash=vm.createContext({Date,Number,Math,istDayKey:()=>0,sigTime:()=>0,allPaperRows:()=>[],pnlStats:()=>({pnl:0,closed:0}),kmrIstHour:()=>12,
  currentUser:{username:'fixture'},SYMS:['XAUUSD'],activeSignals:{},themeSettings:{},signalHistory:[],scalpToday:()=>({pnl:0}),scalpCfg:{goal:10},ICONS:{XAUUSD:'Gold'},ASSETS:{XAUUSD:{sym:'Gold'}},prices:{},dayOpen:{},basketTxt:s=>String(s),
  document:{getElementById:()=>dashboardBody},computeSignal:()=>({state:'BUY',smart:{tier:'MED',dir:'BUY',score:73,bias1h:'BULL',bias4h:'BULL'}}),autoEntryCheck:()=>({ok:false,reason:'Structural stop exceeds $4'}),feedStatus:()=>({last:{},source:'fixture'})});
 vm.runInContext(extract('renderDashboard'),dash);dash.renderDashboard();assert(dashboardBody.innerHTML.includes('Structural stop exceeds $4'));assert(!dashboardBody.innerHTML.includes('a-XAUUSD ready'),'a technical tier is not entry approval');
 dash.autoEntryCheck=()=>({ok:true});dash.renderDashboard();assert(dashboardBody.innerHTML.includes('awaiting acceptance'),'a candidate must not be labelled an accepted trade');
 const histNodes={};const history=vm.createContext({Date,Number,Math,currentUser:{role:'admin'},hasAccess:()=>true,histFilter:'ALL',prices:{XAUUSD:105},freshQuote:()=>true,SPREAD:{XAUUSD:.35},ICONS:{XAUUSD:'Gold'},ASSETS:{XAUUSD:{sym:'Gold'}},fmtP:(_,p)=>'$'+p,
  signalHistory:[{id:900,ts:1,confidence:'MED',sym:'XAUUSD',dir:'BUY',outcome:'BE',pnlUsd:0,price:100,lot:.01,dateStr:'older'},{id:1,ts:2,confidence:'MED',sym:'XAUUSD',dir:'BUY',outcome:'OPEN',price:100,posUnits:2,remFrac:.5,lot:.01,dateStr:'newer'}],
  document:{querySelectorAll:()=>[],getElementById:id=>histNodes[id]||(histNodes[id]={innerHTML:''})}});
 vm.runInContext(['floatingPaperPnl','renderHistory'].map(n=>extract(n)).join('\n'),history);history.renderHistory();
 assert(histNodes.historyContainer.innerHTML.indexOf('newer')<histNodes.historyContainer.innerHTML.indexOf('older'),'history sorts by entry time, not database IDs');
 assert(histNodes.historyContainer.innerHTML.includes('BREAKEVEN'));assert(histNodes.historyContainer.innerHTML.includes('$4.65'),'partial floating profit includes spread and remaining quantity');
 history.freshQuote=()=>false;history.renderHistory();assert(!histNodes.historyContainer.innerHTML.includes('Float:'),'stale prices cannot show floating profit');
 const monthNow=Date.UTC(2026,10,30,15,0);const FixedDate=class extends Date {constructor(...a){super(...(a.length?a:[monthNow]));}static now(){return monthNow;}};
 const pnl=vm.createContext({Date:FixedDate,pnlPeriod:'month',istDayKey:()=>Math.floor((monthNow+19800000)/86400000)});
 vm.runInContext(extract('pnlRange'),pnl);assert.equal(pnl.pnlRange().a,Date.UTC(2026,9,31,18,30));assert(pnl.pnlRange().label.includes('November'),'IST month label must not add the local timezone twice');
 const researchCache={},researchNodes={};const research=vm.createContext({Date,Math,SYMS:['XAUUSD','XAGUSD','BTCUSD'],RESEARCH_WINDOWS:[5,10,20],researchCache,
  document:{getElementById:id=>researchNodes[id]||(researchNodes[id]={})},renderResearchTab(){},
  fetchResearchHistory:async sym=>{if(sym==='XAUUSD')throw Error('Provider unavailable');return Array.from({length:120},(_,i)=>({t:100000+i*86400000,c:100}));},
  researchConditionAt:()=>({price:100,atrPct:2}),findResearchMatches:()=>[],classifyOutcome:()=> 'FLAT',atr:()=>2});
 vm.runInContext(extract('runResearch'),research);await research.runResearch();assert.equal(researchCache.XAUUSD.ready,false);assert.equal(researchCache.XAGUSD.ready,true);assert.equal(researchCache.BTCUSD.ready,true,'a failed gold provider cannot stop research for BTC');assert.equal(researchNodes.researchBtn.disabled,false);
 const healthy=Array.from({length:60},(_,i)=>({t:i+1,c:200})),prior=[{c:100}];const refresh=vm.createContext({Date,Promise,CANDLE_LIMIT:700,ohlcData:{BTCUSD:{'15m':prior,'1h':prior,'4h':prior}},prices:{},
  fetchBinanceKlines:async(_,tf)=>{if(tf==='4h')throw Error('4h outage');return healthy;},fetchMetalOHLC:async()=>{},renderFeedStatus(){},appendLiveTick(){}});
 vm.runInContext(extract('performOhlcSync'),refresh);await refresh.performOhlcSync();assert.equal(refresh.ohlcData.BTCUSD['15m'],healthy);assert.equal(refresh.ohlcData.BTCUSD['1h'],healthy);assert.equal(refresh.ohlcData.BTCUSD['4h'],prior,'failed frame retains its original timestamped history');
 const metal=vm.createContext({Promise,CANDLE_LIMIT:700,metalRaw:{},metalSrc:{},metalFeedError:{},ohlcData:{XAUUSD:{}},calibrateMetal(){},aggregate15m:()=>[],
  metalHistorySources:()=>[{name:'fixture',fn:async tf=>{if(tf==='4h')throw Error('4h outage');return healthy;}}]});
 vm.runInContext(extract('fetchMetalOHLC'),metal);await metal.fetchMetalOHLC('XAUUSD');assert.equal(metal.metalRaw.XAUUSD['1h'],healthy,'a failed 4h request cannot replace successful provider 1h history with a shorter aggregate');
 let frameAttempts=0;const backoff=vm.createContext({Date,historyBackoff:new Map(),FAPI_SYM:{XAUUSD:'XAUUSDT'},ReferenceFeed:{info:()=>({source:'reference'})},fetchOkxMetal:async(_,tf)=>{frameAttempts++;if(tf==='4h')throw Error('4h failed');return healthy;}});
 vm.runInContext(['historyAttempt','metalHistorySources'].map(n=>extract(n)).join('\n'),backoff);const primary=backoff.metalHistorySources('XAUUSD')[0];await assert.rejects(primary.fn('4h',60));assert.equal(await primary.fn('5m',60),healthy,'a 4h request backoff cannot suppress healthy 5m data');await assert.rejects(primary.fn('4h',60));assert.equal(frameAttempts,2,'failed timeframe still honors its backoff');
 const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
 assert.match(html,/<script\s+async\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@emailjs/,'optional email SDK cannot block application login');
 // Kalai's standing rule: Auto analysis, Low Profit and Volume Trap UI must stay in the app.
 {const page=fs.readFileSync(require('node:path').join(__dirname,'../src/main/resources/static/index.html'),'utf8');
  for(const tab of ['signals','analysis','scalp','flow'])assert.ok(page.includes(`data-tab="${tab}"`),'tab '+tab+' must stay');
  assert.ok(/Volume Trap/.test(page),'Volume Trap UI must stay');}
 console.log('PASS stored/fallback news, permitted/denied routes, analytics race isolation, closed MTF history, approval-aware dashboard, ordered BE/partial/stale history P&L, IST month boundaries, research failure isolation and nonblocking SDK');
})().catch(e=>{console.error(e);process.exitCode=1;});
