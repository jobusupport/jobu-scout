'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  createJobRecord,
  findJobForOrg,
} = require('../src/job-store');
const {
  createStreamCredentialStore,
  registerTravelJobRoutes,
} = require('../src/travel-job-routes');

const USERS = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  admin: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  noTravel: '33333333-3333-4333-8333-333333333333',
};
const USER_ORGS = {
  [USERS.a]: 'org-a',
  [USERS.b]: 'org-b',
  [USERS.admin]: 'org-b',
  [USERS.noTravel]: 'org-no-travel',
};
const SUPPORT = {
  'support-a-read': { orgId: 'org-a', mode: 'read_only' },
  'support-a-write': { orgId: 'org-a', mode: 'interactive' },
  'support-b-write': { orgId: 'org-b', mode: 'interactive' },
};

async function startFixture() {
  const jobs = {};
  const metrics = { timers: 0, clears: 0, stops: 0, serializations: 0 };
  const streamCredentials = createStreamCredentialStore();

  const createJob = (orgId, status = 'running') => {
    const id = createJobRecord(jobs, 'Travel job', orgId, {
      createdByUserId: USERS.a,
      onSerialize: () => { metrics.serializations += 1; },
    });
    jobs[id].status = status;
    jobs[id].logs.push({ line: 'hello' });
    return id;
  };

  function requireAuth(req, res, next) {
    const key = req.get('authorization')?.replace(/^Bearer /, '');
    const id = USERS[key];
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id, email: `${key}@example.test` };
    next();
  }

  function resolveSupportSession(req, res, next) {
    const token = req.get('x-support-session');
    if (!token) return next();
    const session = SUPPORT[token];
    if (!session || req.user.id !== USERS.admin) {
      return res.status(401).json({ error: 'Invalid support session' });
    }
    req._orgId = session.orgId;
    req._supportSession = { mode: session.mode };
    next();
  }

  function requireTravelAccess(req, res, next) {
    const orgId = req._orgId || USER_ORGS[req.user.id];
    if (orgId === 'org-no-travel') return res.status(403).json({ error: 'Travel access required' });
    req._orgId = orgId;
    next();
  }

  function blockWriteDuringReadOnlySupport(req, res, next) {
    if (req._supportSession?.mode === 'read_only') {
      return res.status(403).json({ error: 'Support session is read-only' });
    }
    next();
  }

  const app = express();
  app.use(express.json());
  registerTravelJobRoutes(app, {
    jobs,
    requireAuth,
    resolveSupportSession,
    requireTravelAccess,
    blockWriteDuringReadOnlySupport,
    getRequestOrgId: async (req) => req._orgId || USER_ORGS[req.user.id],
    findJobForOrg,
    sendResolverError: (res) => res.status(500).json({ error: 'Organization resolution failed' }),
    stopJobProcess: () => { metrics.stops += 1; return true; },
    appendLog: (id, line) => jobs[id]?.logs.push({ line }),
    finishJob: (id) => { if (jobs[id]) jobs[id].status = 'stopped'; },
    streamCredentials,
    setIntervalFn: (callback) => {
      metrics.timers += 1;
      return setInterval(callback, 10);
    },
    clearIntervalFn: (timer) => {
      metrics.clears += 1;
      clearInterval(timer);
    },
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    jobs,
    metrics,
    streamCredentials,
    createJob,
    request: (path, options) => fetch(`${baseUrl}${path}`, options),
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function auth(user, support) {
  const headers = { authorization: `Bearer ${user}` };
  if (support) headers['x-support-session'] = support;
  return { headers };
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function issueStream(fixture, jobId, user, support) {
  const response = await fixture.request(`/api/jobs/${jobId}/stream-credential`, {
    method: 'POST',
    ...auth(user, support),
  });
  const body = await response.json();
  return { response, body };
}

test('actual status route enforces authentication, entitlement, ownership, and support organization', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a', 'done');
  f.jobs.unowned = { id: 'unowned', status: 'done' };
  f.jobs.malformed = { id: 'malformed', org_id: 42, status: 'done' };

  assert.equal((await f.request(`/api/jobs/${id}`)).status, 401);
  assert.equal((await f.request(`/api/jobs/${id}`, auth('noTravel'))).status, 403);

  const own = await jsonResponse(await f.request(`/api/jobs/${id}`, auth('a')));
  assert.equal(own.status, 200);
  assert.equal(own.body.id, id);
  for (const secret of ['org_id', 'created_by_user_id', 'proc']) {
    assert.equal(Object.hasOwn(own.body, secret), false);
  }

  const hiddenBodies = [];
  for (const [path, credentials] of [
    [`/api/jobs/${id}`, auth('b')],
    [`/api/jobs/${id}`, auth('admin', 'support-b-write')],
    ['/api/jobs/missing', auth('a')],
    ['/api/jobs/unowned', auth('a')],
    ['/api/jobs/malformed', auth('a')],
  ]) {
    hiddenBodies.push(await jsonResponse(await f.request(path, credentials)));
  }
  assert.deepEqual(hiddenBodies, hiddenBodies.map(() => ({
    status: 404,
    body: { error: 'Job not found' },
  })));

  const supported = await jsonResponse(
    await f.request(`/api/jobs/${id}`, auth('admin', 'support-a-read'))
  );
  assert.equal(supported.status, 200);
  assert.equal(supported.body.id, id);
});

test('actual stream route uses job-bound short-lived credentials and authorizes before SSE setup', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a', 'done');

  assert.equal((await f.request(`/api/jobs/${id}/stream`)).status, 401);
  const invalid = await f.request(`/api/jobs/${id}/stream?stream_token=forged`);
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.has('content-type'), false);
  assert.equal(f.metrics.timers, 0);

  const ordinary = await issueStream(f, id, 'a');
  assert.equal(ordinary.response.status, 200);
  const streamed = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(ordinary.body.streamToken)}`
  );
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('content-type'), 'text/event-stream');
  assert.match(await streamed.text(), /"done":true/);

  assert.equal((await issueStream(f, id, 'b')).response.status, 404);
  assert.equal((await issueStream(f, id, 'admin', 'support-b-write')).response.status, 404);
  assert.equal((await issueStream(f, id, 'admin', 'expired')).response.status, 401);
  assert.equal((await issueStream(f, id, 'admin', 'forged')).response.status, 401);

  const supported = await issueStream(f, id, 'admin', 'support-a-read');
  assert.equal(supported.response.status, 200);
  const supportedStream = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(supported.body.streamToken)}`
  );
  assert.equal(supportedStream.status, 200);
  assert.match(await supportedStream.text(), /"done":true/);

  const revoked = await issueStream(f, id, 'admin', 'support-a-read');
  const savedSupport = SUPPORT['support-a-read'];
  delete SUPPORT['support-a-read'];
  const revokedResponse = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(revoked.body.streamToken)}`
  );
  SUPPORT['support-a-read'] = savedSupport;
  assert.equal(revokedResponse.status, 401);

  const foreignCredential = f.streamCredentials.issue({
    user: { id: USERS.b },
    jobId: id,
  });
  const timersBeforeForeign = f.metrics.timers;
  const rejected = await f.request(
    `/api/jobs/${id}/stream?stream_token=${foreignCredential.token}`
  );
  assert.equal(rejected.status, 404);
  assert.equal(rejected.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(f.metrics.timers, timersBeforeForeign);

  const wrongJob = f.createJob('org-a', 'done');
  const mismatched = await f.request(
    `/api/jobs/${wrongJob}/stream?stream_token=${ordinary.body.streamToken}`
  );
  assert.equal(mismatched.status, 401);
  assert.equal(f.metrics.timers, timersBeforeForeign);
});

test('authorized running stream removes its real interval when the client disconnects', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a');
  const issued = await issueStream(f, id, 'a');
  const controller = new AbortController();
  const response = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(issued.body.streamToken)}`,
    { signal: controller.signal }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), /abort/i);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.metrics.timers, 1);
  assert.ok(f.metrics.clears >= 1);
});

test('stream credential expiry and support-session binding fail closed', () => {
  let now = 1_000;
  const store = createStreamCredentialStore({ now: () => now, ttlMs: 50 });
  const issued = store.issue({ user: { id: USERS.admin }, jobId: 'job', supportSessionToken: 'support-a-read' });
  assert.equal(store.resolve(issued.token, 'job').supportSessionToken, 'support-a-read');
  now += 51;
  assert.equal(store.resolve(issued.token, 'job'), null);
  assert.equal(store.size(), 0);
});

test('actual stop route blocks foreign and read-only callers before cancellation', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a');

  assert.equal((await f.request(`/api/jobs/${id}/stop`, { method: 'POST' })).status, 401);
  assert.equal((await f.request(`/api/jobs/${id}/stop`, {
    method: 'POST',
    ...auth('noTravel'),
  })).status, 403);
  assert.equal(f.metrics.stops, 0);

  for (const credentials of [
    auth('b'),
    auth('admin', 'support-b-write'),
  ]) {
    const rejected = await f.request(`/api/jobs/${id}/stop`, {
      method: 'POST',
      ...credentials,
    });
    assert.equal(rejected.status, 404);
    assert.equal(f.metrics.stops, 0);
  }

  const readOnly = await f.request(`/api/jobs/${id}/stop`, {
    method: 'POST',
    ...auth('admin', 'support-a-read'),
  });
  assert.equal(readOnly.status, 403);
  assert.equal(f.metrics.stops, 0);

  const writeCapable = await f.request(`/api/jobs/${id}/stop`, {
    method: 'POST',
    ...auth('admin', 'support-a-write'),
  });
  assert.equal(writeCapable.status, 200);
  assert.equal(f.metrics.stops, 1);
  assert.equal(f.jobs[id].status, 'stopped');

  const ownId = f.createJob('org-a');
  const ordinary = await f.request(`/api/jobs/${ownId}/stop`, {
    method: 'POST',
    ...auth('a'),
  });
  assert.equal(ordinary.status, 200);
  assert.equal(f.metrics.stops, 2);

  for (const missing of ['missing', 'malformed', 'unowned']) {
    if (missing === 'malformed') f.jobs[missing] = { id: missing, org_id: 9 };
    if (missing === 'unowned') f.jobs[missing] = { id: missing };
    const response = await f.request(`/api/jobs/${missing}/stop`, {
      method: 'POST',
      ...auth('a'),
    });
    assert.equal(response.status, 404);
  }
  assert.equal(f.metrics.stops, 2);
});
