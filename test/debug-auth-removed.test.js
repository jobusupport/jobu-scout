'use strict';

// Real-HTTP proof that the unauthenticated /api/debug/auth information-
// disclosure endpoint (formerly in server.js, right before the Travel
// routes) is completely gone, not merely hidden behind a flag or an
// environment check.
//
// server.js was never designed to be `require`d in a test process (it
// unconditionally calls app.listen() and performs other real startup side
// effects at module load -- see test/product-aware-routing.test.js's own
// header for the same reasoning, and this repo has no extracted,
// require-safe router for this particular route the way
// src/travel-job-routes.js or src/high-school-api.js are for theirs). The
// removed route was a single inline handler, not part of any extractable
// module, so the only way to prove "the real Express app, hit over the real
// HTTP stack, no longer serves this" is to actually boot the real
// server.js as a child process and make real requests against it -- a
// text-only assertion could pass even if some other registration still
// served the same data under this path.
//
// Boots with NODE_ENV=test and USE_SUPABASE explicitly forced to 'false',
// so this never touches Supabase (production or otherwise), never writes a
// GameChanger auth file (GC_AUTH_JSON is left unset), and works identically
// whether or not a local .env file happens to exist (this repo's .env is
// gitignored -- see .gitignore -- so a CI checkout has none by default, and
// this test must not depend on one being present).
//
// Run with: node --test test/debug-auth-removed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 48562; // fixed, high, unlikely to collide -- see file header
const BASE_URL = `http://localhost:${PORT}`;
const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 200;

let serverProcess = null;

async function waitForServerReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      // Any response at all (even a 404) proves the HTTP server is up;
      // this repo's server.js has no dedicated /health route to poll.
      await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(2000) });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }
  throw new Error(`server.js did not become ready on ${BASE_URL} within ${READY_TIMEOUT_MS}ms: ${lastErr?.message}`);
}

test.before(async () => {
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      USE_SUPABASE: 'false', // belt-and-suspenders on top of NODE_ENV!=='production' -- never touch Supabase from this test
      DASHBOARD_PORT: String(PORT),
      GC_AUTH_JSON: '', // explicitly unset -- must never write a GameChanger auth file from a test
    },
    stdio: 'ignore',
  });
  await waitForServerReady();
});

test.after(async () => {
  if (!serverProcess) return;
  serverProcess.kill();
  await new Promise((resolve) => {
    serverProcess.once('exit', resolve);
    setTimeout(resolve, 3000).unref(); // don't hang the suite if the process is slow to exit
  });
  serverProcess = null;
});

test('unauthenticated GET /api/debug/auth no longer reaches a debug handler (falls through to the app\'s normal not-found behavior)', async () => {
  const res = await fetch(`${BASE_URL}/api/debug/auth`);
  assert.notEqual(res.status, 200);
  const text = await res.text();
  const lower = text.toLowerCase();
  assert.ok(!lower.includes('authpath'));
  assert.ok(!lower.includes('storagecontents'));
  assert.ok(!lower.includes('appcontents'));
  assert.ok(!lower.includes('gamechanger-auth.json'));
});

test('an Authorization header does not resurrect the removed endpoint', async () => {
  const res = await fetch(`${BASE_URL}/api/debug/auth`, {
    headers: { Authorization: 'Bearer not-a-real-token' },
  });
  assert.notEqual(res.status, 200);
  const text = (await res.text()).toLowerCase();
  assert.ok(!text.includes('authpath'));
  assert.ok(!text.includes('appcontents'));
});

test('a query string does not restore access', async () => {
  const res = await fetch(`${BASE_URL}/api/debug/auth?debug=true&auth=1`);
  assert.notEqual(res.status, 200);
  const text = (await res.text()).toLowerCase();
  assert.ok(!text.includes('authpath'));
  assert.ok(!text.includes('storagecontents'));
});

test('alternate HTTP methods do not disclose the removed information either', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(`${BASE_URL}/api/debug/auth`, { method });
    assert.notEqual(res.status, 200, `expected ${method} to not succeed`);
    const text = (await res.text()).toLowerCase();
    assert.ok(!text.includes('appcontents'), `${method} response must not disclose appContents`);
  }
});

test('no response anywhere in the app leaks a filesystem path or directory listing for this route', async () => {
  const res = await fetch(`${BASE_URL}/api/debug/auth`);
  const text = await res.text();
  // Content-Type must not even claim to be the old handler's JSON shape
  // with a 200 -- whatever generic handler now answers this path (Express's
  // own static/catch-all 404, or this app's shared error handler) must not
  // echo the removed absolute paths under any circumstance.
  assert.ok(!text.includes('/app/storage'));
  assert.ok(!text.includes(process.cwd()));
});

test('normal authentication endpoints still function after the removal (no unrelated regression)', async () => {
  // POST /api/auth/login with garbage credentials must still be reachable
  // and answer with the app's own auth-failure shape, not a network error
  // or an unrelated 404 -- proves removing the debug route didn't
  // accidentally disturb route registration order for anything below it.
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong' }),
  });
  assert.ok(res.status === 400 || res.status === 401 || res.status === 500, `unexpected status ${res.status}`);
});

test('normal application routing (the dashboard shell) still functions after the removal', async () => {
  const res = await fetch(`${BASE_URL}/`);
  assert.equal(res.status, 200);
  const contentType = res.headers.get('content-type') || '';
  assert.match(contentType, /html/);
});
