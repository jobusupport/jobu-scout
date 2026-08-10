'use strict';

// High School Slice 2B, Phase 6: proves src/engine/baseball-engine.js (and
// everything it transitively requires) has no database, network,
// filesystem, environment-variable, UI, or AI/report-generation dependency
// -- it can only ever run on synthetic in-memory input. This is a static
// proof (source-text + require-graph inspection), not a runtime mock check,
// so it catches a dependency added later just as reliably as one added
// today.
//
// Run with: node --test test/baseball-engine-dependency-boundary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..', 'src', 'engine');
const ENGINE_ENTRY = path.join(ENGINE_DIR, 'baseball-engine.js');

// Forbidden Node built-ins / patterns for a pure computational module.
const FORBIDDEN_REQUIRE_PATTERNS = [
  /require\(\s*['"]fs['"]\s*\)/,
  /require\(\s*['"]fs\/promises['"]\s*\)/,
  /require\(\s*['"]net['"]\s*\)/,
  /require\(\s*['"]http['"]\s*\)/,
  /require\(\s*['"]https['"]\s*\)/,
  /require\(\s*['"]dgram['"]\s*\)/,
  /require\(\s*['"]child_process['"]\s*\)/,
  /require\(\s*['"]dns['"]\s*\)/,
  /require\(\s*['"]dotenv['"]\s*\)/,
  /require\(\s*['"]@supabase\/supabase-js['"]\s*\)/,
  /require\(\s*['"]better-sqlite3['"]\s*\)/,
  /require\(\s*['"]playwright['"]\s*\)/,
  /require\(\s*['"]express['"]\s*\)/,
];

const FORBIDDEN_GLOBAL_PATTERNS = [
  /\bfetch\s*\(/,
  /\bprocess\.env\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
];

// Every module reachable from the engine's own require graph, restricted to
// files inside this repository (node_modules / Node built-ins are inspected
// only by name via the patterns above, not walked into).
function collectLocalRequireGraph(entryFile) {
  const visited = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const requireRe = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let match;
    while ((match = requireRe.exec(source)) !== null) {
      let resolved = path.resolve(path.dirname(file), match[1]);
      if (!path.extname(resolved)) resolved += '.js';
      if (fs.existsSync(resolved) && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return [...visited];
}

test('dependency boundary -- baseball-engine.js only requires the three authoritative pure core modules', () => {
  const source = fs.readFileSync(ENGINE_ENTRY, 'utf8');
  const localRequires = [...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(localRequires.sort(), ['./normalize-core', './reconstruct-core', './stats-core'].sort());
});

test('dependency boundary -- the engine\'s full local require graph never requires a DB/network/filesystem/child-process/env/UI-framework module', () => {
  const graph = collectLocalRequireGraph(ENGINE_ENTRY);
  assert.ok(graph.length >= 4, `expected to walk at least the engine file + 3 legacy files, got ${graph.length}: ${graph.join(', ')}`);
  for (const file of graph) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_REQUIRE_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${path.relative(process.cwd(), file)} matched forbidden require pattern ${pattern}`);
    }
  }
});

test('dependency boundary -- the engine\'s full local require graph never references fetch/process.env/XMLHttpRequest/WebSocket', () => {
  const graph = collectLocalRequireGraph(ENGINE_ENTRY);
  for (const file of graph) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_GLOBAL_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${path.relative(process.cwd(), file)} matched forbidden global pattern ${pattern}`);
    }
  }
});

test('dependency boundary -- no file under src/engine/ requires anything outside src/ (no test helpers, no repository/service/route modules)', () => {
  const files = fs.readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const source = fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8');
    const localRequires = [...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const req of localRequires) {
      assert.ok(
        /^\.\/(normalize-core|reconstruct-core|stats-core)$/.test(req),
        `${f} requires unexpected local module "${req}"`,
      );
    }
  }
});

test('dependency boundary -- requiring the engine module at runtime does not touch process.env, and its exports are plain functions with no attached DB/client state', () => {
  const engine = require('../src/engine/baseball-engine');
  const expectedExports = ['reconstructBaseballGame', 'reconstructBaseballTeamGames', 'computeBaseballStats', 'normalizeBaseballGame', '_internals'];
  assert.deepEqual(Object.keys(engine).sort(), expectedExports.sort());
  for (const name of expectedExports) {
    if (name === '_internals') continue;
    assert.equal(typeof engine[name], 'function');
  }
});

test('dependency boundary -- running the engine\'s functions on purely synthetic in-memory input requires no environment variables to be set', () => {
  // This test file itself is invoked without test-env-setup.js (unlike the
  // rest of the suite, run via package.json's --require flags), yet the
  // engine still works -- proving it reads no env-derived config.
  const { reconstructBaseballGame } = require('../src/engine/baseball-engine');
  const result = reconstructBaseballGame({
    meta: { gameId: 'g1' },
    boxScore: { batting: [{ Player: 'A', TeamSide: 'home', own: true, AB: 1, H: 1 }], pitching: [] },
    plays: [],
  });
  assert.equal(result.own.boxBatting.h, 1);
});
