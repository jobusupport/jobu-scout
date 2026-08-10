'use strict';

// Security Slice T3F: proves the fail-closed database-mode contract
// (src/db-mode.js) at the actual OS-process boundary, not merely inside
// whatever process node:test happens to run in. A module-level mock is not
// sufficient proof that an executable process refuses to listen or touch
// tenant data -- these tests spawn the REAL server.js and REAL production
// entrypoints exactly as server.js/an operator would invoke them, the same
// technique test/report-org-context-fail-closed.test.js already
// established for the JOBU_JOB_ORG_ID contract.
//
// Every test here sets NODE_ENV=production explicitly on the child's
// environment -- never on this test process's own process.env -- so a
// failure here can never leak a production-mode window to any other test
// in this suite.
//
// Run with: node --test test/db-mode-startup-boundary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'server.js');
const GENERATE_REPORT_PATH = path.join(REPO_ROOT, 'src', 'generate-report.js');
const RECALCULATE_ALL_TEAMS_PATH = path.join(REPO_ROOT, 'src', 'recalculate-all-teams.js');
const CHECK_GAME_DATE_INTEGRITY_PATH = path.join(REPO_ROOT, 'src', 'check-game-date-integrity.js');

const FAKE_URL = 'https://example.invalid';
const FAKE_ANON_KEY = 'synthetic-anon-key-not-real';
const FAKE_SERVICE_KEY = 'synthetic-service-role-key-not-real';
const VALID_JOB_ORG_ID = '99999999-9999-4999-8999-999999999999';

function runChild(scriptPath, args, envOverrides) {
  const env = { ...process.env, ...envOverrides };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(scriptPath)} did not exit within the bound.\nstdout: ${stdout}\nstderr: ${stderr}`));
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

// ── Server.js: a production HTTP entrypoint fails before listening ─────────

function assertServerNeverListened({ code, stdout, stderr }) {
  const combined = stdout + stderr;
  assert.notEqual(code, 0, 'server.js must exit with a failure, not silently succeed or hang');
  assert.doesNotMatch(combined, /Voodoo Scout Dashboard/, 'app.listen() must never have run -- the process must crash before accepting any HTTP work');
  assert.doesNotMatch(combined, /http:\/\/localhost:\d+/, 'the listening banner must never print');
}

function assertNoSecretsLeaked(output) {
  assert.doesNotMatch(output, new RegExp(FAKE_SERVICE_KEY), 'the Supabase service-role key must never appear in process output');
  assert.doesNotMatch(output, new RegExp(FAKE_ANON_KEY), 'the Supabase anon key must never appear in process output');
}

test('server.js (real child process): production with USE_SUPABASE missing fails closed before listening', async () => {
  const env = { NODE_ENV: 'production', DASHBOARD_PORT: '48601', GC_AUTH_JSON: '' };
  delete env.USE_SUPABASE;
  const result = await runChild(SERVER_PATH, [], env);
  assertServerNeverListened(result);
  assert.match(result.stdout + result.stderr, /DatabaseModeConfigError|USE_SUPABASE=true/, 'must fail via the T3F database-mode contract, not an unrelated crash');
}, { timeout: 20000 });

test('server.js (real child process): production with USE_SUPABASE blank fails closed before listening', async () => {
  const result = await runChild(SERVER_PATH, [], {
    NODE_ENV: 'production', USE_SUPABASE: '   ', DASHBOARD_PORT: '48602', GC_AUTH_JSON: '',
  });
  assertServerNeverListened(result);
}, { timeout: 20000 });

test('server.js (real child process): production with USE_SUPABASE=false fails closed before listening (never falls back to SQLite)', async () => {
  const result = await runChild(SERVER_PATH, [], {
    NODE_ENV: 'production', USE_SUPABASE: 'false', DASHBOARD_PORT: '48603', GC_AUTH_JSON: '',
  });
  assertServerNeverListened(result);
}, { timeout: 20000 });

test('server.js (real child process): production with a malformed USE_SUPABASE value fails closed before listening', async () => {
  const result = await runChild(SERVER_PATH, [], {
    NODE_ENV: 'production', USE_SUPABASE: 'ture', DASHBOARD_PORT: '48604', GC_AUTH_JSON: '',
  });
  assertServerNeverListened(result);
}, { timeout: 20000 });

test('server.js (real child process): production with USE_SUPABASE=true but missing SUPABASE_URL fails closed before listening', async () => {
  const env = {
    NODE_ENV: 'production', USE_SUPABASE: 'true', DASHBOARD_PORT: '48605', GC_AUTH_JSON: '',
    SUPABASE_ANON_KEY: FAKE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY,
  };
  delete env.SUPABASE_URL;
  const result = await runChild(SERVER_PATH, [], env);
  assertServerNeverListened(result);
  assertNoSecretsLeaked(result.stdout + result.stderr);
}, { timeout: 20000 });

test('server.js (real child process): the error output for a production failure never contains the configured Supabase credentials', async () => {
  const env = {
    NODE_ENV: 'production', USE_SUPABASE: 'true', DASHBOARD_PORT: '48606', GC_AUTH_JSON: '',
    SUPABASE_URL: FAKE_URL, SUPABASE_ANON_KEY: FAKE_ANON_KEY,
  };
  delete env.SUPABASE_SERVICE_ROLE_KEY; // deliberately missing -- fails closed, not merely blank
  const result = await runChild(SERVER_PATH, [], env);
  assertServerNeverListened(result);
  assertNoSecretsLeaked(result.stdout + result.stderr);
}, { timeout: 20000 });

// ── generate-report.js: a production report/job subprocess fails before ───
// ── tenant work when database-mode validation fails ────────────────────────

function assertFailedClosedBeforeDatabaseActivity({ code, stdout, stderr }) {
  const combined = stdout + stderr;
  assert.notEqual(code, 0, 'the process must exit with a failure, not silently succeed or hang');
  assert.doesNotMatch(combined, /\[db\]/, 'db.js#init() must never have logged -- it must never have run');
  assert.doesNotMatch(combined, /\[db-supabase\]/, 'db-supabase.js#init() must never have logged -- no Supabase client may have been constructed');
  assert.doesNotMatch(combined, /Teams in Voodoo Scout DB/, 'a team query must never have run');
  assert.doesNotMatch(combined, /Generating report:/, 'report generation must never have started');
}

test('generate-report.js (real child process): production with valid JOBU_JOB_ORG_ID but USE_SUPABASE missing fails closed before any database activity', async () => {
  const env = { NODE_ENV: 'production', JOBU_JOB_ORG_ID: VALID_JOB_ORG_ID };
  delete env.USE_SUPABASE;
  env.REPORTS_DIR = path.join(require('os').tmpdir(), 'jobu-scout-test-reports-should-never-be-created');
  const result = await runChild(GENERATE_REPORT_PATH, ['--list'], env);
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stdout + result.stderr, /DatabaseModeConfigError|USE_SUPABASE=true/, 'must fail via the T3F database-mode contract');
}, { timeout: 20000 });

test('generate-report.js (real child process): production with USE_SUPABASE=false fails closed before any database activity (never falls back to SQLite)', async () => {
  const env = {
    NODE_ENV: 'production', JOBU_JOB_ORG_ID: VALID_JOB_ORG_ID, USE_SUPABASE: 'false',
    REPORTS_DIR: path.join(require('os').tmpdir(), 'jobu-scout-test-reports-should-never-be-created'),
  };
  const result = await runChild(GENERATE_REPORT_PATH, ['--list'], env);
  assertFailedClosedBeforeDatabaseActivity(result);
}, { timeout: 20000 });

test('generate-report.js (real child process): JOBU_JOB_ORG_ID validation still runs first -- a missing org id fails via the org-context contract even in production, not the database-mode contract', async () => {
  const env = { NODE_ENV: 'production', USE_SUPABASE: 'false' };
  delete env.JOBU_JOB_ORG_ID;
  env.REPORTS_DIR = path.join(require('os').tmpdir(), 'jobu-scout-test-reports-should-never-be-created');
  const result = await runChild(GENERATE_REPORT_PATH, ['--list'], env);
  assertFailedClosedBeforeDatabaseActivity(result);
  assert.match(result.stderr, /OrgContextRequiredError|JOBU_JOB_ORG_ID is required/, 'org-context validation runs before database-mode validation, unchanged from T3D');
}, { timeout: 20000 });

// ── Operator-maintenance script: cannot accidentally choose SQLite in ──────
// ── production/hosted mode ──────────────────────────────────────────────────

test('recalculate-all-teams.js (real child process, operator-only maintenance script): production with USE_SUPABASE missing fails closed rather than silently touching the local SQLite file', async () => {
  const env = { NODE_ENV: 'production' };
  delete env.USE_SUPABASE;
  const result = await runChild(RECALCULATE_ALL_TEAMS_PATH, [], env);
  assert.notEqual(result.code, 0, 'must exit non-zero rather than silently operating on SQLite');
  assert.doesNotMatch(result.stdout + result.stderr, /\[db\] USE_SUPABASE = false/, 'must never have resolved to the SQLite repository');
  assert.doesNotMatch(result.stdout + result.stderr, /No teams found\.|Done\. Regenerate reports/, 'must never have reached team enumeration or completion');
}, { timeout: 20000 });

// check-game-date-integrity.js is used (not recalculate-all-teams.js) for
// the positive/local-dev SQLite case below because it is diagnostic-only
// (never writes) and honors SQLITE_DB_PATH -- letting this test point at
// an isolated, freshly-created, empty temp database file instead of ever
// touching this checkout's real voodoo-scout.db.
// fn is async -- awaits its returned promise BEFORE cleanup runs (a bare
// try/finally would call fs.rmSync immediately after starting fn(), while
// the spawned child is still creating the database file inside dir, the
// same pitfall test/gc-session-loader.test.js's withTempDirAsync already
// documents and avoids).
async function withTempSqliteDbPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-scout-t3f-test-'));
  const dbPath = path.join(dir, 'isolated-test.db');
  try {
    return await fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('check-game-date-integrity.js (real child process, operator-only maintenance script): local development (NODE_ENV unset) with no USE_SUPABASE resolves to SQLite -- the pre-existing operator default is unchanged, against an isolated temp database, never this checkout\'s real voodoo-scout.db', async () => {
  await withTempSqliteDbPath(async (dbPath) => {
    const env = { ...process.env, SQLITE_DB_PATH: dbPath };
    delete env.NODE_ENV;
    delete env.USE_SUPABASE;
    const result = await runChild(CHECK_GAME_DATE_INTEGRITY_PATH, [], env);
    assert.equal(result.code, 0, 'a fresh, empty, isolated SQLite database is a legitimate no-op run');
    assert.match(result.stdout + result.stderr, /\[db\] USE_SUPABASE = false/, 'local/operator default must still resolve to SQLite without requiring a new explicit flag');
    assert.match(result.stdout, /No teams found\./, 'a fresh isolated database has no teams');
  });
}, { timeout: 20000 });

test('check-game-date-integrity.js (real child process): production with USE_SUPABASE missing fails closed rather than silently touching SQLite, even with SQLITE_DB_PATH set', async () => {
  await withTempSqliteDbPath(async (dbPath) => {
    const env = { ...process.env, SQLITE_DB_PATH: dbPath, NODE_ENV: 'production' };
    delete env.USE_SUPABASE;
    const result = await runChild(CHECK_GAME_DATE_INTEGRITY_PATH, [], env);
    assert.notEqual(result.code, 0, 'must exit non-zero rather than silently operating on SQLite in production');
    assert.doesNotMatch(result.stdout + result.stderr, /\[db\] USE_SUPABASE = false/, 'must never have resolved to the SQLite repository');
    assert.doesNotMatch(result.stdout + result.stderr, /No teams found\./, 'must never have reached team enumeration');
  });
}, { timeout: 20000 });
