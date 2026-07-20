'use strict';
const fs = require('fs');
const path = require('path');

const inPath = process.argv[2];
if (!inPath) {
  console.error('Usage: node scripts/encode-dashboard.js <decoded-input-path> [--dry-run-compare]');
  process.exit(1);
}
const dryRunCompare = process.argv.includes('--dry-run-compare');

const decoded = fs.readFileSync(inPath, 'utf8');
let jsonStr = JSON.stringify(decoded);
jsonStr = jsonStr.split('</').join('<\\u002F');

const dashboardPath = path.join(__dirname, '..', 'dashboard', 'index.html');
const raw = fs.readFileSync(dashboardPath, 'utf8');
const lines = raw.split('\n');

if (dryRunCompare) {
  const identical = lines[193] === jsonStr;
  console.log('Round-trip identical to existing line 194:', identical);
  if (!identical) {
    console.log('existing length:', lines[193].length, 'new length:', jsonStr.length);
    let i = 0;
    while (i < Math.min(lines[193].length, jsonStr.length) && lines[193][i] === jsonStr[i]) i++;
    console.log('first diff at index', i);
    console.log('existing around diff:', JSON.stringify(lines[193].slice(Math.max(0,i-40), i+40)));
    console.log('new      around diff:', JSON.stringify(jsonStr.slice(Math.max(0,i-40), i+40)));
  }
  process.exit(0);
}

lines[193] = jsonStr;
fs.writeFileSync(dashboardPath, lines.join('\n'), 'utf8');
console.log('Wrote updated dashboard/index.html, new line 194 length:', jsonStr.length);
