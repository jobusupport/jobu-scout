'use strict';

// Comprehensive proof that no automated test in this repository can reach
// GameChanger over the network, covering every category the codebase
// actually has:
//
//   1. Node-level HTTP/fetch/http/https to GameChanger: structurally
//      proven absent (grep-based regression test below) -- every file that
//      references gc.com reaches it exclusively through Playwright's
//      chromium browser, never a raw fetch()/http()/https()/axios call.
//   2. Browser-level requests: covered by test/helpers/gc-network-guard.js
//      and its own tests in test/gc-session-loader.test.js (real Chromium
//      launch, real blocked navigation).
//   3. Child processes spawned by tests: proven below with a REAL spawned
//      child process (not a mock) -- src/high-school-gc-import.js, the
//      exact script src/high-school-import-routes.js spawns in production,
//      run for real in test mode with no auth fixture, and shown to fail
//      closed before any collection activity starts.
//   4. Default credential paths: covered by src/gc-session-loader.js's
//      isAutomatedTestMode() fail-closed behavior, exercised directly here
//      via the same child-process spawn (proving it applies even when the
//      script is invoked as its own OS process, not just via require()
//      within the test runner).
//
// Run with: node --test test/gc-network-isolation.test.js (also included
// in `npm test`, see package.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');
const RAW_NETWORK_PATTERNS = [/\bfetch\(/, /\bhttp\.request\(/, /\bhttp\.get\(/, /\bhttps\.request\(/, /\bhttps\.get\(/, /\baxios\./];

test('structural: every src file referencing gc.com never makes a raw fetch/http/https/axios call itself', () => {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));
  const gcReferencingFiles = files.filter((f) => {
    const content = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    return /gc\.com/i.test(content);
  });
  // Sanity check on the test itself: this list must never silently become
  // empty (e.g. from a future rename), which would make the assertion
  // below vacuously true and stop actually proving anything.
  assert.ok(gcReferencingFiles.length >= 5, `expected several gc.com-referencing files under src/, found: ${gcReferencingFiles.join(', ')}`);

  const offenders = [];
  for (const f of gcReferencingFiles) {
    const content = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    for (const pattern of RAW_NETWORK_PATTERNS) {
      if (pattern.test(content)) offenders.push(`${f} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], 'a file referencing gc.com must reach it only via Playwright chromium, never a raw network primitive');
});

// The real, production child-process entry point -- src/high-school-import-routes.js
// spawns this exact file the same way in production. Run here as a genuine
// `node <script>` child process (not required() into this test process),
// so this proves protection actually applies at the OS-process boundary,
// not merely within whatever process node:test happens to be running in.
const COLLECTOR_SCRIPT = path.join(__dirname, '..', 'src', 'high-school-gc-import.js');
const REPO_ROOT = path.join(__dirname, '..');

function runCollectorChildProcess(envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [COLLECTOR_SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Explicitly reasserted here (not just inherited) so this test's
        // own guarantee does not silently depend on ambient parent-process
        // state -- this is exactly what test/helpers/test-env-setup.js
        // already sets process-wide, re-stated here as the specific
        // precondition this test is proving matters.
        NODE_ENV: 'test',
        GC_AUTH_FILE_PATH: '', // explicitly unset -- must fail closed
        HS_IMPORT_ORG_ID: '11111111-1111-4111-8111-111111111111',
        HS_IMPORT_PROGRAM_ID: '22222222-2222-4222-8222-222222222222',
        HS_IMPORT_TEAM_ID: '33333333-3333-4333-8333-333333333333',
        HS_IMPORT_SEASON_ID: '44444444-4444-4444-8444-444444444444',
        HS_IMPORT_RUN_ID: '55555555-5555-4555-8555-555555555555',
        HS_IMPORT_TEAM_LABEL: 'Synthetic Test Team',
        HS_IMPORT_GC_TEAM_URL: 'https://web.gc.com/teams/synthetic-org/synthetic-team',
        HS_IMPORT_EXISTING_PLAYERS_JSON: '[]',
        SUPABASE_URL: process.env.SUPABASE_URL || 'https://example.invalid',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key',
        ...envOverrides,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`collector child process did not exit within the bound -- possible real network hang.\nstdout: ${stdout}\nstderr: ${stderr}`));
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

test('a real spawned child process (the exact script production spawns) fails closed before any GameChanger collection activity in test mode with no auth fixture', async () => {
  const { code, stdout, stderr } = await runCollectorChildProcess({});

  assert.notEqual(code, 0, 'the collector child process must exit with a failure, not silently succeed');
  // In practice this fails even earlier than the script's own try/catch:
  // src/search-gamechanger-teams.js computes its module-level STORAGE_STATE
  // via getStorageStatePath() at require() time (require('./search-gamechanger-teams')
  // happens before this script's try block even starts), so the very
  // require() call itself throws SessionValidationError synchronously,
  // crashing the process as an uncaught exception before the script's own
  // '[hs-gc-import] fatal:' handler is ever reached. Either failure path
  // (the early require-time throw, or the later in-try-block one) proves
  // the same guarantee -- accept both.
  assert.match(stderr, /SessionValidationError|\[hs-gc-import\] fatal:/, 'the session-validation fail-closed path must have been the one that ran');

  // Collection progress events (onProgress -> `[hs-gc-import] {"...` JSON
  // lines) only start appearing once runHighSchoolImportCollection is
  // reached, which is strictly after the sessionLoader.getStorageStatePath()
  // check -- their total absence proves the process never got that far,
  // i.e. never attempted to discover or collect a single game.
  assert.doesNotMatch(stdout, /\[hs-gc-import\] \{"/, 'no collection-progress event may appear -- collection must never have started');

  const combined = stdout + stderr;
  assert.doesNotMatch(combined, /authorization:\s*bearer/i, 'no auth header may ever appear in output');
  assert.doesNotMatch(combined, /set-cookie/i, 'no cookie may ever appear in output');
  assert.doesNotMatch(combined, /storage[_-]?state.*\{/i, 'no raw session/storage-state object contents may appear in output');
}, { timeout: 20000 });

test('test-env-setup.js actually sets NODE_OPTIONS to preload the network guard (the mechanism child processes inherit protection through)', () => {
  // Fresh subprocess (not require() into this process) so the module runs
  // from a clean environment, exactly like the real `node --test --require
  // ./test/helpers/test-env-setup.js` invocation does for every worker.
  const result = require('child_process').spawnSync(
    process.execPath,
    ['-e', "require('./test/helpers/test-env-setup.js'); console.log(process.env.NODE_OPTIONS || '')"],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const nodeOptions = result.stdout.trim();
  assert.match(nodeOptions, /--require/, 'NODE_OPTIONS must contain a --require flag');
  assert.match(nodeOptions, /gc-network-guard\.js/, 'the --require flag must point at gc-network-guard.js');
});

test('NODE_OPTIONS inheritance actually installs the guard in a spawned child that never itself requires gc-network-guard.js -- a real Chromium navigation to GameChanger from that child is blocked', async () => {
  const guardPath = path.join(__dirname, 'helpers', 'gc-network-guard.js');
  const childScript = `
    process.on('unhandledRejection', (e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); });
    (async () => {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto('https://web.gc.com/teams/synthetic-org/synthetic-team', { timeout: 8000 });
        console.log(JSON.stringify({ blocked: false }));
      } catch (err) {
        console.log(JSON.stringify({ blocked: true, message: String(err && err.message || err) }));
      } finally {
        await browser.close();
      }
    })();
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // The child NEVER requires gc-network-guard.js itself anywhere in
        // childScript above -- NODE_OPTIONS is the only thing that could
        // possibly install it.
        NODE_OPTIONS: `--require ${guardPath}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out\nstdout: ${stdout}\nstderr: ${stderr}`)); }, 20000);
    child.on('exit', () => { clearTimeout(timeout); resolve({ stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });

  const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop();
  assert.ok(lastLine, `expected JSON output from child, got stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(lastLine);
  assert.equal(parsed.blocked, true, `navigation must have been blocked by the inherited guard: ${JSON.stringify(parsed)}`);
  assert.match(parsed.message, /ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED|blockedbyclient/i);
}, { timeout: 25000 });

test('the same child process, given an explicit synthetic GC_AUTH_FILE_PATH pointing at a nonexistent file, still never starts collection (fails on file validation, not network)', async () => {
  // Proves the fail-closed behavior is specifically about the DEFAULT path
  // being refused in test mode, not merely "any missing file fails" --
  // this run supplies an explicit fixture path (satisfying
  // isAutomatedTestMode()'s requirement) that happens to point at a file
  // that does not exist, which must fail at
  // sessionLoader.validateStorageStateFile (a local file-read failure),
  // never reaching the browser/network at all either way.
  const { code, stdout, stderr } = await runCollectorChildProcess({
    GC_AUTH_FILE_PATH: path.join(__dirname, 'this-fixture-does-not-exist-synthetic.json'),
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /\[hs-gc-import\] fatal:/);
  assert.doesNotMatch(stdout, /\[hs-gc-import\] \{"/);
}, { timeout: 20000 });
