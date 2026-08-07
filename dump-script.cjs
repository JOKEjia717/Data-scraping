const fs = require('fs');
const s = fs.readFileSync('C:/Users/xu/Desktop/data/Data-scraping/dashboard/app.js', 'utf8');
const p = s
  .replace('/* global Vue */', '')
  .replace(/const \{ createApp \} = Vue;/, 'const { createApp } = vm;')
  .replace(/async poll\(\) \{[\s\S]*?finally \{[\s\S]*?\}/, 'async poll(){}')
  .replace(/\.component\("sparkline", Sparkline\)\s*\.mount\("\#app"\);/, '.component("sparkline", Sparkline).mount(document.querySelector("#app"));')
  + '\n;window.__vueApp=app;';
fs.writeFileSync('C:/Users/xu/Desktop/data/Data-scraping/test-script.js', 'var vm = arguments[0];\n' + p);
console.log('wrote, len=', p.length);
