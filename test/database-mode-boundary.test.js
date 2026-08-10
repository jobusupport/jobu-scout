'use strict';

// Security Slice T3F: structural guards preventing a future reintroduction
// of the pre-T3F defect -- server.js and src/db.js each independently
// re-implementing "should this process use Supabase?" from
// USE_SUPABASE/NODE_ENV/SUPABASE_URL, in a way that silently resolved to
// the local SQLite repository whenever that computation was wrong
// (missing config, a typo, production without USE_SUPABASE set).
// src/db-mode.js#resolveDatabaseMode() is now the single authoritative
// decision; these tests prove that boundary is a structural property, not
// merely a naming convention -- built from a genuine recursive scan of the
// whole repository (mirroring test/team-enumeration-api-boundary.test.js's
// convention), not an assumed file list.
//
// Run with: node --test test/database-mode-boundary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', 'output', 'temp-screenshots', 'storage']);

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkJsFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const ALL_JS_FILES = walkJsFiles(REPO_ROOT);

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function productionFiles() {
  return ALL_JS_FILES.filter((f) => !relPath(f).startsWith('test/'));
}

// ── src/db-mode.js is required by exactly its two authoritative callers ────

const ALLOWED_DB_MODE_REQUIRERS = new Set(['server.js', 'src/db.js']);

test('src/db-mode.js is required ONLY by server.js and src/db.js -- an exact, independently-scanned allowlist, ' +
     'not an assumed count. A new caller appearing here (or an expected one disappearing) must fail this test', () => {
  const requirePattern = /require\(\s*['"][^'"]*\/db-mode['"]\s*\)/;
  const actualRequirers = productionFiles()
    .filter((f) => relPath(f) !== 'src/db-mode.js')
    .filter((f) => requirePattern.test(fs.readFileSync(f, 'utf8')))
    .map(relPath)
    .sort();

  assert.deepEqual(actualRequirers, [...ALLOWED_DB_MODE_REQUIRERS].sort(),
    'the set of files requiring src/db-mode.js must be exactly {server.js, src/db.js} -- every other production ' +
    'entrypoint reaches the same decision indirectly via db.init()/pipeline.init(), never by requiring the ' +
    'resolver module a second, independent time');
});

// ── No independent re-implementation of USE_SUPABASE boolean coercion ──────

// The exact shape of the pre-T3F defect: USE_SUPABASE put through
// .toLowerCase() and compared against the literal string "true"/"false",
// scoped tightly to lines that actually mention USE_SUPABASE (not any
// unrelated .toLowerCase() === '...' idiom elsewhere in the codebase, e.g.
// team-name matching) -- if this reappears outside src/db-mode.js, it is
// either a duplicate (soon-to-diverge) implementation of the same
// decision, or a brand new one nobody reviewed for the production
// fail-closed contract.
const COERCION_LINE_PATTERN = /USE_SUPABASE[\s\S]{0,40}\.toLowerCase\(\)\s*[=!]==\s*['"](?:true|false)['"]/;

// src/scrape-handedness-cli.js's one pre-existing exception: an
// informational-only warning (never gates which repository is used, never
// reached by db.js/db-mode.js) telling an operator their teamId looks like
// a Supabase UUID while USE_SUPABASE isn't 'true'. Verified by requiring
// the exact surrounding context ("looksLikeUuid") to still be present, so
// this fails if the code drifts into an actual mode decision.
function isReviewedScrapeHandednessException(source) {
  return /looksLikeUuid[\s\S]{0,160}USE_SUPABASE[\s\S]{0,40}\.toLowerCase\(\)\s*!==\s*['"]true['"]/.test(source);
}

test('no production file other than src/db-mode.js re-implements USE_SUPABASE boolean coercion ' +
     '(USE_SUPABASE run through .toLowerCase() === / !== "true"/"false") -- the one reviewed, non-mode-selecting ' +
     'exception in src/scrape-handedness-cli.js is checked by its exact surrounding context, not a blanket file exclusion', () => {
  const offenders = [];
  for (const file of productionFiles()) {
    const rel = relPath(file);
    if (rel === 'src/db-mode.js') continue;
    const source = fs.readFileSync(file, 'utf8');
    if (!COERCION_LINE_PATTERN.test(source)) continue;
    if (rel === 'src/scrape-handedness-cli.js' && isReviewedScrapeHandednessException(source)) continue;
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `USE_SUPABASE-style boolean coercion re-implemented outside src/db-mode.js in: ${offenders.join(', ')}`);
});

// ── The gate runs before any tenant work, by source position ───────────────

function firstIndex(source, patterns) {
  for (const p of patterns) {
    const i = source.search(p);
    if (i !== -1) return i;
  }
  return -1;
}

test('server.js: resolveDatabaseMode() is called before app.listen() -- so a production process with invalid ' +
     'database-mode configuration crashes before accepting a single HTTP request, before any route (including ' +
     'every job/report-spawning route) can ever run', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  const gateIndex = source.indexOf('resolveDatabaseMode()');
  const listenIndex = source.indexOf('app.listen(');
  assert.notEqual(gateIndex, -1, 'server.js must call resolveDatabaseMode()');
  assert.notEqual(listenIndex, -1, 'server.js must call app.listen()');
  assert.ok(gateIndex < listenIndex, 'resolveDatabaseMode() must be called before app.listen()');
});

test('src/db.js#init(): resolveDatabaseMode() is called before the SQLite branch opens a database file and ' +
     'before the Supabase branch requires db-supabase.js -- so init() itself can never reach either repository ' +
     'without the gate having already succeeded', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'db.js'), 'utf8');
  const gateIndex = source.indexOf('resolveDatabaseMode()');
  const sqliteIndex = firstIndex(source, [/new Database\(/]);
  const supabaseRequireIndex = source.indexOf("require('./db-supabase')");
  assert.notEqual(gateIndex, -1, 'src/db.js must call resolveDatabaseMode()');
  assert.notEqual(sqliteIndex, -1, 'src/db.js must open a SQLite database somewhere');
  assert.notEqual(supabaseRequireIndex, -1, 'src/db.js must require ./db-supabase somewhere');
  assert.ok(gateIndex < sqliteIndex, 'resolveDatabaseMode() must be called before the SQLite database is opened');
  assert.ok(gateIndex < supabaseRequireIndex, 'resolveDatabaseMode() must be called before db-supabase.js is required');
});
