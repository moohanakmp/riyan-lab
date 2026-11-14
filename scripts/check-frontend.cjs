const fs = require('node:fs');
const vm = require('node:vm');
const dir = 'src/main/resources/static';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
if (files.length === 0) throw new Error('No HTML pages found');
for (const name of files) {
  const path = dir + '/' + name;
  const html = fs.readFileSync(path, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length === 0) throw new Error('No embedded JavaScript found in ' + path);
  for (const script of scripts) new vm.Script(script[1], {filename:path});
  console.log('Validated ' + scripts.length + ' inline JavaScript block(s) in ' + path);
}
const manifest = JSON.parse(fs.readFileSync(dir + '/manifest.json', 'utf8'));
const assets = new Set(manifest.icons.map(icon => icon.src.replace(/^\//, '')));
for (const name of files) {
  const html = fs.readFileSync(dir + '/' + name, 'utf8');
  for (const match of html.matchAll(/(?:src=["']|url\(["']?)(\/?(?:art\/[^"')\s]+|[^/"']+\.(?:js|png)))(?:\?[^"')\s]*)?["')]/g)) {
    assets.add(match[1].replace(/^\//, '').split('?')[0]);
  }
}
for (const asset of assets) {
  if (!fs.existsSync(dir + '/' + asset)) throw new Error('Missing static asset: ' + asset);
}
console.log('Validated ' + assets.size + ' referenced local assets');
