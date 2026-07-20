'use strict';
const fs = require('fs');
const path = require('path');

const outPath = process.argv[2];
if (!outPath) {
  console.error('Usage: node scripts/decode-dashboard.js <output-path>');
  process.exit(1);
}

const raw = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
const lines = raw.split('\n');
const jsonLine = lines[193]; // line 194, 0-indexed
const decoded = JSON.parse(jsonLine);
fs.writeFileSync(outPath, decoded, 'utf8');
console.log('decoded length:', decoded.length, 'lines:', decoded.split('\n').length);
