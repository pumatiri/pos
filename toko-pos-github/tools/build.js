#!/usr/bin/env node
/* Membangun situs statis (docs/index.html) dari file Apps Script.
   Pemakaian:  node tools/build.js [URL_WEB_APP]
   URL juga bisa lewat env API_URL atau berkas config.json {"apiUrl": "..."} */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), src = path.join(root, 'apps-script'), out = path.join(root, 'docs');
let url = process.argv[2] || process.env.API_URL || '';
if (!url) { try { url = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).apiUrl; } catch (e) { /* kosong */ } }
if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { console.error('URL web app tidak valid. Contoh: https://script.google.com/macros/s/XXXX/exec'); process.exit(1); }
const rd = f => fs.readFileSync(path.join(src, f), 'utf8');
function fnSource(code, name) {
  const i = code.indexOf('function ' + name); if (i < 0) throw new Error(name + ' tidak ditemukan');
  let d = 0, j = code.indexOf('{', i);
  for (let k = j; k < code.length; k++) { if (code[k] === '{') d++; else if (code[k] === '}' && --d === 0) return code.slice(i, k + 1); }
  throw new Error('kurung tidak seimbang');
}
const pricing = fnSource(rd('Code.gs'), 'computeTotals_');
let html = rd('Index.html')
  .replace('<base target="_top">\n', '')
  .replace("<?!= include_('Style') ?>", () => rd('Style.html'))
  .replace('<script><?!= pricingSrc_() ?></script>', () => '<script>' + pricing + '</script>')
  .replace("<?!= include_('Script') ?>", () => rd('Script.html').replace('__API_URL__', url));
if (/<\?/.test(html)) throw new Error('Masih ada tag template Apps Script');
html = html.replace('<title>', '<meta name="theme-color" content="#0b7a63">\n<meta name="robots" content="noindex">\n<title>');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('OK -> docs/index.html (' + Math.round(html.length / 1024) + ' KB), backend: ' + url);
