// A phone clock that is off by minutes must not pause metal entries or keep an old quote fresh (reviewer 1.12).
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/../src/main/resources/static/paper-engine.js','utf8');
let local=1_000_000_000_000;
const ctx=vm.createContext({Date:{now:()=>local},crypto:{randomUUID:()=>'x'},PaperMath:{positive:x=>x>0},prices:{XAUUSD:4100}});
vm.runInContext(src,ctx);
const server=local+120000;                    // phone is 2 minutes behind the server
ctx.quoteAt.XAUUSD=server-5000;               // provider stamped the quote 5 s ago (server time)
assert.equal(ctx.freshQuote('XAUUSD'),false,'before measuring, the skewed phone sees a future quote');
ctx.noteServerTime(server+150,local,local+300); // 300 ms round trip, server answered mid-way
assert.equal(ctx.serverClock.offset,120000);
assert.equal(ctx.freshQuote('XAUUSD'),true,'5 s old quote is fresh on server time');
ctx.quoteAt.XAUUSD=server-30001;assert.equal(ctx.freshQuote('XAUUSD'),false,'30 s gate unchanged');
// Phone 2 minutes ahead: stale quotes must not look fresh either.
ctx.noteServerTime(local-120000+50,local,local+100);
assert.equal(ctx.serverClock.offset,-120000);
ctx.quoteAt.XAUUSD=local-120000-31000;assert.equal(ctx.freshQuote('XAUUSD'),false);
// Slow or broken replies are ignored.
const before=ctx.serverClock.offset;ctx.noteServerTime(local+999999,local,local+6000);ctx.noteServerTime(NaN,local,local+10);
assert.equal(ctx.serverClock.offset,before);
console.log('PASS server clock offset: skewed phone clocks keep the 30 s metal gate on server time');
