'use strict';

// Proves requireAuth + requireJobuAdmin are actually mounted ahead of
// PATCH /customers/:orgId/product in the REAL router built by
// src/admin-api.js's createAdminRouter -- not merely assumed from reading
// the file. Sends a real HTTP request through a throwaway Express app
// mounting the actual router (not a re-implementation of it), with a fake
// requireAuth injected the same way server.js injects the real one
// (createAdminRouter({ requireAuth })).
//
// Stays database-free: src/admin-lib.js's isJobuAdmin(user) short-circuits
// to {isAdmin:false} BEFORE any Supabase call whenever user is falsy or
// has no .id (see admin-lib.js's own `if (!user?.id) return ...` guard) --
// so a fake requireAuth that leaves req.user unset never triggers a real
// network call on the authorization path itself. requireJobuAdmin's
// denial path does fire-and-forget an audit-log write (logAdminAction, NOT
// awaited before the 403 response is sent) which does attempt one real
// (and, in this environment, failing) outbound request; it's wrapped in
// its own .catch(() => {}) inside admin-lib.js, so it can never affect
// this test's assertions, delay the response, or fail the suite -- only
// produce harmless background network noise after the test has already
// finished asserting.
//
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set to dummy values below,
// only so requiring src/admin-api.js doesn't throw at load time
// (src/supabase.js constructs its client eagerly, and
// @supabase/supabase-js refuses to do that without a URL) -- not because
// any real Supabase call is expected or needed to succeed.
//
// Run with: node --test test/admin-api-product-route-wiring.test.js (also
// included in `npm test`, see package.json).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const createAdminRouter = require('../src/admin-api');

const PRODUCT_ROUTE_URL_PATH = '/api/admin/customers/11111111-1111-4111-8111-111111111111/product';

function startApp({ requireAuth }) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ requireAuth }));
  const server = app.listen(0);
  const { port } = server.address();
  return {
    url: `http://localhost:${port}${PRODUCT_ROUTE_URL_PATH}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('PATCH /customers/:orgId/product — requireAuth is actually invoked for this route (not bypassed)', async () => {
  let requireAuthCalled = false;
  const { url, close } = startApp({
    requireAuth: (req, res, next) => { requireAuthCalled = true; next(); }, // deliberately leaves req.user unset
  });
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerType: 'travel', reason: 'r' }),
    });
    assert.equal(requireAuthCalled, true);
  } finally {
    await close();
  }
});

test('PATCH /customers/:orgId/product — requireJobuAdmin denies with 403 when req.user is unset, proving it runs after requireAuth and BEFORE the route handler ever executes', async () => {
  const { url, close } = startApp({
    requireAuth: (req, res, next) => next(), // no req.user set at all
  });
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerType: 'travel', reason: 'r' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    // Exactly requireJobuAdmin's own denial message -- if the route
    // handler had run instead (i.e. if requireJobuAdmin were NOT actually
    // mounted ahead of it), handleProductChange's own actor-identity check
    // would have produced a different message (the generic 500 from
    // src/admin-product-route.js's validateActorIdentity, since req.user
    // is unset here), not this one.
    assert.deepEqual(body, { error: 'Forbidden' });
  } finally {
    await close();
  }
});
