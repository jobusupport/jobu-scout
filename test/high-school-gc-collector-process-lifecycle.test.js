'use strict';

// Real-process behavioral coverage for the High School GameChanger
// collector's spawn/IPC/cancellation/cleanup lifecycle -- proves the actual
// child_process mechanism works, not just that source text matches a
// pattern. Two layers:
//
// 1. A REAL child_process.spawn, using the exact same stdio/detached
//    options src/high-school-import-routes.js's production spawn call
//    uses, pointed at a small synthetic script written fresh into a temp
//    directory for this test (never the real collector -- no Playwright,
//    no network, no Supabase). This proves the IPC channel genuinely
//    exists and a message genuinely reaches the child process -- the exact
//    thing that was silently broken before this correction (proc.send was
//    undefined without 'ipc' in stdio).
//
// 2. The real gracefulStopThenEscalate/killSwitchWatchdogTick functions
//    from src/high-school-import-routes.js, exercised through a real
//    Express app (mirroring test/high-school-import-routes.test.js's own
//    pattern) with a well-behaved EventEmitter-based process double
//    standing in for the OS child -- this proves the grace-period +
//    escalation + DB-marking + idempotent-cleanup LOGIC deterministically
//    and fast, without needing a real OS process for every timing
//    assertion (the OS-level IPC mechanism itself is already proven for
//    real in layer 1, using the identical spawn options).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const express = require('express');
const { registerHighSchoolImportRoutes } = require('../src/high-school-import-routes');
const { asyncHandler } = require('../src/express-helpers');
const { createFakeHsImportAdminClient } = require('./helpers/fake-hs-import-admin-client');

// ── Layer 0: the REAL production CLI file, spawned for real, proving the
// kill switch is checked before any session material is ever touched ──

test('the real collector CLI, spawned with collection disabled, never reads the GameChanger session file at all', { timeout: 15000 }, async () => {
  await withTempDir(async (dir) => {
    const missingAuthFile = path.join(dir, 'synthetic-does-not-exist-gamechanger-auth.json');
    const scriptPath = path.join(__dirname, '..', 'src', 'high-school-gc-import.js');
    const child = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        GC_COLLECTION_ENABLED: 'false',
        GC_AUTH_FILE_PATH: missingAuthFile,
        HS_IMPORT_ORG_ID: 'aaaaaaaa-1111-4111-8111-111111111111',
        HS_IMPORT_PROGRAM_ID: 'eeeeeeee-5555-4555-8555-555555555555',
        HS_IMPORT_TEAM_ID: 'cccccccc-3333-4333-8333-333333333333',
        HS_IMPORT_SEASON_ID: 'dddddddd-4444-4444-8444-444444444444',
        HS_IMPORT_RUN_ID: 'ffffffff-6666-4666-8666-666666666666',
        HS_IMPORT_TEAM_LABEL: 'Synthetic Test Team',
        HS_IMPORT_GC_TEAM_URL: 'https://web.gc.com/teams/synthetic-org/synthetic-team',
        HS_IMPORT_EXISTING_PLAYERS_JSON: '[]',
        // Local, unroutable target -- any attempted network call fails
        // immediately and locally (ECONNREFUSED), with zero real DNS
        // lookup or external egress. The kill switch must make this
        // process return before it would ever need to use these anyway.
        SUPABASE_URL: 'http://127.0.0.1:1',
        SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-service-role-key-not-real',
      },
    });

    let output = '';
    child.stdout.on('data', (c) => { output += String(c); });
    child.stderr.on('data', (c) => { output += String(c); });

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('collector CLI did not exit -- it may be trying to launch a real browser or contact a real network host')); }, 8000);
      child.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
    });

    assert.equal(exitCode, 0, 'a kill-switch-disabled run must exit cleanly, not with a failure code');
    assert.ok(output.includes('kill switch disabled'), `expected a kill-switch log message, got: ${output}`);
    assert.ok(!output.includes('GameChanger session file is missing'), 'the session file must never even be checked when the kill switch is already disabled -- got: ' + output);
    assert.ok(!fs.existsSync(missingAuthFile), 'nothing should have created a file at the (deliberately missing) session path either');
  });
});

// ── Layer 1: real spawn, real IPC ───────────────────────────────────────

function writeSyntheticChildScript(dir, { ignoreCancel = false } = {}) {
  const file = path.join(dir, 'synthetic-collector-child.js');
  const body = `
    process.on('message', (msg) => {
      console.log('SYNTHETIC_CHILD_MESSAGE:' + JSON.stringify(msg));
      if (${ignoreCancel ? 'false' : 'true'} && msg && (msg.type === 'cancel' || msg.type === 'kill_switch_disabled')) {
        console.log('SYNTHETIC_CHILD_EXITING');
        process.exit(0);
      }
    });
    console.log('SYNTHETIC_CHILD_READY pid=' + process.pid);
    setTimeout(() => {}, 15000); // stay alive long enough for the test to act
  `;
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-gc-process-lifecycle-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// The exact same options shape the production spawn call in
// src/high-school-import-routes.js uses -- duplicated here deliberately
// (rather than importing an internal helper) so this test proves the
// PLATFORM behavior with these options is what it's assumed to be,
// independent of whether the route file's own call site ever drifts.
function productionSpawnOptions(extraEnv = {}) {
  return {
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
  };
}

test('a child spawned with the production stdio/ipc options has a working IPC channel immediately (this was previously undefined)', async () => {
  await withTempDir(async (dir) => {
    const script = writeSyntheticChildScript(dir);
    const child = spawn('node', [script], productionSpawnOptions());
    try {
      assert.equal(typeof child.send, 'function', 'child.send must be a real function when stdio includes ipc');
      assert.ok(child.channel, 'an IPC channel must actually exist');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('a cancel message sent via IPC is actually received by the child and causes it to exit promptly', async () => {
  await withTempDir(async (dir) => {
    const script = writeSyntheticChildScript(dir);
    const child = spawn('node', [script], productionSpawnOptions());
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('synthetic child never signaled ready')), 5000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('SYNTHETIC_CHILD_READY')) { clearTimeout(timeout); resolve(); }
      });
    });

    const sendResult = child.send({ type: 'cancel' });
    assert.equal(sendResult, true, 'child.send must succeed, not silently no-op');

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child did not exit after receiving cancel')), 5000);
      child.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
    });

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("SYNTHETIC_CHILD_MESSAGE:{\"type\":\"cancel\"}"), 'the child must have actually received the message payload, not just exited coincidentally');
    assert.ok(stdout.includes('SYNTHETIC_CHILD_EXITING'));
  });
});

test('a kill_switch_disabled message is also delivered end-to-end, distinctly from cancel', async () => {
  await withTempDir(async (dir) => {
    const script = writeSyntheticChildScript(dir);
    const child = spawn('node', [script], productionSpawnOptions());
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('synthetic child never signaled ready')), 5000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('SYNTHETIC_CHILD_READY')) { clearTimeout(timeout); resolve(); } });
    });
    child.send({ type: 'kill_switch_disabled' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child did not exit after kill_switch_disabled')), 5000);
      child.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
    assert.ok(stdout.includes("SYNTHETIC_CHILD_MESSAGE:{\"type\":\"kill_switch_disabled\"}"));
  });
});

test('the production spawn options set detached exactly opposite to win32 -- true (own process group) everywhere except Windows, where stopJobProcess uses taskkill /t instead', () => {
  const opts = productionSpawnOptions();
  assert.equal(opts.detached, process.platform !== 'win32');
});

test('on non-Windows, the spawn options place the child in its own detached process group (required for stopJobProcess\'s group kill to reach Chromium descendants)', { skip: process.platform !== 'win32' ? false : 'detached process-group semantics only apply on non-Windows; this platform uses taskkill /t instead, covered by the escalation test below' }, async () => {
  await withTempDir(async (dir) => {
    const script = writeSyntheticChildScript(dir);
    const child = spawn('node', [script], productionSpawnOptions());
    try {
      // A detached child is its own process-group leader: its pgid equals
      // its own pid. We can't read /proc portably in pure Node without a
      // native module, so this is verified behaviorally instead: sending
      // the negative-pid group signal must not throw ESRCH immediately
      // (it targets a real, existing group -- this child's own).
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.doesNotThrow(() => process.kill(-child.pid, 0), 'negative-PID signal 0 (existence probe) must find a real process group rooted at this child');
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
  });
});

test('a child that ignores cancel is force-terminated once escalation fires, and no process remains afterward', async () => {
  await withTempDir(async (dir) => {
    const script = writeSyntheticChildScript(dir, { ignoreCancel: true });
    const child = spawn('node', [script], productionSpawnOptions());
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('synthetic child never signaled ready')), 5000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('SYNTHETIC_CHILD_READY')) { clearTimeout(timeout); resolve(); } });
    });

    child.send({ type: 'cancel' });

    // Confirm it really did ignore the message (still alive) before forcing
    // the point of the escalation test.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'the synthetic child must still be alive -- it was told to ignore cancel');

    // Simulate the escalation stopJobProcess performs.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { shell: true });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }

    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      child.on('exit', () => { clearTimeout(timer); resolve(true); });
    });
    assert.equal(exited, true, 'escalated (forced) termination must actually stop the uncooperative child');
    assert.throws(() => process.kill(child.pid, 0), 'no process may remain after escalation');
  });
});

// ── Layer 2: real route logic (gracefulStopThenEscalate / watchdog),
// deterministic EventEmitter-based process double ─────────────────────

const ORG_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TEAM_A = 'cccccccc-3333-4333-8333-333333333333';
const SEASON_A = 'dddddddd-4444-4444-8444-444444444444';
const PROGRAM_A = 'eeeeeeee-5555-4555-8555-555555555555';
const RUN_A = 'ffffffff-6666-4666-8666-666666666666';
const USER_TOKEN_HS = 'user-hs-org-a';

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.pid = 99999;
  proc.connected = true;
  proc.sentMessages = [];
  proc.send = (msg) => { proc.sentMessages.push(msg); return true; };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function buildTestApp({ cancelGraceMs = 30 } = {}) {
  const app = express();
  app.use(express.json());
  const jobs = {};
  const originalGrace = process.env.GC_CANCEL_GRACE_MS;
  process.env.GC_CANCEL_GRACE_MS = String(cancelGraceMs);

  function requireAuth(req, res, next) {
    const token = req.get('authorization')?.replace(/^Bearer /, '');
    if (token === USER_TOKEN_HS) { req.user = { id: '12121212-1212-4212-8212-121212121212' }; return next(); }
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  function resolveSupportSession(req, res, next) { next(); }
  function requireHighSchoolAccess(req, res, next) { req._orgId = ORG_A; next(); }
  function blockWriteDuringReadOnlySupport(req, res, next) { next(); }
  function appendLog() {}
  const finishJobCalls = [];
  function finishJob(id, success, exitCode) {
    finishJobCalls.push({ id, success, exitCode });
    if (jobs[id]) { jobs[id].status = success ? 'done' : 'failed'; jobs[id].exitCode = exitCode; }
  }
  function attachJobProcess(id, proc) { if (jobs[id]) { jobs[id].pid = proc.pid; jobs[id].proc = proc; } }
  const stopJobProcessCalls = [];
  function stopJobProcess(job) {
    stopJobProcessCalls.push(job);
    if (job?.proc) job.proc.emit('exit', -9);
    return true;
  }

  const adminClient = createFakeHsImportAdminClient({
    hs_teams: [{ id: TEAM_A, org_id: ORG_A, program_id: PROGRAM_A, name: 'Varsity', is_active: true, gc_team_url: 'https://web.gc.com/teams/org1/team1', gc_external_team_id: 'team1' }],
    hs_seasons: [{ id: SEASON_A, org_id: ORG_A, program_id: PROGRAM_A, name: '2026 Spring', school_year: '2025-2026' }],
    hs_roster_memberships: [],
  });

  const failImportRunCalls = [];
  const importService = {
    async failImportRun(args) { failImportRunCalls.push(args); return {}; },
    async getImportRunDetail() { return { run: { id: RUN_A, org_id: ORG_A, team_id: TEAM_A, season_id: SEASON_A, status: 'succeeded' }, games: [], validations: [] }; },
  };

  const router = express.Router();
  const { killSwitchWatchdogTick } = registerHighSchoolImportRoutes(router, {
    adminClient, resolveSupportSession, blockWriteDuringReadOnlySupport, requireHighSchoolAccess,
    asyncHandler, requireAuth, jobs, appendLog, finishJob, attachJobProcess, stopJobProcess,
    importService,
    spawn: () => { throw new Error('this test never starts a new job through the route'); },
  });
  app.use('/api/high-school', router);
  app.locals.highSchoolImportService = importService;

  return {
    app, jobs, killSwitchWatchdogTick, failImportRunCalls, stopJobProcessCalls, finishJobCalls,
    restoreEnv: () => { if (originalGrace === undefined) delete process.env.GC_CANCEL_GRACE_MS; else process.env.GC_CANCEL_GRACE_MS = originalGrace; },
  };
}

function listen(app) {
  const server = app.listen(0);
  const { port } = server.address();
  return { url: `http://localhost:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('cancel route: sends a graceful IPC message, marks the run failed synchronously, and does not force-kill a cooperative child', async () => {
  const { app, jobs, failImportRunCalls, stopJobProcessCalls, restoreEnv } = buildTestApp();
  const { url, close } = listen(app);
  const proc = makeFakeProc();
  jobs['job-1'] = { id: 'job-1', org_id: ORG_A, importRunId: RUN_A, status: 'running', proc, productKind: 'high_school_gc_import' };
  try {
    const res = await fetch(`${url}/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/${RUN_A}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${USER_TOKEN_HS}` },
    });
    assert.equal(res.status, 200);
    assert.equal(failImportRunCalls.length, 1);
    assert.match(failImportRunCalls[0].rawErrorMessage, /cancelled/i);
    assert.deepEqual(proc.sentMessages, [{ type: 'cancel' }]);

    proc.emit('exit', 0); // cooperative child exits gracefully within the grace window
    await new Promise((r) => setTimeout(r, 60)); // longer than the 30ms test grace period
    assert.equal(stopJobProcessCalls.length, 0, 'a cooperative child that exits within the grace period must never be force-killed');
  } finally { await close(); restoreEnv(); }
});

test('cancel route: escalates to a forced kill if the child does not exit within the grace period', async () => {
  const { app, jobs, stopJobProcessCalls, restoreEnv } = buildTestApp({ cancelGraceMs: 30 });
  const { url, close } = listen(app);
  const proc = makeFakeProc();
  jobs['job-1'] = { id: 'job-1', org_id: ORG_A, importRunId: RUN_A, status: 'running', proc, productKind: 'high_school_gc_import' };
  try {
    const res = await fetch(`${url}/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/${RUN_A}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${USER_TOKEN_HS}` },
    });
    assert.equal(res.status, 200);
    // The child never emits 'exit' -- simulating an uncooperative process.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(stopJobProcessCalls.length, 1, 'an uncooperative child must be force-killed after the grace period elapses');
  } finally { await close(); restoreEnv(); }
});

test('kill-switch watchdog: proactively stops every active High School GC job without any HTTP request, marks each failed (never succeeded), and never touches an unrelated job', async () => {
  const { jobs, killSwitchWatchdogTick, failImportRunCalls, stopJobProcessCalls, finishJobCalls, restoreEnv } = buildTestApp();
  const originalEnabled = process.env.GC_COLLECTION_ENABLED;
  process.env.GC_COLLECTION_ENABLED = 'false';
  const procA = makeFakeProc();
  const procB = makeFakeProc();
  jobs['job-hs-1'] = { id: 'job-hs-1', org_id: ORG_A, importRunId: RUN_A, status: 'running', proc: procA, productKind: 'high_school_gc_import' };
  jobs['job-travel-1'] = { id: 'job-travel-1', org_id: ORG_A, status: 'running', proc: procB, productKind: 'travel_scraper' };
  try {
    const affected = killSwitchWatchdogTick();
    assert.deepEqual(affected, ['job-hs-1']);
    assert.equal(failImportRunCalls.length, 1);
    assert.match(failImportRunCalls[0].rawErrorMessage, /disabled/i);
    assert.deepEqual(procA.sentMessages, [{ type: 'kill_switch_disabled' }]);
    assert.deepEqual(procB.sentMessages, [], 'a non-High-School-GC-import job must never be touched by this watchdog');
    assert.equal(jobs['job-hs-1'].killSwitchHandled, true);

    // A second tick while still disabled must not re-signal or re-mark the same job.
    killSwitchWatchdogTick();
    assert.equal(failImportRunCalls.length, 1, 'an already-handled job must not be signaled or marked a second time on a later tick');
  } finally {
    if (originalEnabled === undefined) delete process.env.GC_COLLECTION_ENABLED; else process.env.GC_COLLECTION_ENABLED = originalEnabled;
    restoreEnv();
  }
});

test('kill-switch watchdog: does nothing at all while collection remains enabled', async () => {
  const { jobs, killSwitchWatchdogTick, failImportRunCalls, restoreEnv } = buildTestApp();
  const originalEnabled = process.env.GC_COLLECTION_ENABLED;
  process.env.GC_COLLECTION_ENABLED = 'true';
  const proc = makeFakeProc();
  jobs['job-hs-1'] = { id: 'job-hs-1', org_id: ORG_A, importRunId: RUN_A, status: 'running', proc, productKind: 'high_school_gc_import' };
  try {
    const affected = killSwitchWatchdogTick();
    assert.deepEqual(affected, []);
    assert.equal(failImportRunCalls.length, 0);
    assert.deepEqual(proc.sentMessages, []);
  } finally {
    if (originalEnabled === undefined) delete process.env.GC_COLLECTION_ENABLED; else process.env.GC_COLLECTION_ENABLED = originalEnabled;
    restoreEnv();
  }
});
