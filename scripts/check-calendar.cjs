'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
(async()=>{
 const html=fs.readFileSync('src/main/resources/static/index.html','utf8');
 const code=html.slice(html.indexOf('let calendarCache=null,calendarCacheAt=0,calendarHealth=null;'),html.indexOf('// Rough "which way'));
 assert(code.length>100);let now=Date.UTC(2026,9,19,15),calls=0,fail=false;
 const DateClock=class extends Date{static now(){return now;}};
 let payload={ready:true,calendarAt:now-10*60000,expiresAt:now+20*60000,source:'Test trusted calendar',calendar:[{title:'USD release',country:'USD',impact:'High',date:new Date(now+3600000).toISOString()}]};
 const context=vm.createContext({Date:DateClock,console,currentUser:{username:'test'},document:{getElementById:()=>null},feedError:{},updateNewsLog:()=>{},
  riyanApi:async path=>{assert.equal(path,'/api/v1/paper/background/calendar-status');calls++;if(fail)throw Error('network unavailable');return payload;}});
 vm.runInContext(code,context);await Promise.all([context.fetchEconCalendar(),context.fetchEconCalendar()]);assert.equal(calls,1);
 const value=s=>vm.runInContext(s,context);const fetched=value('calendarCacheAt');assert.equal(fetched,payload.calendarAt,'never re-date a cached server schedule');assert.equal(context.calendarReady(),true);
 now+=6*60000;fail=true;await context.fetchEconCalendar(true);assert.equal(context.calendarReady(),true,'still-valid cache survives a failed refresh');assert.equal(value('calendarCacheAt'),fetched);
 now+=15*60000;await context.fetchEconCalendar(true);assert.equal(context.calendarReady(),false,'expired cache cannot approve news checks');assert.equal(value('calendarCache'),null);
 fail=false;now+=31000;payload={ready:false,calendarError:'HTTP 429',retryAt:now+120000};await context.fetchEconCalendar();assert.equal(context.calendarReady(),false);
 now+=31000;payload={ready:true,calendarAt:now+60000,expiresAt:now+1800000,calendar:[{title:'USD release',country:'USD',impact:'High',date:new Date(now+3600000).toISOString()}]};
 await context.fetchEconCalendar(true);assert.equal(context.calendarReady(),false,'future validation timestamps fail closed');
 now+=31000;payload.calendarAt=now;payload.expiresAt=now+1000;await context.fetchEconCalendar(true);assert.equal(context.calendarReady(),true);now+=1001;assert.equal(context.calendarReady(),false,'weekly coverage horizon also expires');
 assert(!code.includes('corsproxy')&&!code.includes('allorigins')&&!code.includes('r.jina.ai'),'no client-side proxy chain can override server news readiness');
 console.log('PASS shared calendar fetch, true source age, bounded stale cache, outage/recovery, future-clock and coverage expiry gates');
})().catch(e=>{console.error(e);process.exitCode=1;});
