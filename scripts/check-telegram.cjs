'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {extract}=require('../src/main/resources/background/scanner.cjs');
(async()=>{
 const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
 const messages=[],status=[];let response={ok:false,error:'Forbidden: bot was blocked'};
 const c=vm.createContext({notifSettings:{sendHere:true,tgEnabled:true,tgToken:'test',tgChatId:'42'},currentUser:{username:'kalai',role:'admin'},saveNotifSettings:async()=>true,document:{getElementById:()=>({set textContent(t){status.push(t);}})},showToast:(...a)=>messages.push(a),riyanApi:async(path,opts)=>{assert.equal(path,'/api/v1/telegram/test');assert.equal(opts.method,'POST');return response;},fetch:async()=>({ok:false,json:async()=>({ok:false,description:'chat not found'})})});
 vm.runInContext(['telegramStatusText','testTelegram','sendTelegram'].map(n=>extract(n)).join('\n'),c);
 await c.testTelegram();assert(messages.every(m=>!m[0].includes('confirmed delivery')),'rejected test cannot show success');assert(status.at(-1).includes('bot was blocked'));
 response={ok:true};await c.testTelegram();assert(messages.at(-1)[0].includes('confirmed delivery'));
 assert.equal((await c.sendTelegram('test')).ok,false,'browser miscellaneous messages also validate the Telegram result');
 assert(!extract('recordSignal').includes('sendTelegram('),'entry Telegram delivery is server-owned, independent of optional UI errors');
 assert(!extract('scalpOpen').includes('sendTelegram('),'Low Profit entry cannot duplicate the server delivery');
 const load=html.slice(html.indexOf('async function loadNotifData'),html.indexOf('async function loadNotifSettings'));
 assert(load.includes('syncTelegramSettings'),'existing sender configuration migrates on login');
 console.log('PASS Telegram rejection visibility, confirmed-only test success, server-owned Auto/Low Profit entry delivery and settings migration');
})().catch(e=>{console.error(e);process.exitCode=1;});
