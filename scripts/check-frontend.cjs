const fs = require('node:fs');
const vm = require('node:vm');
const dir = 'src/main/resources/static';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
if (files.length === 0) throw new Error('No HTML pages found');
for (const name of files) {
  const path = dir + '/' + name;
  const html = fs.readFileSync(path, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\\bsrc\\b)[^>]*>([\\s\\S]*?)<\\/script>/gi)];
  if (scripts.length === 0) throw new Error('No embedded JavaScript found in ' + path);
  for (const script of scripts) new vm.Script(script[1], {filename:path});
  console.log('Validated ' + scripts.length + ' inline JavaScript block(s) in ' + path);
}
