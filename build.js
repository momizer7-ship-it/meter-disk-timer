// Inlines core.js into page.html -> dist/meter-disk.html
const fs = require('fs');
const path = require('path');
const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const body = page.replace('/*CORE*/', () => core);
// Artifact version: the publisher adds the document skeleton.
fs.writeFileSync(path.join(__dirname, 'dist', 'meter-disk.html'), body);
// GitHub Pages version: full document.
fs.writeFileSync(path.join(__dirname, 'index.html'),
  '<!doctype html>\n<html lang="th">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  '</head>\n<body>\n' + body + '\n</body>\n</html>\n');
console.log('built dist/meter-disk.html and index.html');
