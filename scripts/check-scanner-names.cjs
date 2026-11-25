// The scanner's extracted-name list is documented; keep docs and code in step (reviewer 4.9).
const fs=require('fs'),assert=require('assert'),path=require('path');
const root=path.join(__dirname,'..');
const s=fs.readFileSync(path.join(root,'src/main/resources/background/scanner.cjs'),'utf8');
const doc=fs.readFileSync(path.join(root,'docs/background-scanner.md'),'utf8');
const html=fs.readFileSync(path.join(root,'src/main/resources/static/index.html'),'utf8');
const names=JSON.parse(s.match(/const names=(\[[^\]]+\])/)[1].replace(/'/g,'"'));
const consts=JSON.parse(s.match(/(\[[^\]]+\])\.map\(n=>extract\(n,'const'\)\)/)[1].replace(/'/g,'"'));
for(const n of [...names,...consts])assert(doc.includes('`'+n+'`'),'docs/background-scanner.md is missing '+n);
assert(html.includes('docs/background-scanner.md'),'index.html must point to the scanner name list');
console.log('PASS scanner name list documented ('+names.length+' functions, '+consts.length+' constants)');
