// Browser and server must enforce the same account-wide paper limits.
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'src/main/resources/static/index.html'),'utf8');
const java=fs.readFileSync(path.join(root,'src/main/java/com/riyanlab/PaperTradingService.java'),'utf8');
const scanner=fs.readFileSync(path.join(root,'src/main/resources/background/scanner.cjs'),'utf8');
const m=html.match(/const PAPER_LIMITS=\{riskUsd:([\d.]+),dayLossUsd:([\d.]+),maxOpen:(\d+)\};/);
assert(m,'PAPER_LIMITS missing in index.html');
const num=re=>{const x=java.match(re);assert(x,'missing in PaperTradingService: '+re);return +x[1];};
assert.strictEqual(num(/RISK_USD=([\d.]+)/),+m[1],'risk limit differs');
assert.strictEqual(num(/DAY_LOSS_USD=([\d.]+)/),+m[2],'daily loss limit differs');
assert.strictEqual(num(/MAX_OPEN=(\d+)/),+m[3],'max open positions differs');
assert(/'PAPER_LIMITS'/.test(scanner),'scanner.cjs must extract PAPER_LIMITS');
const fn=html.slice(html.indexOf('function paperAccountRisk('),html.indexOf('function autoEntryCheck('));
assert(!/4\.000001|>=5\b|<=-8\b/.test(fn),'paperAccountRisk still has hard-coded limits');
console.log('paper limits shared OK: $'+m[1]+' risk, $'+m[2]+' day loss, '+m[3]+' positions');
