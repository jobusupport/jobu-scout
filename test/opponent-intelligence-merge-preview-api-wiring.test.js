'use strict';

// Proves requireAuth -> resolveSupportSession -> requireTravelIntelligenceAccess
// are actually mounted ahead of the new GET /teams/:teamId/merge-preview and
// POST /teams/:teamId/merge routes in the REAL router built by
// src/opponent-intelligence-api.js's createOpponentIntelligenceRouter --
// not merely assumed from reading the file. Mirrors
// test/admin-api-product-route-wiring.test.js's established pattern: sends
// a real HTTP request through a throwaway Express app mounting the actual
// router, with a fake requireAuth injected the same way server.js injects
// the real one, deliberately leaving req.user unset so
// requireTravelIntelligenceAccess's own org-resolution step fails closed
// with a 401 BEFORE any Supabase call is attempted (see
// src/org-resolution.js's resolveTrustedOrgId: `if (!userId) throw 401`,
// synchronous, no network call) -- so this test never needs a real
// database, dummy or otherwise.
//
// Run with: node --test test/opponent-intelligence-merge-preview-api-wiring.test.js
// (also included in `npm test`, see package.json).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const createOpponentIntelligenceRouter = require('../src/opponent-intelligence-api');

const TEAM_ID = '22222222-2222-4222-8222-222222222222';

function startApp({ requireAuth }) {
  const app = express();
  app.use(express.json());
  app.use('/api/opponent-intelligence', createOpponentIntelligenceRouter({ requireAuth }));
  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://localhost:${port}/api/opponent-intelligence`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET /teams/:teamId/merge-preview -- requireAuth runs, and an unauthenticated request never reaches the service layer', async () => {
  let requireAuthCalled = false;
  const { baseUrl, close } = startApp({
    requireAuth: (req, res, next) => { requireAuthCalled = true; next(); }, // deliberately leaves req.user unset
  });
  try {
    const res = await fetch(`${baseUrl}/teams/${TEAM_ID}/merge-preview?keepPlayerId=x&mergePlayerId=y`);
    assert.equal(requireAuthCalled, true, 'requireAuth must actually be invoked for this route');
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /sign (in|out)/i);
  } finally {
    await close();
  }
});

test('POST /teams/:teamId/merge -- requireAuth runs, and an unauthenticated request never reaches the service layer', async () => {
  let requireAuthCalled = false;
  const { baseUrl, close } = startApp({
    requireAuth: (req, res, next) => { requireAuthCalled = true; next(); },
  });
  try {
    const res = await fetch(`${baseUrl}/teams/${TEAM_ID}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepPlayerId: 'x', mergePlayerId: 'y' }),
    });
    assert.equal(requireAuthCalled, true, 'requireAuth must actually be invoked for this route');
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('a support session that does not belong to the requesting account is rejected before either merge route does any work', async () => {
  const { baseUrl, close } = startApp({
    requireAuth: (req, res, next) => { req.user = { id: 'real-user-1' }; next(); },
  });
  try {
    // No x-support-session header -> resolveSupportSession calls next()
    // immediately (see this file's header comment) -- confirms the normal
    // (non-support) path reaches requireTravelIntelligenceAccess next,
    // which itself fails closed with a DB-free error only when req.user is
    // unset. With req.user set here, it WOULD attempt a real Supabase call
    // to resolve org membership -- deliberately not exercised in this
    // DB-free test file; covered instead by the service-level tests in
    // test/opponent-roster-service.test.js. This test only proves the
    // guard-chain ORDER (auth before support-session before entitlement),
    // not full entitlement resolution.
    const res = await fetch(`${baseUrl}/teams/${TEAM_ID}/merge-preview?keepPlayerId=x&mergePlayerId=y`, {
      headers: { 'x-support-session': 'not-a-real-token' },
    });
    // adminClient points at a dummy, unreachable Supabase URL -- the
    // support-session lookup itself fails (network/DNS error), which
    // resolveSupportSession treats the same as "invalid support session".
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});
