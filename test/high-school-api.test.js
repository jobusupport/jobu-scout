'use strict';

// Focused, database-free tests for src/high-school-api.js:
//
//   1. hasHighSchoolEntitlement -- the pure authorization decision,
//      exhaustively unit tested the same way
//      test/product-capabilities.test.js already tests
//      resolveOrganizationCapabilities: no request, no database, just the
//      capabilities shape in, a boolean out.
//   2. Route wiring -- proves requireAuth is actually invoked ahead of
//      every route (not bypassed), and that a request that gets past a
//      fake requireAuth without a resolvable organization is denied, not
//      silently allowed through. Mirrors
//      test/admin-api-product-route-wiring.test.js's real-Express-app +
//      injected-requireAuth pattern exactly.
//
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set to dummy values below only
// so requiring src/high-school-api.js doesn't throw at load time
// (src/supabase.js constructs its client eagerly) -- not because any real
// Supabase call is expected or needed to succeed. Every wiring test below
// either fails closed before reaching a real network call, or the network
// call itself fails against the dummy host and is caught by the route's
// own try/catch, which is exactly the fail-closed behavior being proven.
//
// Full live-data behavior (a real HS-entitled org retrieving real
// fixtures, a real Travel-only org being rejected, real tenant isolation)
// is covered by test/high-school-api-integration.test.js, gated the same
// way test/api-product-capabilities.test.js already gates equivalent
// live-data tests -- skipped by default, requires explicit non-production
// credentials.
//
// Run with: node --test test/high-school-api.test.js

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { hasHighSchoolEntitlement } = require('../src/high-school-api.js');
const createHighSchoolRouter = require('../src/high-school-api.js');

// ── 1. hasHighSchoolEntitlement (pure decision logic) ───────────────────

test('Travel-only capabilities are denied High School access', () => {
  assert.equal(hasHighSchoolEntitlement({ enabledProducts: ['travel'] }), false);
});

test('High-School-only capabilities are granted access', () => {
  assert.equal(hasHighSchoolEntitlement({ enabledProducts: ['high_school'] }), true);
});

test('Hybrid capabilities (both products enabled) are granted access', () => {
  assert.equal(hasHighSchoolEntitlement({ enabledProducts: ['travel', 'high_school'] }), true);
});

test('Internal-account capabilities follow the same enabledProducts check as any other org', () => {
  assert.equal(hasHighSchoolEntitlement({ enabledProducts: ['travel', 'high_school'], customerType: 'internal' }), true);
});

test('missing capabilities object fails closed to denied, never to "allow everything"', () => {
  assert.equal(hasHighSchoolEntitlement(undefined), false);
  assert.equal(hasHighSchoolEntitlement(null), false);
});

test('non-array enabledProducts fails closed to denied', () => {
  assert.equal(hasHighSchoolEntitlement({ enabledProducts: 'high_school' }), false);
});

test('missing enabledProducts field fails closed to denied', () => {
  assert.equal(hasHighSchoolEntitlement({}), false);
});

test('a client cannot expand access merely by adding extra/unknown values to enabledProducts', () => {
  // The check is a simple .includes('high_school') -- proving here that
  // no other value, however crafted, substitutes for the real one.
  assert.equal(hasHighSchoolEntitlement({ enabledProducts: ['travel', 'HIGH_SCHOOL', 'high-school', 'highSchool'] }), false);
});

// ── 2. Route wiring ──────────────────────────────────────────────────────

function startApp({ requireAuth }) {
  const app = express();
  app.use(express.json());
  app.use('/api/high-school', createHighSchoolRouter({ requireAuth }));
  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://localhost:${port}/api/high-school`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ROUTES = [
  { method: 'GET', path: '/program' },
  { method: 'GET', path: '/seasons' },
  { method: 'GET', path: '/teams' },
  { method: 'GET', path: '/teams/11111111-1111-4111-8111-111111111111/roster' },
];

for (const { method, path } of ROUTES) {
  test(`${method} ${path} — requireAuth is actually invoked (not bypassed)`, async () => {
    let requireAuthCalled = false;
    const { baseUrl, close } = startApp({
      requireAuth: (req, res, next) => { requireAuthCalled = true; next(); }, // deliberately leaves req.user unset
    });
    try {
      await fetch(baseUrl + path, { method });
      assert.equal(requireAuthCalled, true);
    } finally {
      await close();
    }
  });

  test(`${method} ${path} — a request that gets past requireAuth with no resolvable user is denied, not silently allowed through (200)`, async () => {
    const { baseUrl, close } = startApp({
      requireAuth: (req, res, next) => next(), // no req.user set at all -- getRequestOrgId must reject this
    });
    try {
      const res = await fetch(baseUrl + path, { method });
      assert.notEqual(res.status, 200);
    } finally {
      await close();
    }
  });
}

test('no route in this router accepts POST, PUT, PATCH, or DELETE (read-only slice)', async () => {
  const { baseUrl, close } = startApp({ requireAuth: (req, res, next) => next() });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}/program`, { method });
      // Express reports an unmatched method+path combination as 404 (no
      // route registered for POST /program etc.) rather than routing it
      // to the GET handler -- proving no mutation route exists here.
      assert.equal(res.status, 404, `expected no route for ${method} /program`);
    }
  } finally {
    await close();
  }
});

function loadSourceStatementsOnly() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'high-school-api.js'), 'utf8');
  // Strip // comment lines -- the file's own header comments explain (in
  // prose) that this module never reads req.body, which would otherwise
  // false-positive against a naive full-source check.
  return src
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

test('the module source never reads req.body anywhere', () => {
  assert.doesNotMatch(loadSourceStatementsOnly(), /req\.body/);
});

test('the module source never trusts a client-supplied organization id (no req.query.orgId / req.params.orgId / req.body reference of any kind for org resolution)', () => {
  const statementsOnly = loadSourceStatementsOnly();
  assert.doesNotMatch(statementsOnly, /req\.(query|params)\.orgId/);
  assert.doesNotMatch(statementsOnly, /req\.body\.(orgId|enabledProducts|organizationId)/);
});
