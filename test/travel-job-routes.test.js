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

async function startFixture(overrides = {}) {
  const jobs = {};
  const metrics = {
    timers: 0,
    clears: 0,
    expiryTimers: 0,
    expiryClears: 0,
    opened: 0,
    stops: 0,
    serializations: 0,
  };
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
    setTimeoutFn: (callback, delay) => {
      metrics.expiryTimers += 1;
      return setTimeout(callback, delay);
    },
    clearTimeoutFn: (timer) => {
      metrics.expiryClears += 1;
      clearTimeout(timer);
    },
    onStreamOpened: () => { metrics.opened += 1; },
    ...overrides,
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
    orgId: 'org-b',
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

test('one-time bootstrap rejects sequential HTTP replay without new SSE setup', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a', 'done');
  const issued = await issueStream(f, id, 'a');
  const path = `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(issued.body.streamToken)}`;

  const first = await f.request(path);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /"done":true/);
  const openedAfterFirst = f.metrics.opened;
  const timersAfterFirst = f.metrics.timers;

  const replay = await f.request(path);
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.has('content-type'), false);
  assert.equal(await replay.text(), '');
  assert.equal(f.metrics.opened, openedAfterFirst);
  assert.equal(f.metrics.timers, timersAfterFirst);
  assert.equal(f.streamCredentials.size(), 0);
  assert.equal(f.streamCredentials.activeSize(), 0);
});

test('issuing a newer bootstrap invalidates the older unconsumed generation', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a', 'done');
  const older = await issueStream(f, id, 'a');
  const latest = await issueStream(f, id, 'a');

  const stale = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(older.body.streamToken)}`
  );
  assert.equal(stale.status, 401);
  assert.equal(f.metrics.opened, 0);

  const current = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(latest.body.streamToken)}`
  );
  assert.equal(current.status, 200);
  assert.match(await current.text(), /"done":true/);
  assert.equal(f.metrics.opened, 1);
});

test('two genuinely overlapping HTTP presentations atomically permit exactly one stream', async (t) => {
  let releaseFirst;
  let markConsumed;
  const firstConsumed = new Promise((resolve) => { markConsumed = resolve; });
  const barrier = new Promise((resolve) => { releaseFirst = resolve; });
  let hookCalls = 0;
  const f = await startFixture({
    afterStreamCredentialConsumed: async () => {
      hookCalls += 1;
      markConsumed();
      await barrier;
    },
  });
  t.after(() => f.close());
  const id = f.createJob('org-a', 'done');
  const issued = await issueStream(f, id, 'a');
  const path = `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(issued.body.streamToken)}`;

  const firstPromise = f.request(path);
  await firstConsumed;
  const second = await f.request(path);
  assert.equal(second.status, 401);
  assert.equal(await second.text(), '');
  assert.equal(f.metrics.opened, 0);
  assert.equal(f.metrics.timers, 0);
  assert.equal(hookCalls, 1);

  releaseFirst();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.match(await first.text(), /"done":true/);
  assert.equal(f.metrics.opened, 1);
  assert.equal(f.metrics.timers, 1);
  assert.equal(f.streamCredentials.activeSize(), 0);
});

test('deliberate reconnect requires a fresh authenticated bootstrap and stale generations fail', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a');

  const initial = await issueStream(f, id, 'a');
  const initialPath = `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(initial.body.streamToken)}`;
  const firstController = new AbortController();
  const first = await f.request(initialPath, { signal: firstController.signal });
  assert.equal(first.status, 200);
  await first.body.getReader().read();
  assert.equal(f.streamCredentials.activeSize(), 1);
  firstController.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.streamCredentials.activeSize(), 0);

  const stale = await f.request(initialPath);
  assert.equal(stale.status, 401);

  const reconnect = await issueStream(f, id, 'a');
  const reconnectPath = `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(reconnect.body.streamToken)}`;
  const reconnectController = new AbortController();
  const connected = await f.request(reconnectPath, { signal: reconnectController.signal });
  assert.equal(connected.status, 200);
  await connected.body.getReader().read();
  assert.equal(f.streamCredentials.activeSize(), 1);
  reconnectController.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.streamCredentials.activeSize(), 0);

  const reconnectReplay = await f.request(reconnectPath);
  assert.equal(reconnectReplay.status, 401);
  assert.equal(f.metrics.opened, 2);
  assert.equal(f.metrics.timers, 2);
  assert.ok(f.metrics.clears >= 2);
  assert.ok(f.metrics.expiryClears >= 2);
});

test('fresh authenticated bootstrap revokes an older active generation for race recovery', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a');
  const firstToken = await issueStream(f, id, 'a');
  const first = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(firstToken.body.streamToken)}`
  );
  const firstReader = first.body.getReader();
  await firstReader.read();
  assert.equal(f.streamCredentials.activeSize(), 1);

  const replacement = await issueStream(f, id, 'a');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.streamCredentials.activeSize(), 0);
  const replacementController = new AbortController();
  const recovered = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(replacement.body.streamToken)}`,
    { signal: replacementController.signal }
  );
  assert.equal(recovered.status, 200);
  await recovered.body.getReader().read();
  assert.equal(f.streamCredentials.activeSize(), 1);
  replacementController.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.streamCredentials.activeSize(), 0);
  await firstReader.cancel().catch(() => {});
});

test('reconnect revalidates support revocation, Travel entitlement, and effective ownership', async (t) => {
  const f = await startFixture();
  t.after(() => f.close());
  const id = f.createJob('org-a', 'done');

  const supportBootstrap = await issueStream(f, id, 'admin', 'support-a-read');
  const savedSupport = SUPPORT['support-a-read'];
  delete SUPPORT['support-a-read'];
  try {
    const revoked = await f.request(
      `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(supportBootstrap.body.streamToken)}`
    );
    assert.equal(revoked.status, 401);
    assert.equal(f.metrics.opened, 0);
  } finally {
    SUPPORT['support-a-read'] = savedSupport;
  }

  const entitlementBootstrap = await issueStream(f, id, 'a');
  const savedOrg = USER_ORGS[USERS.a];
  USER_ORGS[USERS.a] = 'org-no-travel';
  try {
    const denied = await f.request(
      `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(entitlementBootstrap.body.streamToken)}`
    );
    assert.equal(denied.status, 403);
    assert.equal(f.metrics.opened, 0);
  } finally {
    USER_ORGS[USERS.a] = savedOrg;
  }
  const consumedAfterDenial = await f.request(
    `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(entitlementBootstrap.body.streamToken)}`
  );
  assert.equal(consumedAfterDenial.status, 401);

  const ownershipBootstrap = await issueStream(f, id, 'a');
  USER_ORGS[USERS.a] = 'org-b';
  try {
    const foreign = await f.request(
      `/api/jobs/${id}/stream?stream_token=${encodeURIComponent(ownershipBootstrap.body.streamToken)}`
    );
    assert.equal(foreign.status, 404);
    assert.equal(f.metrics.opened, 0);
  } finally {
    USER_ORGS[USERS.a] = savedOrg;
  }
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
  const issued = store.issue({
    user: { id: USERS.admin },
    jobId: 'job',
    orgId: 'org-a',
    supportSessionToken: 'support-a-read',
  });
  assert.equal(store.consume(issued.token, 'wrong-job'), null);
  assert.equal(store.consume(issued.token, 'job').supportSessionToken, 'support-a-read');
  assert.equal(store.consume(issued.token, 'job'), null);
  const expiring = store.issue({ user: { id: USERS.admin }, jobId: 'job', orgId: 'org-a' });
  const entry = store.consume(expiring.token, 'job');
  let closed = 0;
  assert.ok(store.activate(entry, () => { closed += 1; }));
  assert.equal(store.activeSize(), 1);
  now += 51;
  assert.equal(store.activeSize(), 0);
  assert.equal(closed, 1);
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
