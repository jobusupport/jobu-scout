'use strict';

// Exercises the REAL default opponent dispatcher -- the function the router uses
// in production when nothing is injected -- with only the process boundary
// replaced by a fake spawn. No collector process, browser, or network is ever
// started. A source scan would not prove any of this; these call the function.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { defaultDispatchOpponentCollection } = require('../src/high-school-import-routes');

const CTX = Object.freeze({
  orgId: 'aaaaaaaa-1111-4111-8111-111111111111',
  programId: 'bbbbbbbb-2222-4222-8222-222222222222',
  opponentTeamId: 'cccccccc-3333-4333-8333-333333333333',
  seasonId: 'dddddddd-4444-4444-8444-444444444444',
  opponentImportRunId: 'eeeeeeee-5555-4555-8555-555555555555',
  opponentLabel: 'Opponent High Varsity',
});

// A real EventEmitter-shaped child, because that is what the defect is about: a
// ChildProcess is an EventEmitter, and an 'error' emitted on one with no
// listener is an UNCAUGHT EXCEPTION that takes the server process down. A plain
// object with stored callbacks cannot demonstrate that, so this uses genuine
// emitters and genuinely emits.
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.send = () => {};
  child._stdout = (chunk) => child.stdout.emit('data', chunk);
  child._stderr = (chunk) => child.stderr.emit('data', chunk);
  child._close = (code) => child.emit('close', code);
  child._error = (err) => child.emit('error', err);
  return child;
}

function harness({ spawnImpl, importService, child = fakeChild() } = {}) {
  const calls = [];
  const logs = [];
  const finished = [];
  const attached = [];
  const spawn = spawnImpl || ((cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; });
  const result = defaultDispatchOpponentCollection({
    jobId: 'job-1',
    jobs: { 'job-1': {} },
    appendLog: (id, line) => logs.push([id, line]),
    finishJob: (id, ok, code) => finished.push([id, ok, code]),
    attachJobProcess: (id, proc) => attached.push([id, proc]),
    spawn,
    ctx: CTX,
    sourceTeamUrl: 'https://web.gc.com/teams/opponent-high',
    importService,
  });
  return { calls, logs, finished, attached, child, result };
}

test('the real dispatcher launches the Node runtime with the opponent collector entry point', () => {
  const { calls, result, child } = harness();
  assert.equal(calls.length, 1, 'exactly one process is started');
  const [{ cmd, args }] = calls;
  assert.equal(cmd, 'node', 'the intended runtime, not a shell');
  assert.equal(args.length, 1, 'a single explicit script argument');
  assert.equal(path.basename(args[0]), 'high-school-opponent-gc-import.js');
  assert.ok(path.isAbsolute(args[0]), 'the entry point is resolved, not relative to cwd');
  assert.equal(result, child, 'the dispatcher returns the child so the caller can track it');
});

test('no request value is interpolated into a shell and no shell is used', () => {
  const { calls } = harness();
  const [{ args, opts }] = calls;
  assert.equal(opts.shell, undefined, 'shell is never enabled');
  // argv carries only the script path; every identifier travels via env.
  assert.equal(args.filter((a) => /[;&|`$(){}<>]/.test(a)).length, 0,
    'no argv entry contains shell metacharacters');
  for (const value of Object.values(CTX)) {
    assert.equal(args.some((a) => String(a).includes(String(value))), false,
      'no context value is placed on the command line');
  }
});

test('organization, opponent, season, run and source identifiers are passed discretely', () => {
  const { calls } = harness();
  const { env } = calls[0].opts;
  assert.equal(env.HS_OPP_IMPORT_ORG_ID, CTX.orgId);
  assert.equal(env.HS_OPP_IMPORT_PROGRAM_ID, CTX.programId);
  assert.equal(env.HS_OPP_IMPORT_OPPONENT_TEAM_ID, CTX.opponentTeamId);
  assert.equal(env.HS_OPP_IMPORT_SEASON_ID, CTX.seasonId);
  assert.equal(env.HS_OPP_IMPORT_RUN_ID, CTX.opponentImportRunId);
  assert.equal(env.HS_OPP_IMPORT_OPPONENT_LABEL, CTX.opponentLabel);
  assert.equal(env.HS_OPP_IMPORT_SOURCE_TEAM_URL, 'https://web.gc.com/teams/opponent-high');
  // Each identifier is its own variable, never a packed/parsed blob.
  assert.equal(Object.keys(env).filter((k) => k.startsWith('HS_OPP_IMPORT_')).length, 7);
});

test('a missing source URL and label degrade to empty strings rather than the literal undefined', () => {
  const calls = [];
  defaultDispatchOpponentCollection({
    jobId: 'job-2',
    jobs: { 'job-2': {} },
    appendLog: () => {},
    finishJob: () => {},
    attachJobProcess: () => {},
    spawn: (cmd, args, opts) => { calls.push(opts); return { pid: 1, stdout: { on() {} }, stderr: { on() {} }, on() {}, send() {} }; },
    ctx: { ...CTX, opponentLabel: null },
    sourceTeamUrl: null,
  });
  assert.equal(calls[0].env.HS_OPP_IMPORT_SOURCE_TEAM_URL, '');
  assert.equal(calls[0].env.HS_OPP_IMPORT_OPPONENT_LABEL, '');
});

test('the child is given an IPC channel so cancel and kill-switch messages can reach it', () => {
  const { calls, attached } = harness();
  const { opts } = calls[0];
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe', 'ipc'],
    'ipc is required or proc.send() is silently undefined');
  assert.equal(attached.length, 1, 'the child is attached to the job so cancellation reaches it');
  assert.equal(attached[0][0], 'job-1');
  assert.equal(typeof attached[0][1].send, 'function', 'the attached child exposes send()');
});

test('collector output is sanitized into the job log, and exit codes map to job outcome', () => {
  const { logs, finished, child } = harness();
  child._stdout(Buffer.from('line one\nline two\n'));
  child._stderr(Buffer.from('an error line\n'));
  assert.deepEqual(logs.map(([, line]) => line), ['line one', 'line two', 'an error line']);

  child._close(0);
  assert.deepEqual(finished, [['job-1', true, 0]], 'exit 0 is a successful job');

  // A real ChildProcess closes exactly once, so each exit code needs its own
  // child rather than a second close on a settled one.
  const failing = harness();
  failing.child._close(1);
  assert.deepEqual(failing.finished, [['job-1', false, 1]], 'a nonzero exit fails the job');
});

test('a job is settled exactly once, however many times the child reports finishing', () => {
  const { finished, child } = harness();
  child._close(0);
  child._close(1);
  child._error(new Error('ENOENT'));
  assert.deepEqual(finished, [['job-1', true, 0]],
    'a run the child already finalized is never failed a second time');
});

test('a spawn failure propagates instead of being reported as a started run', () => {
  assert.throws(
    () => harness({ spawnImpl: () => { throw new Error('EACCES'); } }),
    /EACCES/,
    'the route must not answer 201 when the collector could not be started',
  );
});

test('the collector CLI selects the expanded schedule mode and the own-team CLI does not', () => {
  const fs = require('node:fs');
  const opponent = fs.readFileSync(path.join(__dirname, '..', 'src', 'high-school-opponent-gc-import.js'), 'utf8');
  const ownTeam = fs.readFileSync(path.join(__dirname, '..', 'src', 'high-school-gc-import.js'), 'utf8');
  const cli = opponent.slice(opponent.indexOf('require.main === module'));
  assert.match(cli, /SCHEDULE_EXTRACTION_MODES\.ALL_SCHEDULE_ENTRIES/,
    'the dispatched CLI must ask for every schedule row');
  assert.doesNotMatch(cli, /getVisibleCompletedGameEntries/,
    'the opponent CLI must not fall back to completed-only discovery');
  assert.match(ownTeam, /getVisibleCompletedGameEntries\(page\)/,
    'own-team discovery is unchanged');
  assert.doesNotMatch(ownTeam, /ALL_SCHEDULE_ENTRIES/,
    'own-team must never select the expanded mode');
});

test('the own-team dispatch path still spawns its own collector entry point', () => {
  const fs = require('node:fs');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'high-school-import-routes.js'), 'utf8');
  assert.match(routes, /spawn\('node', \[scriptPath\][\s\S]*?HS_IMPORT_ORG_ID/,
    'the own-team route still spawns high-school-gc-import.js with its own env contract');
  assert.match(routes, /high-school-gc-import\.js/);
});

// ── Asynchronous spawn failures (HS 2D review correction) ──────────────
//
// spawn() returns a ChildProcess and THEN reports ENOENT/EACCES by emitting
// 'error' on it. With no 'error' listener that is an uncaught exception, so a
// collector that could not start took the whole server down -- after the route
// had already answered 201.

test('an asynchronous spawn error does not crash the process and fails the job', () => {
  const { logs, finished, child } = harness();
  assert.equal(child.listenerCount('error'), 1,
    'an EventEmitter with no error listener turns this into an uncaught exception');

  // Genuinely emitted, not a stored callback invoked directly.
  assert.doesNotThrow(() => child._error(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })));

  assert.deepEqual(finished, [['job-1', false, -1]], 'the job is failed, never left running');
  assert.ok(logs.some(([, line]) => /could not be started/.test(line)),
    'the job log says the collector never ran');
  assert.equal(logs.some(([, line]) => /captured|published|verified/i.test(line)), false,
    'nothing claims capture or publication occurred');
});

test('an asynchronous spawn error transitions the opponent import run out of running', () => {
  const failed = [];
  const importService = {
    failOpponentImportRun: async (args) => { failed.push(args); return {}; },
  };
  const { child } = harness({ importService });
  child._error(Object.assign(new Error('spawn node EACCES'), { code: 'EACCES' }));

  assert.equal(failed.length, 1, 'the run is marked failed exactly once');
  assert.equal(failed[0].orgId, CTX.orgId, 'using the trusted context the request established');
  assert.equal(failed[0].opponentImportRunId, CTX.opponentImportRunId);
  assert.equal(failed[0].failureStage, 'discovery');
  assert.match(failed[0].errorSummary, /could not be started/);
});

test('a run the child already finalized is not failed again by a later error', () => {
  const failed = [];
  const importService = { failOpponentImportRun: async (args) => { failed.push(args); return {}; } };
  const { child, finished } = harness({ importService });
  child._close(0);
  child._error(new Error('spawn node ENOENT'));
  assert.deepEqual(finished, [['job-1', true, 0]]);
  assert.equal(failed.length, 0, 'the child reported its own outcome; the parent must not overwrite it');
});

test('a failure while recording the run failure is contained rather than rethrown', () => {
  const importService = {
    failOpponentImportRun: async () => { throw new Error('database unavailable'); },
  };
  const { child, finished } = harness({ importService });
  assert.doesNotThrow(() => child._error(new Error('spawn node ENOENT')));
  assert.deepEqual(finished, [['job-1', false, -1]], 'the job is still failed');
});

test('stream listeners are released once the child has settled', () => {
  const { child } = harness();
  assert.equal(child.stdout.listenerCount('data'), 1);
  child._close(0);
  assert.equal(child.stdout.listenerCount('data'), 0, 'no dead child keeps its buffers alive');
  assert.equal(child.stderr.listenerCount('data'), 0);
});
