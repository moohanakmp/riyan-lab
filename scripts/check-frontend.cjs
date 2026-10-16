const fs = require('node:fs');
const vm = require('node:vm');
const file = 'src/main/resources/static/index.html';
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi)];
if (scripts.length === 0) throw new Error('No embedded JavaScript found');
for (const script of scripts) new vm.Script(script[1], {filename:file});
console.log('Validated '+scripts.length+' inline JavaScript block(s)');
