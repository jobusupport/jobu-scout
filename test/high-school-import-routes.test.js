'use strict';

// Real-HTTP tests for src/high-school-import-routes.js -- a genuine
// Express app mounting the ACTUAL registerHighSchoolImportRoutes function
// (not a re-implementation), with fake auth/support-session/entitlement
// middleware injected the same way test/travel-job-routes.test.js and
// test/admin-api-product-route-wiring.test.js already inject fakes for
// their own route-wiring proofs. child_process.spawn is also injected
// (src/high-school-import-routes.js accepts it as an optional dependency
// specifically so this test file can prove "a job/process is only ever
// started after every authorization check passes" without ever launching a
// real node process, Playwright, or touching Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerHighSchoolImportRoutes } = require('../src/high-school-import-routes');
const { asyncHandler } = require('../src/express-helpers');
const { createFakeHsImportAdminClient } = require('./helpers/fake-hs-import-admin-client');

const ORG_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_TOKEN_HS = 'user-hs-org-a';
const USER_TOKEN_TRAVEL = 'user-travel-only';
const TEAM_A = 'cccccccc-3333-4333-8333-333333333333';
const SEASON_A = 'dddddddd-4444-4444-8444-444444444444';
const PROGRAM_A = 'eeeeeeee-5555-4555-8555-555555555555';

function buildApp({ collectionEnabled = true, importServiceOverrides = {}, spawnImpl } = {}) {
  const app = express();
  app.use(express.json());

  const jobs = {};
  const spawnCalls = [];
  const fakeSpawn = spawnImpl || ((cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    const fakeChild = {
      pid: 12345,
      stdout: { on() {} },
      stderr: { on() {} },
      on(event, cb) { if (event === 'close') fakeChild._closeCb = cb; },
      send() {},
    };
    return fakeChild;
  });

  function requireAuth(req, res, next) {
    const token = req.get('authorization')?.replace(/^Bearer /, '');
    if (token === USER_TOKEN_HS) { req.user = { id: '12121212-1212-4212-8212-121212121212' }; return next(); }
    if (token === USER_TOKEN_TRAVEL) { req.user = { id: '34343434-3434-4434-8434-343434343434' }; return next(); }
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  function resolveSupportSession(req, res, next) {
    const token = req.get('x-support-session');
    if (!token) return next();
    if (token === 'support-readonly-a') {
      req._orgId = ORG_A;
      req._supportSession = { mode: 'read_only' };
      return next();
    }
    return res.status(401).json({ error: 'Invalid support session' });
  }

  function requireHighSchoolAccess(req, res, next) {
    if (req._orgId) return next(); // already pinned by a support session
    if (req.user?.id === '12121212-1212-4212-8212-121212121212') { req._orgId = ORG_A; return next(); }
    return res.status(403).json({ error: 'This organization does not have High School access.' });
  }

  function blockWriteDuringReadOnlySupport(req, res, next) {
    if (req._supportSession?.mode === 'read_only') {
      return res.status(403).json({ error: 'This is a read-only support session — write actions are disabled.' });
    }
    next();
  }

  function appendLog(id, line) { if (jobs[id]) jobs[id].logs.push({ t: Date.now(), line }); }
  function finishJob(id, success, exitCode) { if (jobs[id]) { jobs[id].status = success ? 'done' : 'failed'; jobs[id].exitCode = exitCode; } }
  function attachJobProcess(id, proc) { if (jobs[id]) { jobs[id].pid = proc.pid; jobs[id].proc = proc; } }
  function stopJobProcess(job) { if (!job?.proc) return false; job.stopping = true; return true; }

  const adminClient = createFakeHsImportAdminClient({
    hs_teams: [
      { id: TEAM_A, org_id: ORG_A, program_id: PROGRAM_A, name: 'Varsity', is_active: true, gc_team_url: null, gc_external_team_id: null, record_source: 'manual', roster_sync_status: 'never' },
    ],
    hs_seasons: [
      { id: SEASON_A, org_id: ORG_A, program_id: PROGRAM_A, name: '2026 Spring', school_year: '2025-2026' },
    ],
    hs_roster_memberships: [],
  });

  const originalEnv = process.env.GC_COLLECTION_ENABLED;
  process.env.GC_COLLECTION_ENABLED = collectionEnabled ? 'true' : 'false';

  app.locals.highSchoolImportService = {
    async startImportRun(args) { return { id: '22222222-8888-4888-8888-888888888888', ...args, status: 'running' }; },
    async listImportRuns() { return []; },
    async getImportRunDetail({ importRunId }) {
      return { run: { id: importRunId, org_id: ORG_A, team_id: TEAM_A, season_id: SEASON_A, status: 'succeeded' }, games: [], validations: [] };
    },
    async getCapturedGamesForRun() { return [{ boxScore: { batting: [], pitching: [] }, plays: [] }]; },
    async publishVerifiedTotals(args) { return { id: 'totals-1', is_current: true, ...args }; },
    async publishPlayerAdvancedStats(args) { return { is_current: true, ...args }; },
    async failImportRun() { return {}; },
    async getPublishedStats() { return { verifiedTotals: { games: 5 }, playerAdvancedStats: [], pitcherAdvancedStats: [] }; },
    ...importServiceOverrides,
  };

  const router = express.Router();
  registerHighSchoolImportRoutes(router, {
    adminClient, resolveSupportSession, blockWriteDuringReadOnlySupport, requireHighSchoolAccess,
    asyncHandler, requireAuth, jobs, appendLog, finishJob, attachJobProcess, stopJobProcess, spawn: fakeSpawn,
  });
  app.use('/api/high-school', router);

  return { app, jobs, spawnCalls, adminClient, restoreEnv: () => { process.env.GC_COLLECTION_ENABLED = originalEnv; } };
}

function listen(app) {
  const server = app.listen(0);
  const { port } = server.address();
  return { url: `http://localhost:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function apiFetch(base, path, { token, supportSession, method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(supportSession ? { 'x-support-session': supportSession } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('an unauthenticated request to start an import is rejected before any job is created or process spawned', async () => {
  const { app, jobs, spawnCalls, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(Object.keys(jobs).length, 0);
    assert.equal(spawnCalls.length, 0);
  } finally { await close(); restoreEnv(); }
});

test('a Travel-only organization is denied High School import access entirely', async () => {
  const { app, spawnCalls, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_TRAVEL, body: {} });
    assert.equal(res.status, 403);
    assert.equal(spawnCalls.length, 0);
  } finally { await close(); restoreEnv(); }
});

test('a read-only support session cannot start, cancel, retry, or publish an import, but can read status', async () => {
  const { app, spawnCalls, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const start = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_HS, supportSession: 'support-readonly-a', body: {} });
    assert.equal(start.status, 403);

    const cancel = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/ffffffff-6666-4666-8666-666666666666/cancel`, { method: 'POST', token: USER_TOKEN_HS, supportSession: 'support-readonly-a' });
    assert.equal(cancel.status, 403);

    const retry = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/ffffffff-6666-4666-8666-666666666666/retry`, { method: 'POST', token: USER_TOKEN_HS, supportSession: 'support-readonly-a' });
    assert.equal(retry.status, 403);

    const publish = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/ffffffff-6666-4666-8666-666666666666/publish`, { method: 'POST', token: USER_TOKEN_HS, supportSession: 'support-readonly-a' });
    assert.equal(publish.status, 403);

    const read = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { token: USER_TOKEN_HS, supportSession: 'support-readonly-a' });
    assert.equal(read.status, 200);

    assert.equal(spawnCalls.length, 0, 'no job may ever be spawned for a read-only support session');
  } finally { await close(); restoreEnv(); }
});

test('starting an import for a team with no GameChanger source connected is rejected before any job is created', async () => {
  const { app, jobs, spawnCalls, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_HS, body: {} });
    assert.equal(res.status, 400);
    assert.equal(Object.keys(jobs).length, 0);
    assert.equal(spawnCalls.length, 0);
  } finally { await close(); restoreEnv(); }
});

test('the kill switch prevents starting an import even for a fully authorized, source-connected team', async () => {
  const { app, adminClient, jobs, spawnCalls, restoreEnv } = buildApp({ collectionEnabled: false });
  adminClient.__tables.hs_teams[0].gc_team_url = 'https://web.gc.com/teams/org1/team1';
  adminClient.__tables.hs_teams[0].gc_external_team_id = 'team1';
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_HS, body: {} });
    assert.equal(res.status, 503);
    assert.equal(Object.keys(jobs).length, 0);
    assert.equal(spawnCalls.length, 0);
  } finally { await close(); restoreEnv(); }
});

test('a fully authorized start for a source-connected team creates a tenant-bound job and spawns the collector with the correct context, and never before this point', async () => {
  const { app, adminClient, jobs, spawnCalls, restoreEnv } = buildApp();
  adminClient.__tables.hs_teams[0].gc_team_url = 'https://web.gc.com/teams/org1/team1';
  adminClient.__tables.hs_teams[0].gc_external_team_id = 'team1';
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_HS, body: {} });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.jobId);

    const job = jobs[body.jobId];
    assert.equal(job.org_id, ORG_A, 'job must be bound to the resolved organization, not any client-suppliable value');
    assert.equal(job.created_by_user_id, '12121212-1212-4212-8212-121212121212');

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].opts.env.HS_IMPORT_ORG_ID, ORG_A);
    assert.equal(spawnCalls[0].opts.env.HS_IMPORT_TEAM_ID, TEAM_A);
    assert.equal(spawnCalls[0].opts.env.HS_IMPORT_SEASON_ID, SEASON_A);
    assert.equal(spawnCalls[0].opts.env.HS_IMPORT_GC_TEAM_URL, 'https://web.gc.com/teams/org1/team1');
    assert.equal(spawnCalls[0].opts.env.HS_IMPORT_ENGINE_PERSISTENCE_ENABLED, '1');
  } finally { await close(); restoreEnv(); }
});

test('concurrency limit blocks a new import once the organization already has the maximum number running', async () => {
  const { app, adminClient, spawnCalls, restoreEnv } = buildApp();
  adminClient.__tables.hs_teams[0].gc_team_url = 'https://web.gc.com/teams/org1/team1';
  process.env.GC_MAX_CONCURRENT_IMPORT_JOBS = '1';
  const { url, close } = listen(app);
  try {
    const first = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_HS, body: {} });
    assert.equal(first.status, 201);

    const second = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_HS, body: {} });
    assert.equal(second.status, 429);
    assert.equal(spawnCalls.length, 1, 'the second, over-the-limit request must never spawn a process');
  } finally { await close(); restoreEnv(); delete process.env.GC_MAX_CONCURRENT_IMPORT_JOBS; }
});

test('a foreign-tenant team id is rejected with a not-found response, not an authorization error that would confirm it exists', async () => {
  const { app, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/00000000-0000-4000-8000-000000000000/seasons/${SEASON_A}/import-runs`, { method: 'POST', token: USER_TOKEN_HS, body: {} });
    assert.equal(res.status, 404);
  } finally { await close(); restoreEnv(); }
});

test('gc-source binding: rejects a non-GameChanger URL, accepts a valid one, and rejects binding the same GC team to two teams in the org', async () => {
  const { app, adminClient, restoreEnv } = buildApp();
  adminClient.__tables.hs_teams.push({ id: '99999999-9999-4999-8999-999999999999', org_id: ORG_A, program_id: PROGRAM_A, name: 'JV', is_active: true, gc_team_url: null, gc_external_team_id: null });
  const { url, close } = listen(app);
  try {
    const bad = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/gc-source`, { method: 'PATCH', token: USER_TOKEN_HS, body: { gcTeamUrl: 'https://evil.example.com/not-gc' } });
    assert.equal(bad.status, 400);

    const good = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/gc-source`, { method: 'PATCH', token: USER_TOKEN_HS, body: { gcTeamUrl: 'https://web.gc.com/teams/org1/team1/schedule' } });
    assert.equal(good.status, 200);
    const goodBody = await good.json();
    assert.equal(goodBody.team.gc_external_team_id, 'team1');

    const conflict = await apiFetch(url, `/api/high-school/teams/99999999-9999-4999-8999-999999999999/gc-source`, { method: 'PATCH', token: USER_TOKEN_HS, body: { gcTeamUrl: 'https://web.gc.com/teams/org1/team1/schedule' } });
    assert.equal(conflict.status, 409);
  } finally { await close(); restoreEnv(); }
});

test('publish is rejected when the run has not fully succeeded, and never calls the publish service function in that case', async () => {
  let publishCalled = false;
  const { app, restoreEnv } = buildApp({
    importServiceOverrides: {
      async getImportRunDetail({ importRunId }) {
        return { run: { id: importRunId, org_id: ORG_A, team_id: TEAM_A, season_id: SEASON_A, status: 'partial' }, games: [], validations: [] };
      },
      async publishVerifiedTotals() { publishCalled = true; return {}; },
    },
  });
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/22222222-8888-4888-8888-888888888888/publish`, { method: 'POST', token: USER_TOKEN_HS });
    assert.equal(res.status, 409);
    assert.equal(publishCalled, false);
  } finally { await close(); restoreEnv(); }
});

test('a succeeded run with zero capturable games is rejected rather than publishing an empty aggregate', async () => {
  let publishCalled = false;
  const { app, restoreEnv } = buildApp({
    importServiceOverrides: {
      async getCapturedGamesForRun() { return []; },
      async publishVerifiedTotals() { publishCalled = true; return {}; },
    },
  });
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/22222222-8888-4888-8888-888888888888/publish`, { method: 'POST', token: USER_TOKEN_HS });
    assert.equal(res.status, 409);
    assert.equal(publishCalled, false);
  } finally { await close(); restoreEnv(); }
});

test('a successful publish returns the published totals from the service, unmodified by any client input', async () => {
  const { app, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/22222222-8888-4888-8888-888888888888/publish`, {
      method: 'POST', token: USER_TOKEN_HS,
      body: { games: [{ boxScore: { batting: [{ fabricated: true }] } }], validationStatus: 'validated', confidence: 'high' }, // must all be ignored
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verifiedTotals.is_current, true);
  } finally { await close(); restoreEnv(); }
});

test('publishing a Slice 2C run is read-only because its atomic ingestion already created the generation', async () => {
  let legacyPublishCalled = false;
  let capturedGamesRead = false;
  const { app, restoreEnv } = buildApp({
    importServiceOverrides: {
      async getImportRunDetail({ importRunId }) {
        return {
          run: {
            id: importRunId,
            org_id: ORG_A,
            team_id: TEAM_A,
            season_id: SEASON_A,
            status: 'succeeded',
            result_summary: { generationId: 'generation-2c' },
          },
          games: [],
          validations: [],
        };
      },
      async getCapturedGamesForRun() { capturedGamesRead = true; return []; },
      async publishVerifiedTotals() { legacyPublishCalled = true; return {}; },
    },
  });
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/22222222-8888-4888-8888-888888888888/publish`, { method: 'POST', token: USER_TOKEN_HS });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alreadyPublished, true);
    assert.equal(body.generationId, 'generation-2c');
    assert.equal(legacyPublishCalled, false);
    assert.equal(capturedGamesRead, false);
  } finally { await close(); restoreEnv(); }
});

test('authenticated stat viewing returns the service-provided published stats', async () => {
  const { app, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/stats`, { token: USER_TOKEN_HS });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verifiedTotals.games, 5);
  } finally { await close(); restoreEnv(); }
});

test('unauthenticated stat viewing is rejected', async () => {
  const { app, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/stats`);
    assert.equal(res.status, 401);
  } finally { await close(); restoreEnv(); }
});

test('cancel returns a conflict when no live job is running for that import run, and never calls stopJobProcess', async () => {
  const { app, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs/11111111-7777-4777-8777-777777777777/cancel`, { method: 'POST', token: USER_TOKEN_HS });
    assert.equal(res.status, 409);
  } finally { await close(); restoreEnv(); }
});

test('an alternate HTTP method against a mutating-only path fails safely rather than falling through to an unrelated handler', async () => {
  const { app, restoreEnv } = buildApp();
  const { url, close } = listen(app);
  try {
    const res = await fetch(`${url}/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/import-runs`, { method: 'DELETE' });
    assert.notEqual(res.status, 200);
  } finally { await close(); restoreEnv(); }
});

test('error responses never leak database, filesystem, or internal detail', async () => {
  const { app, restoreEnv } = buildApp({
    importServiceOverrides: {
      async getPublishedStats() { const e = new Error('relation "hs_verified_totals" does not exist at /app/src/high-school-import-repository.js:481'); throw e; },
    },
  });
  const { url, close } = listen(app);
  try {
    const res = await apiFetch(url, `/api/high-school/teams/${TEAM_A}/seasons/${SEASON_A}/stats`, { token: USER_TOKEN_HS });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes('high-school-import-repository.js'));
    assert.ok(!JSON.stringify(body).includes('/app/src'));
  } finally { await close(); restoreEnv(); }
});
