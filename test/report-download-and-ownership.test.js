'use strict';

// Security Slice T3B: genuine, real-HTTP behavioral tests for (1) the
// authenticated report-download route and (2) the ourTeamId-ownership +
// quota + job-creation ordering used by the self-scout/matchup routes.
//
// A real Express app is mounted and driven over real HTTP (fetch against
// an ephemeral localhost port), mirroring the established pattern in
// test/travel-job-routes.test.js. The route logic reuses the REAL
// src/report-access.js module (not reimplemented); the fake Supabase-like
// adminClient models NO row-level security at all -- every query it
// receives is answered in full, exactly like a real service-role
// connection -- so a passing test proves isolation comes from the
// application code's own org_id-scoped queries, never from a database
// policy the service-role client bypasses anyway.
//
// Run with: node --test test/report-download-and-ownership.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isValidUuid,
  resolveOwnedTeamId,
  sanitizeDownloadFilename,
  resolveContainedReportPath,
  isServableReportFile,
  resolveCanonicalReportPath,
} = require('../src/report-access');

const USERS = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
};
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const USER_ORGS = { [USERS.a]: ORG_A, [USERS.b]: ORG_B };

// ── Minimal fake Supabase-like client for `reports` and `teams` ─────────────
// Deliberately permissive (no RLS modeled) -- see file header.
class FakeQuery {
  constructor(rows) {
    this.rows = rows;
    this.filters = [];
  }
  select() { return this; }
  eq(col, val) { this.filters.push([col, val]); return this; }
  order() { return this; }
  _matches(row) { return this.filters.every(([c, v]) => row[c] === v); }
  async maybeSingle() {
    const matched = this.rows.filter((r) => this._matches(r));
    if (matched.length > 1) return { data: null, error: { message: 'multiple rows' } };
    return { data: matched[0] || null, error: null };
  }
  then(resolve, reject) {
    return Promise.resolve({ data: this.rows.filter((r) => this._matches(r)), error: null }).then(resolve, reject);
  }
}

function createFakeAdminClient(state) {
  return {
    from(table) {
      return new FakeQuery(state[table] || []);
    },
  };
}

async function startFixture({ reportsRoot, reportsRows, teamsRows }) {
  const state = { reports: reportsRows, teams: teamsRows };
  const adminClient = createFakeAdminClient(state);

  function requireAuth(req, res, next) {
    const key = req.get('authorization')?.replace(/^Bearer /, '');
    const id = USERS[key];
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id, email: `${key}@example.test` };
    next();
  }
  function resolveSupportSession(req, res, next) { next(); }
  function requireTravelAccess(req, res, next) { next(); }

  async function getRequestOrgId(req) {
    return USER_ORGS[req.user.id];
  }
  async function getTeams(req) {
    const orgId = await getRequestOrgId(req);
    return state.teams.filter((t) => t.org_id === orgId);
  }

  const jobEvents = { quotaConsumed: 0, jobsCreated: 0, spawns: 0 };

  const app = express();
  app.use(express.json());

  // ── The download route: identical logic to server.js's own route,
  // reusing the real report-access.js functions. ──────────────────────────
  app.get('/api/reports/:reportId/download', requireAuth, resolveSupportSession, requireTravelAccess, async (req, res) => {
    const { reportId } = req.params;
    if (!isValidUuid(reportId)) return res.status(404).json({ error: 'Report not found' });

    const orgId = await getRequestOrgId(req);
    const { data: reportRow, error } = await adminClient
      .from('reports')
      .select('id, storage_path, title')
      .eq('id', reportId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'Internal error' });
    if (!reportRow || !reportRow.storage_path) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const resolvedPath = resolveContainedReportPath(reportsRoot, reportRow.storage_path);
    if (!resolvedPath) return res.status(404).json({ error: 'Report not found' });
    if (!isServableReportFile(resolvedPath)) return res.status(404).json({ error: 'Report not found' });

    // Security Slice T3J: canonical (symlink-resolved) containment,
    // in addition to the lexical/final-component-only checks above --
    // see server.js's own route and src/report-access.js#
    // resolveCanonicalReportPath for the full rationale.
    const canonicalPath = resolveCanonicalReportPath(reportsRoot, resolvedPath);
    if (!canonicalPath) return res.status(404).json({ error: 'Report not found' });

    const safeName = sanitizeDownloadFilename(reportRow.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.sendFile(canonicalPath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Report not found' });
    });
  });

  // ── A minimal reproduction of the self-scout route's ownership-check
  // ordering: prove that a rejection happens BEFORE quota/job creation. ───
  app.post('/api/run/self-scout', requireAuth, resolveSupportSession, requireTravelAccess, async (req, res) => {
    const teams = await getTeams(req);
    const ownedOurTeamId = resolveOwnedTeamId(teams, req.body.ourTeamId);
    if (ownedOurTeamId === false) return res.status(404).json({ error: 'Team not found' });

    jobEvents.quotaConsumed += 1; // stands in for enforceReportQuota's DB insert
    jobEvents.jobsCreated += 1;   // stands in for createJob
    jobEvents.spawns += 1;        // stands in for spawnJob
    res.json({ jobId: 'fake-job-id', ourTeamId: ownedOurTeamId });
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    jobEvents,
    request: (p, options) => fetch(`${baseUrl}${p}`, options),
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function authHeaders(key, extra = {}) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

// ── Download route tests ──────────────────────────────────────────────────

test('report download: unauthenticated request cannot download any report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000001';
  fs.mkdirSync(path.join(root, ORG_A, reportId), { recursive: true });
  fs.writeFileSync(path.join(root, ORG_A, reportId, 'report.pdf'), 'synthetic');
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: `${ORG_A}/${reportId}/report.pdf`, title: 'Synthetic Report' }],
    teamsRows: [],
  });
  try {
    const res = await fx.request(`/api/reports/${reportId}/download`);
    assert.equal(res.status, 401);
  } finally {
    await fx.close();
  }
});

test('report download: authenticated org A can download its own report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000002';
  fs.mkdirSync(path.join(root, ORG_A, reportId), { recursive: true });
  fs.writeFileSync(path.join(root, ORG_A, reportId, 'report.pdf'), 'synthetic pdf bytes');
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: `${ORG_A}/${reportId}/report.pdf`, title: 'Synthetic Report' }],
    teamsRows: [],
  });
  try {
    const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    const body = await res.text();
    assert.equal(body, 'synthetic pdf bytes');
  } finally {
    await fx.close();
  }
});

test('report download: org A cannot download org B\'s report by id -- and the response is identical to "unknown id"', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000003';
  fs.mkdirSync(path.join(root, ORG_B, reportId), { recursive: true });
  fs.writeFileSync(path.join(root, ORG_B, reportId, 'report.pdf'), 'org b secret data');
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{ id: reportId, org_id: ORG_B, storage_path: `${ORG_B}/${reportId}/report.pdf`, title: 'Org B Report' }],
    teamsRows: [],
  });
  try {
    const crossOrgRes = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
    const unknownRes = await fx.request(`/api/reports/ffffffff-0000-4000-8000-00000000ffff/download`, { headers: authHeaders('a') });
    assert.equal(crossOrgRes.status, 404);
    assert.equal(unknownRes.status, 404);
    const crossOrgBody = await crossOrgRes.json();
    const unknownBody = await unknownRes.json();
    assert.deepEqual(crossOrgBody, unknownBody, 'cross-org and unknown-id responses must be indistinguishable');
    // The file must never have been served -- prove no content leaked.
    assert.notEqual(crossOrgRes.headers.get('content-type'), 'application/pdf');
  } finally {
    await fx.close();
  }
});

test('report download: a report with no stored file yet (legacy or pending) produces the same sanitized 404', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000004';
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: null, title: 'Legacy Report' }],
    teamsRows: [],
  });
  try {
    const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
    assert.equal(res.status, 404);
  } finally {
    await fx.close();
  }
});

test('report download: a guessed legacy /reports/<filename> URL does not serve content (route no longer exists)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const fx = await startFixture({ reportsRoot: root, reportsRows: [], teamsRows: [] });
  try {
    const res = await fx.request(`/reports/scout-some-team-2026-01-01.pdf`, { headers: authHeaders('a') });
    assert.equal(res.status, 404); // Express's default 404 -- no route registered for this path.
  } finally {
    await fx.close();
  }
});

test('report download: a report row with a path traversal storage_path is rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000005';
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: '../../../etc/passwd', title: 'Malicious' }],
    teamsRows: [],
  });
  try {
    const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
    assert.equal(res.status, 404);
  } finally {
    await fx.close();
  }
});

test('report download: a report row with an absolute external storage_path is rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000006';
  const externalAbs = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: externalAbs, title: 'Malicious' }],
    teamsRows: [],
  });
  try {
    const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
    assert.equal(res.status, 404);
  } finally {
    await fx.close();
  }
});

test('report download: response headers cannot be injected through a malicious report title', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000007';
  fs.mkdirSync(path.join(root, ORG_A, reportId), { recursive: true });
  fs.writeFileSync(path.join(root, ORG_A, reportId, 'report.pdf'), 'x');
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{
      id: reportId,
      org_id: ORG_A,
      storage_path: `${ORG_A}/${reportId}/report.pdf`,
      title: 'Report"\r\nSet-Cookie: evil=1\r\nX-Injected: yes',
    }],
    teamsRows: [],
  });
  try {
    const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('x-injected'), null);
    assert.doesNotMatch(res.headers.get('content-disposition') || '', /[\r\n]/);
  } finally {
    await fx.close();
  }
});

test('report download: a directory mistakenly stored as storage_path is rejected, not served', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const reportId = 'deadbeef-0000-4000-8000-000000000008';
  fs.mkdirSync(path.join(root, ORG_A, reportId), { recursive: true });
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: `${ORG_A}/${reportId}`, title: 'Dir' }],
    teamsRows: [],
  });
  try {
    const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
    assert.equal(res.status, 404);
  } finally {
    await fx.close();
  }
});

// Creates a directory symlink at linkPath pointing at target. On a
// platform/environment where an unprivileged process cannot create a
// real symlink (e.g. Windows without Developer Mode or elevation), falls
// back to a functionally equivalent directory junction, which Windows
// allows unprivileged processes to create and which the filesystem
// resolves through identically for path-traversal purposes. Returns
// true if a link was created, false only if the runtime genuinely
// cannot create either.
function tryMakeDirLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return true;
    } catch {
      return false;
    }
  }
}

const DIR_LINK_PROBE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-link-probe-'));
const DIR_LINK_PROBE_TARGET = path.join(DIR_LINK_PROBE_ROOT, 'target');
fs.mkdirSync(DIR_LINK_PROBE_TARGET);
const CAN_CREATE_DIR_LINK = tryMakeDirLink(DIR_LINK_PROBE_TARGET, path.join(DIR_LINK_PROBE_ROOT, 'link'));

test(
  'report download: THE T3J REGRESSION -- an intermediate directory symlink inside REPORTS_DIR pointing outside it is rejected over real HTTP, even though the lexical containment check alone would approve the same storage_path string',
  { skip: CAN_CREATE_DIR_LINK ? false : 'runtime cannot create a directory symlink or junction on this platform/environment' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-symlink-test-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-symlink-outside-'));
    const reportId = 'deadbeef-0000-4000-8000-00000000000b';

    // <root>/escape-link -> <outsideDir>, entirely outside root.
    const linked = tryMakeDirLink(outsideDir, path.join(root, 'escape-link'));
    assert.ok(linked, 'expected a directory symlink/junction to be created for this test');
    fs.writeFileSync(path.join(outsideDir, 'report.pdf'), 'exfiltrated secret bytes');

    const storagePath = 'escape-link/report.pdf'; // lexically inside root, but escapes via the symlink.

    // Prove this is the real bypass shape: the lexical check alone
    // would have approved it, and the target is a real, readable file.
    assert.ok(resolveContainedReportPath(root, storagePath), 'lexical check should still approve the string -- that is the bug T3J closes');
    assert.ok(fs.lstatSync(path.join(root, storagePath)).isFile());

    const fx = await startFixture({
      reportsRoot: root,
      reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: storagePath, title: 'Escaped Report' }],
      teamsRows: [],
    });
    try {
      const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
      assert.equal(res.status, 404);
      assert.notEqual(res.headers.get('content-type'), 'application/pdf');
    } finally {
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  }
);

test(
  'report download: an intermediate directory symlink whose canonical target remains inside REPORTS_DIR is still served normally (containment, not a blanket symlink ban)',
  { skip: CAN_CREATE_DIR_LINK ? false : 'runtime cannot create a directory symlink or junction on this platform/environment' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-symlink-ok-test-'));
    const reportId = 'deadbeef-0000-4000-8000-00000000000c';
    const realDir = path.join(root, ORG_A, reportId);
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'report.pdf'), 'legit pdf bytes');

    // <root>/link-in -> <root>/<ORG_A>/<reportId>, still inside root.
    const linked = tryMakeDirLink(realDir, path.join(root, 'link-in'));
    assert.ok(linked, 'expected a directory symlink/junction to be created for this test');
    const storagePath = 'link-in/report.pdf';

    const fx = await startFixture({
      reportsRoot: root,
      reportsRows: [{ id: reportId, org_id: ORG_A, storage_path: storagePath, title: 'Linked Report' }],
      teamsRows: [],
    });
    try {
      const res = await fx.request(`/api/reports/${reportId}/download`, { headers: authHeaders('a') });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'legit pdf bytes');
    } finally {
      await fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

// ── ourTeamId ownership + lifecycle ordering ─────────────────────────────────

test('ownership: org A may use its own ourTeamId for self-scout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const ownTeamId = 'cccccccc-0000-4000-8000-000000000001';
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [],
    teamsRows: [{ id: ownTeamId, org_id: ORG_A, team_name: 'Org A Own Team' }],
  });
  try {
    const res = await fx.request('/api/run/self-scout', {
      method: 'POST',
      headers: authHeaders('a'),
      body: JSON.stringify({ ourTeamId: ownTeamId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ourTeamId, ownTeamId);
    assert.equal(fx.jobEvents.jobsCreated, 1);
  } finally {
    await fx.close();
  }
});

test('ownership: org A cannot use org B\'s team id for self-scout -- no job is spawned, no quota consumed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const orgBTeamId = 'cccccccc-0000-4000-8000-000000000002';
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [],
    teamsRows: [{ id: orgBTeamId, org_id: ORG_B, team_name: 'Org B Team' }],
  });
  try {
    const res = await fx.request('/api/run/self-scout', {
      method: 'POST',
      headers: authHeaders('a'),
      body: JSON.stringify({ ourTeamId: orgBTeamId }),
    });
    assert.equal(res.status, 404);
    assert.equal(fx.jobEvents.jobsCreated, 0, 'no job may be created for a rejected ownership check');
    assert.equal(fx.jobEvents.quotaConsumed, 0, 'no quota may be consumed for a rejected ownership check');
    assert.equal(fx.jobEvents.spawns, 0, 'no process may be spawned for a rejected ownership check');
  } finally {
    await fx.close();
  }
});

test('ownership: unknown ourTeamId is rejected the same way as a cross-org id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const fx = await startFixture({ reportsRoot: root, reportsRows: [], teamsRows: [] });
  try {
    const res = await fx.request('/api/run/self-scout', {
      method: 'POST',
      headers: authHeaders('a'),
      body: JSON.stringify({ ourTeamId: 'ffffffff-0000-4000-8000-00000000ffff' }),
    });
    assert.equal(res.status, 404);
    assert.equal(fx.jobEvents.jobsCreated, 0);
  } finally {
    await fx.close();
  }
});

test('ownership: blank/malformed ourTeamId is rejected safely without crashing the route', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const fx = await startFixture({ reportsRoot: root, reportsRows: [], teamsRows: [] });
  try {
    const res = await fx.request('/api/run/self-scout', {
      method: 'POST',
      headers: authHeaders('a'),
      body: JSON.stringify({ ourTeamId: 12345 }),
    });
    assert.equal(res.status, 404);
  } finally {
    await fx.close();
  }
});

test('ownership: omitted ourTeamId keeps the existing default behavior (job still created)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const fx = await startFixture({ reportsRoot: root, reportsRows: [], teamsRows: [] });
  try {
    const res = await fx.request('/api/run/self-scout', {
      method: 'POST',
      headers: authHeaders('a'),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ourTeamId, null);
    assert.equal(fx.jobEvents.jobsCreated, 1);
  } finally {
    await fx.close();
  }
});

test('ownership: request body cannot supply an organization id to override the trusted org -- ' +
     'the route never reads req.body.orgId anywhere (org always comes from getRequestOrgId/user identity)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobu-dl-test-'));
  const orgBTeamId = 'cccccccc-0000-4000-8000-000000000003';
  const fx = await startFixture({
    reportsRoot: root,
    reportsRows: [],
    teamsRows: [{ id: orgBTeamId, org_id: ORG_B, team_name: 'Org B Team' }],
  });
  try {
    const res = await fx.request('/api/run/self-scout', {
      method: 'POST',
      headers: authHeaders('a'),
      body: JSON.stringify({ ourTeamId: orgBTeamId, orgId: ORG_B, org_id: ORG_B }),
    });
    assert.equal(res.status, 404, 'a body-supplied orgId must never widen access to another org\'s team');
  } finally {
    await fx.close();
  }
});
