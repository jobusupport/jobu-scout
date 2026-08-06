'use strict';

// Proves the PSG/PSP -> "Analyze Opponent's Games/Players" terminology
// rename is complete and consistent across server.js (job titles/log
// lines) and dashboard/index.html (buttons/labels/badges/empty states),
// and that the four exact readiness-status strings exist verbatim.
//
// Run with: node --test test/opponent-analysis-terminology.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dashboardSrc = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');

test('no user-facing "PSG" or "PSP" text remains in server.js', () => {
  assert.doesNotMatch(serverSrc, /\bPSG\b/);
  assert.doesNotMatch(serverSrc, /\bPSP\b/);
});

test('no "PSG" or "PSP" text remains in dashboard/index.html', () => {
  assert.doesNotMatch(dashboardSrc, /PSG/);
  assert.doesNotMatch(dashboardSrc, /PSP/);
});

test('server.js job titles use the exact required button labels', () => {
  assert.match(serverSrc, /Analyze Opponent's Games — \$\{team\.team_name\}/);
  assert.match(serverSrc, /Analyze Opponent's Players — \$\{team\.team_name\}/);
});

test('dashboard/index.html contains the exact required button labels with a straight apostrophe', () => {
  assert.match(dashboardSrc, /Analyze Opponent's Games<\\u002Fbutton>/);
  assert.match(dashboardSrc, /Analyze Opponent's Players<\\u002Fbutton>/);
  // Straight apostrophe (U+0027), never a curly/typographic one.
  const idx = dashboardSrc.indexOf("Analyze Opponent's Games");
  assert.ok(idx !== -1);
  assert.equal(dashboardSrc.codePointAt(idx + "Analyze Opponent".length), 0x27);
});

test('dashboard/index.html contains the four exact required readiness-status strings', () => {
  for (const status of [
    'Opponent Game Analysis Ready',
    'Opponent Game Analysis Missing',
    'Opponent Player Analysis Ready',
    'Opponent Player Analysis Missing',
  ]) {
    assert.ok(dashboardSrc.includes(status), `expected to find exact readiness string: "${status}"`);
  }
});

test('the readiness badges are driven by the real hasGC/hasPG booleans, not a stale job record', () => {
  assert.match(dashboardSrc, /t\.hasGC \? 'Opponent Game Analysis Ready' : 'Opponent Game Analysis Missing'/);
  assert.match(dashboardSrc, /t\.hasPG \? 'Opponent Player Analysis Ready' : 'Opponent Player Analysis Missing'/);
});

test('the gc-scraper/pg-scraper button onclick wiring is unchanged -- new labels still invoke the correct existing operation', () => {
  assert.match(dashboardSrc, /onclick=\\"runJob\('gc-scraper'\)\\">Analyze Opponent's Games<\\u002Fbutton>/);
  assert.match(dashboardSrc, />Analyze Opponent's Players<\\u002Fbutton>/);
});

test('dashboard/index.html JS is still syntactically valid after the rename (embedded script blocks parse cleanly)', () => {
  const scripts = [...dashboardSrc.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, 'expected at least one <script> block');
  const vm = require('node:vm');
  for (const script of scripts) {
    assert.doesNotThrow(() => new vm.Script(script), `dashboard/index.html contains a script block with a syntax error after the terminology rename`);
  }
});
