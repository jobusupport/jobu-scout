'use strict';

// Security Slice T3G: src/scrape-game-urls.js#getGameUrls()/markProcessed()
// used to open voodoo-scout.db directly with no organization context at
// all -- team_game_urls has no org_id column, so the raw
// `WHERE team_id = ?` query these functions issued could read or update
// any organization's rows, and the script never even checked
// JOBU_JOB_ORG_ID. This file proves, at the actual OS-process boundary
// (the same technique test/report-org-context-fail-closed.test.js already
// established for generate-report.js), that the fixed script now:
//   - requires JOBU_JOB_ORG_ID before any database work, the same
//     fail-closed contract every other tenant-facing job entrypoint
//     (reingest-games.js, generate-report.js) already has;
//   - never opens SQLite directly (require('better-sqlite3') is gone from
//     this file's source);
//   - never re-introduces a global, unscoped team-game-url enumeration API.
//
// Run with: node --test test/scrape-game-urls-org-context.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'src', 'scrape-game-urls.js');
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');

// src/gc-session-loader.js#getStorageStatePath() -- called unconditionally
// at this file's module top level, before require.main===module or any
// argument/org-context check -- fails closed in test mode unless
// GC_AUTH_FILE_PATH is set explicitly (see test/gc-session-loader.test.js).
// A synthetic, nonexistent path (same convention test/gc-network-isolation.test.js
// already uses) satisfies that unrelated check without touching a real
// session file, so it never masks the org-context/database assertions
// these tests actually exist to prove.
const SYNTHETIC_GC_AUTH_FILE_PATH = path.join(__dirname, 'this-fixture-does-not-exist-synthetic.json');

function runChild(args, envOverrides) {
  const env = { ...process.env, GC_AUTH_FILE_PATH: SYNTHETIC_GC_AUTH_FILE_PATH, ...envOverrides };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`scrape-game-urls.js did not exit within the bound.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function assertFailedClosedBeforeDatabaseActivity({ code, stdout, stderr }) {
  const combined = stdout + stderr;
  assert.notEqual(code, 0, 'the process must exit with a failure, not silently succeed or hang');
  assert.doesNotMatch(combined, /\[db\]/, 'db.js#init() must never have logged -- it must never have run');
  assert.doesNotMatch(combined, /\[db-supabase\]/, 'db-supabase.js#init() must never have logged -- no Supabase client may have been constructed');
  assert.doesNotMatch(combined, /Found \d+ game URL/, 'the team/URL lookup must never have run');
}

// ── Fails closed before any database activity ──────────────────────────────

test('scrape-game-urls.js (real child process): missing JOBU_JOB_ORG_ID fails closed before any database activity', async () => {
  const env = { NODE_ENV: 'test' };
  delete env.JOBU_JOB_ORG_ID;
  const result = await runChild(['Some Team Name'], env);
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stderr, /OrgContextRequiredError|JOBU_JOB_ORG_ID is required/, 'must fail via the established job-org-context contract, the same one reingest-games.js and generate-report.js use');
}, { timeout: 20000 });

test('scrape-game-urls.js (real child process): blank JOBU_JOB_ORG_ID fails closed before any database activity', async () => {
  const result = await runChild(['Some Team Name'], { NODE_ENV: 'test', JOBU_JOB_ORG_ID: '   ' });
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stderr, /OrgContextRequiredError|JOBU_JOB_ORG_ID is required/, 'must fail via the established job-org-context contract');
}, { timeout: 20000 });

test('scrape-game-urls.js (real child process): malformed (non-UUID) JOBU_JOB_ORG_ID fails closed before any database activity', async () => {
  const result = await runChild(['Some Team Name'], { NODE_ENV: 'test', JOBU_JOB_ORG_ID: 'not-a-real-uuid' });
  assertFailedClosedBeforeDatabaseActivity(result);
}, { timeout: 20000 });

test('scrape-game-urls.js (real child process): missing team name argument fails closed before org-context or database work', async () => {
  const result = await runChild([], { NODE_ENV: 'test' });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /Usage: node src\/scrape-game-urls\.js/);
}, { timeout: 20000 });

// ── Structural: the direct SQLite bypass is gone, no new global API ────────

test('scrape-game-urls.js no longer requires better-sqlite3 directly', () => {
  assert.doesNotMatch(SCRIPT_SRC, /require\(\s*['"]better-sqlite3['"]\s*\)/, 'the direct, unscoped SQLite bypass must be removed');
});

test('scrape-game-urls.js requires the shared repository module (./db) and the shared job-org-context helper, not a competing selector', () => {
  assert.match(SCRIPT_SRC, /require\(\s*['"]\.\/db['"]\s*\)/, 'must route through src/db.js, the single T3F-gated repository selector');
  assert.match(SCRIPT_SRC, /require\(\s*['"]\.\/job-org-context['"]\s*\)/, 'must use the same requireJobOrgContext() contract as reingest-games.js/generate-report.js');
});

test('scrape-game-urls.js does not define its own USE_SUPABASE/NODE_ENV production-detection logic (no competing database selector)', () => {
  assert.doesNotMatch(SCRIPT_SRC, /process\.env\.USE_SUPABASE/, 'database-mode selection belongs to src/db-mode.js alone');
});

test('getGameUrlsForTeamInOrg/markGameUrlProcessedForOrg are not added to the T3E operator-wide allowlist -- they remain tenant-scoped, not operator-wide', () => {
  const boundarySrc = fs.readFileSync(path.join(REPO_ROOT, 'test', 'team-enumeration-api-boundary.test.js'), 'utf8');
  assert.doesNotMatch(boundarySrc, /getGameUrlsForTeamInOrg/, 'a tenant-scoped method must never be folded into the operator-wide allowlist');
  assert.doesNotMatch(boundarySrc, /markGameUrlProcessedForOrg/, 'a tenant-scoped method must never be folded into the operator-wide allowlist');
});

test('no new global (org-less) team-game-url enumeration function was introduced anywhere in production source', () => {
  const productionFiles = [];
  const EXCLUDED = new Set(['node_modules', '.git', 'output', 'temp-screenshots', 'storage']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        productionFiles.push(path.join(dir, entry.name));
      }
    }
  })(REPO_ROOT);

  const offenders = productionFiles
    .filter((f) => !path.relative(REPO_ROOT, f).split(path.sep).join('/').startsWith('test/'))
    .filter((f) => /function\s+getAllGameUrls\b|function\s+getGameUrlsForTeam\b(?!InOrg)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], `an org-less team-game-url enumeration function was introduced in: ${offenders.map((f) => path.relative(REPO_ROOT, f)).join(', ')}`);
});
