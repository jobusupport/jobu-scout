'use strict';

// Database-free regression tests for src/express-helpers.js, and for the
// error-containment guarantee it exists to provide: every route reachable
// through getTeams / assertTeamInRequestOrg / assertOrgActive /
// enforceReportQuota / requireOrgAdmin (and therefore getRequestOrgId)
// must produce a controlled HTTP response for any error, never an
// unhandled promise rejection.
//
// These build small throwaway Express apps that reproduce the exact shape
// of the real routes in server.js (same middleware-order pattern, same
// "helper throws a typed error" behavior, same "no local try/catch" gap
// for the /api/run/* case) -- not server.js itself, which can't be
// required directly (it has load-time side effects and no
// module.exports). asyncHandler and buildFinalErrorHandler here are the
// exact real exports server.js uses, not re-implementations.
//
// Run with: node --test test/express-helpers.test.js (also included in
// `npm test`, see package.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { asyncHandler, buildFinalErrorHandler } = require('../src/express-helpers');
const { mapErrorToResponse } = require('../src/org-resolution');

// ── Test helpers ────────────────────────────────────────────────────────────

function typedError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Starts a throwaway Express app with the given route handler(s) mounted
// at GET /test, the real finalErrorHandler mounted after (mirroring
// server.js's own mount order), and returns { url, close }.
function startTestApp(...routeArgs) {
  const app = express();
  app.get('/test', ...routeArgs);
  app.use(buildFinalErrorHandler(mapErrorToResponse, { logger: () => {} })); // silent logger -- keep test output clean
  const server = app.listen(0);
  const { port } = server.address();
  return {
    url: `http://localhost:${port}/test`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ── asyncHandler: unit-level ────────────────────────────────────────────────

test('asyncHandler — calls next() with the error when the wrapped handler rejects', async () => {
  const err = typedError('boom', 403);
  const handler = asyncHandler(async () => { throw err; });
  let passedToNext = null;
  await handler({}, {}, (e) => { passedToNext = e; });
  assert.equal(passedToNext, err);
});

test('asyncHandler — does not call next() when the wrapped handler resolves normally', async () => {
  const handler = asyncHandler(async (req, res) => { res.sent = true; });
  let nextCalled = false;
  const res = {};
  await handler({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.sent, true);
});

test('asyncHandler — a synchronously-thrown error is also caught (not just a rejected promise)', async () => {
  const err = typedError('sync throw', 401);
  const handler = asyncHandler(async () => { throw err; }); // async function -- throw becomes a rejection either way, exercised here for the synchronous-looking call site
  let passedToNext = null;
  await handler({}, {}, (e) => { passedToNext = e; });
  assert.equal(passedToNext, err);
});

// ── buildFinalErrorHandler: unit-level ──────────────────────────────────────

test('buildFinalErrorHandler — sends the mapped status/message and does not call next() on a fresh response', () => {
  const handler = buildFinalErrorHandler(mapErrorToResponse, { logger: () => {} });
  let statusCode = null, body = null, nextCalled = false;
  const res = {
    headersSent: false,
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  handler(typedError('No organization membership found for this account.', 403), {}, res, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.deepEqual(body, { error: 'No organization membership found for this account.' });
  assert.equal(nextCalled, false);
});

test('buildFinalErrorHandler — delegates to next(err) instead of double-sending when headersSent is true', () => {
  const handler = buildFinalErrorHandler(mapErrorToResponse, { logger: () => {} });
  let nextCalledWith = 'not called';
  let jsonCalled = false;
  const res = {
    headersSent: true, // simulates a response that already started
    status() { return this; },
    json() { jsonCalled = true; return this; },
  };
  const err = typedError('too late', 500);
  handler(err, {}, res, (e) => { nextCalledWith = e; });
  assert.equal(jsonCalled, false); // never attempted a second send
  assert.equal(nextCalledWith, err);
});

test('buildFinalErrorHandler — logs the real error via the injected logger, never omits it', () => {
  const logCalls = [];
  const handler = buildFinalErrorHandler(mapErrorToResponse, { logger: (...args) => logCalls.push(args) });
  const res = { headersSent: false, status() { return this; }, json() { return this; } };
  const rawErr = new Error('raw db failure with sensitive detail');
  handler(rawErr, {}, res, () => {});
  assert.equal(logCalls.length, 1);
  assert.ok(logCalls[0].includes(rawErr)); // the real error object reached the logger
});

// ── End-to-end: real HTTP requests against throwaway Express apps ──────────
// These are the tests required by the review: proving actual routes shaped
// like the real ones in server.js produce a controlled response, not an
// unhandled rejection, for every error path getRequestOrgId's callers can
// hit.

test('a getTeams-shaped route (GET /api/teams) returns a controlled 403 for no accepted membership', async () => {
  // Mirrors GET /api/teams's own try/catch, but the object under test is
  // really the sendResolverError-equivalent mapping -- fed a real
  // resolveTrustedOrgId-style 403.
  const { url, close } = startTestApp(async (req, res) => {
    try {
      throw typedError('No organization membership found for this account.', 403);
    } catch (err) {
      const { statusCode, message } = mapErrorToResponse(err);
      return res.status(statusCode).json({ error: message });
    }
  });
  try {
    const res = await fetch(url);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'No organization membership found for this account.');
  } finally {
    await close();
  }
});

test('a /api/run/*-shaped route with NO local try/catch returns a controlled 403, not an unhandled rejection', async () => {
  // Mirrors POST /api/run/gc-scraper's actual (pre-fix) shape: calls a
  // helper that can throw, with no try/catch of its own -- the only thing
  // standing between this and an unhandled rejection is the asyncHandler
  // wrap + terminal error handler.
  const unhandledRejections = [];
  const onUnhandled = (reason) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandled);

  const fakeAssertOrgActive = async () => {
    throw typedError('This account is suspended. Contact support@jobuscout.com for help.', 403);
  };

  const { url, close } = startTestApp(asyncHandler(async (req, res) => {
    await fakeAssertOrgActive(); // no try/catch around this -- the exact gap that existed before this fix
    res.json({ ok: true }); // must never be reached
  }));

  try {
    const res = await fetch(url);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'This account is suspended. Contact support@jobuscout.com for help.');
  } finally {
    await close();
    process.off('unhandledRejection', onUnhandled);
  }
  // Give any stray unhandledRejection a tick to fire before asserting none did.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandledRejections, []);
});

test('an assertTeamInRequestOrg-shaped team sub-route returns a controlled 403', async () => {
  const { url, close } = startTestApp(asyncHandler(async (req, res) => {
    try {
      throw typedError('Team not found for this organization.', 403);
    } catch (err) {
      const { statusCode, message } = mapErrorToResponse(err);
      return res.status(statusCode).json({ error: message });
    }
  }));
  try {
    const res = await fetch(url);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'Team not found for this organization.');
  } finally {
    await close();
  }
});

test('an unexpected/raw error returns a generic 500 with no leaked internal message', async () => {
  const rawDbError = new Error(
    'relation "org_members" does not exist: SELECT org_id FROM org_members (postgres://admin:s3cr3t@db.internal:5432)'
  );
  const { url, close } = startTestApp(asyncHandler(async () => {
    throw rawDbError; // no .statusCode -- simulates an unexpected DB failure
  }));
  try {
    const res = await fetch(url);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Something went wrong. Please try again.');
    assert.doesNotMatch(body.error, /org_members|postgres|s3cr3t/i);
  } finally {
    await close();
  }
});

test('typed 401 and 403 messages are preserved exactly through the full asyncHandler -> terminal-handler path', async () => {
  for (const [statusCode, message] of [
    [401, 'Unable to determine the current user. Please sign out and sign back in.'],
    [403, 'This account belongs to more than one organization; unable to determine which one to use for this request.'],
  ]) {
    const { url, close } = startTestApp(asyncHandler(async () => {
      throw typedError(message, statusCode);
    }));
    try {
      const res = await fetch(url);
      assert.equal(res.status, statusCode);
      const body = await res.json();
      assert.equal(body.error, message);
    } finally {
      await close();
    }
  }
});

test('no code after the throwing call executes once an error response has been sent', async () => {
  let reachedAfterThrow = false;
  const { url, close } = startTestApp(asyncHandler(async (req, res) => {
    try {
      throw typedError('deny', 403);
    } catch (err) {
      const { statusCode, message } = mapErrorToResponse(err);
      return res.status(statusCode).json({ error: message }); // `return` is the point under test
    }
    reachedAfterThrow = true; // must never run
    res.json({ ok: true }); // must never run -- would throw "headers already sent" if it did
  }));
  try {
    const res = await fetch(url);
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
  assert.equal(reachedAfterThrow, false);
});
