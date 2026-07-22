'use strict';

// Integration tests for GET /api/product/capabilities and
// requireProductAccess, per docs/architecture/PHASE_2_PRODUCT_CAPABILITY_RFC.md §21.
//
// WRITTEN BUT NOT EXECUTED by default. These require:
//   1. The Phase 2 Slice 1 migration
//      (supabase/migrations/20260721140000_add_organization_product_fields.sql).
//      Applied to production as of the Supabase migration-governance work
//      documented in supabase/README.md -- still not something these tests
//      run against directly; point TEST_BASE_URL/SUPABASE_URL at a
//      non-production project with the same migration applied.
//   2. A running instance of this application's server (server.js),
//      reachable at TEST_BASE_URL.
//   3. Seeded test organizations/users -- see scripts/test-user-setup.js
//      for this repo's existing precedent for that kind of fixture; the
//      row shapes in test/fixtures/organizations.js are written to double
//      as seed data for that script once this is wired up. The
//      tenant-isolation regression tests further require: TEST_USER_ID
//      (the auth.users id behind TEST_USER_TOKEN), TEST_HYBRID_ORG_ID (an
//      org id distinct from TEST_TRAVEL_ORG_ID, used as the forged
//      target), and TEST_ORPHAN_USER_TOKEN (a seeded auth user with zero
//      org_members rows).
//   4. A valid platform-admin auth token (TEST_ADMIN_TOKEN) for the
//      support-session tests.
//   5. SUPABASE_SERVICE_ROLE_KEY in this process's own environment -- the
//      forged-metadata regression tests use it (via
//      buildForgingAdminClient, below) to set/clear a test user's
//      user_metadata/app_metadata directly, since that's the one
//      legitimate way to write those fields at all.
//
// Every test below is skipped by default -- `npm test` (explicitly scoped to
// the two files in this directory, see package.json) stays green today
// using only the database-free unit tests in
// test/product-capabilities.test.js.
//
// Three separate, explicit env vars must ALL be set to run these for real --
// not just RUN_INTEGRATION_TESTS=1. This is a deliberate multi-gate design,
// not redundancy: RUN_INTEGRATION_TESTS=1 alone is easy to have sitting in a
// shell profile or CI config without anyone remembering it's there. Requiring
// TEST_BASE_URL to be explicitly set (no default -- see below) prevents a
// silent fallback to whatever happens to be listening on localhost:3000,
// which in this repo's actual dev setup could be a locally-run server.js
// reading real production Supabase credentials from .env. Requiring
// TEST_CONFIRM_NON_PRODUCTION=yes on top of that forces one more deliberate,
// hard-to-set-by-accident acknowledgement before any real HTTP request goes
// out.
//
// TEST_CONFIRM_NON_PRODUCTION=yes is a human-honesty flag, not a technical
// one -- it doesn't verify anything by itself. The requireProductAccess
// tests below don't go through TEST_BASE_URL at all: they call
// src/product-capabilities.js directly, which always talks to whatever
// Supabase project this process's real environment (.env) is configured
// for, regardless of TEST_BASE_URL. Discovered this the hard way during
// Slice 1's final review -- manually exercising this guard with a fake
// TEST_BASE_URL still let those two tests issue a real (harmless,
// read-only, immediately-erroring since the migration wasn't applied yet)
// request against the actual production project, because the human-honesty
// flag was the only thing standing in the way. Fixed with an actual
// technical check below: refuse to run anything if the configured
// SUPABASE_URL matches the known production project ref, no matter what
// the other three flags say.
const KNOWN_PRODUCTION_PROJECT_REF = 'jqycdruhcaqdumuhirsw'; // "Jobu Scout Project", see admin-lib.js's header comment
const configuredSupabaseUrl = process.env.SUPABASE_URL || '';
const pointsAtProduction = configuredSupabaseUrl.includes(KNOWN_PRODUCTION_PROJECT_REF);

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const explicitBaseUrl = process.env.TEST_BASE_URL;
const confirmedNonProduction = process.env.TEST_CONFIRM_NON_PRODUCTION === 'yes';
const canRun = RUN && !!explicitBaseUrl && confirmedNonProduction && !pointsAtProduction;

const test = require('node:test');
const assert = require('node:assert/strict');

const skip = pointsAtProduction
  ? `refusing to run: SUPABASE_URL resolves to the known production project (${KNOWN_PRODUCTION_PROJECT_REF}) -- point this process's environment at a test/staging Supabase project first`
  : canRun
  ? false
  : 'requires all three of RUN_INTEGRATION_TESTS=1, an explicit TEST_BASE_URL (no default -- refuses to guess), and TEST_CONFIRM_NON_PRODUCTION=yes as a deliberate acknowledgement this will send real HTTP requests to that URL -- see file header';

// No fallback value. An unset TEST_BASE_URL must result in every test above
// being skipped (via canRun/skip) -- it must never silently resolve to a
// guessed default like localhost:3000.
const BASE_URL = explicitBaseUrl;
const TEST_USER_TOKEN = process.env.TEST_USER_TOKEN;       // JWT for a seeded travel-only org member
const TEST_HYBRID_USER_TOKEN = process.env.TEST_HYBRID_USER_TOKEN; // JWT for a seeded hybrid org member
const TEST_ADMIN_TOKEN = process.env.TEST_ADMIN_TOKEN;     // JWT for a platform admin (see src/admin-lib.js)
const TEST_TRAVEL_ORG_ID = process.env.TEST_TRAVEL_ORG_ID; // org id matching TEST_USER_TOKEN's org
const TEST_USER_ID = process.env.TEST_USER_ID;             // auth.users id matching TEST_USER_TOKEN -- needed to forge its own metadata for the tenant-isolation regression tests below
const TEST_HYBRID_ORG_ID = process.env.TEST_HYBRID_ORG_ID; // org id matching TEST_HYBRID_USER_TOKEN's org
const TEST_ORPHAN_USER_TOKEN = process.env.TEST_ORPHAN_USER_TOKEN; // JWT for a seeded auth user with ZERO org_members rows

async function apiFetch(path, { token, headers = {}, ...opts } = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

// Scoped admin client, used ONLY by the forged-metadata regression tests
// below to set/clear a test user's own user_metadata/app_metadata via the
// Supabase Admin API -- this is the one legitimate way those fields get
// written in this whole test suite, and it exists specifically to prove
// they're no longer trusted for authorization. Gated by the same
// pointsAtProduction guard as everything else in this file (constructed
// lazily, inside the one test that needs it, not at module load time, so
// requiring this file never itself talks to Supabase).
function buildForgingAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

test('GET /api/product/capabilities — 401 with no auth', { skip }, async () => {
  const res = await apiFetch('/api/product/capabilities');
  assert.equal(res.status, 401);
});

test('GET /api/product/capabilities — returns the documented v1 shape for a real org', { skip }, async () => {
  const res = await apiFetch('/api/product/capabilities', { token: TEST_USER_TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.schemaVersion, 1);
  assert.equal(typeof body.customerType, 'string');
  assert.equal(typeof body.primaryProduct, 'string');
  assert.ok(Array.isArray(body.enabledProducts));
  assert.equal(typeof body.onboardingCompleted, 'boolean');
  assert.ok(body.features);
  assert.ok(body.limits);
  assert.ok(body.billing);
  assert.equal(typeof body.overridesActive, 'boolean');
});

test('GET /api/product/capabilities — a pre-existing (pre-migration) org has onboardingCompleted=false', { skip }, async () => {
  // Direct integration-level confirmation of the "no backfill" decision --
  // complements the unit-level regression test in
  // test/product-capabilities.test.js, against a real seeded row this time.
  const res = await apiFetch('/api/product/capabilities', { token: TEST_USER_TOKEN });
  const body = await res.json();
  assert.equal(body.onboardingCompleted, false);
});

test('GET /api/product/capabilities — a valid X-Support-Session pins the response to the target org, never the admin\'s own', { skip }, async () => {
  // 0. Baseline: what does the admin see for THEIR OWN org, with no support
  //    session at all? Captured first so step 2's assertion is a concrete
  //    "not equal to this" rather than only a same-as-target check.
  const ownRes = await apiFetch('/api/product/capabilities', { token: TEST_ADMIN_TOKEN });
  assert.equal(ownRes.status, 200);
  const ownBody = await ownRes.json();

  // 1. Admin starts a support session for TEST_TRAVEL_ORG_ID (via the
  //    existing POST /api/admin/support-sessions -- unchanged by this RFC).
  const startRes = await apiFetch('/api/admin/support-sessions', {
    token: TEST_ADMIN_TOKEN,
    method: 'POST',
    body: JSON.stringify({ orgId: TEST_TRAVEL_ORG_ID, reason: 'Phase 2 Slice 1 integration test' }),
  });
  assert.equal(startRes.status, 200);
  const { sessionId, token: supportToken } = await startRes.json();

  // 2. The admin's own capabilities call, made WITH the support-session
  //    header, must reflect the TARGET org's product state -- not the
  //    admin's own, even if the admin's own org is `internal` with both
  //    products enabled. Both checks matter: equal to the target, AND
  //    (whenever the two orgs actually differ) not equal to the admin's own
  //    baseline -- proves this isn't accidentally falling through to the
  //    caller's normal org.
  const res = await apiFetch('/api/product/capabilities', {
    token: TEST_ADMIN_TOKEN,
    headers: { 'X-Support-Session': supportToken },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.enabledProducts, ['travel']); // TEST_TRAVEL_ORG_ID is travel-only
  if (ownBody.customerType !== 'travel') {
    assert.notDeepEqual(body.enabledProducts, ownBody.enabledProducts);
  }

  // 3. Clean up.
  await apiFetch(`/api/admin/support-sessions/${sessionId}/end`, { token: TEST_ADMIN_TOKEN, method: 'POST' });
});

test('GET /api/product/capabilities — expired/ended support session is rejected', { skip }, async () => {
  const res = await apiFetch('/api/product/capabilities', {
    token: TEST_ADMIN_TOKEN,
    headers: { 'X-Support-Session': 'a-token-that-does-not-exist-or-has-ended' },
  });
  assert.equal(res.status, 401);
});

// ── Tenant-isolation regression tests (getRequestOrgId fix) ────────────────
// These prove the specific vulnerability found in the Phase 2 Slice 1
// security review is actually closed: getRequestOrgId used to trust
// user.app_metadata.org_id / user.user_metadata.org_id ahead of any
// database lookup, and user_metadata is end-user-editable via Supabase
// Auth's standard client -- any signed-up user could set their own
// user_metadata.org_id to another org's id and be treated as a member of
// it. Fixed in server.js's getRequestOrgId: org_id now comes ONLY from a
// validated support session (already covered above) or an org_members
// row keyed on the caller's own verified user id.

test('GET /api/product/capabilities — a forged user_metadata.org_id cannot select another tenant', { skip }, async () => {
  const admin = buildForgingAdminClient();

  // TEST_USER_TOKEN's real org is TEST_TRAVEL_ORG_ID (per its org_members
  // row) -- forge user_metadata to claim TEST_HYBRID_ORG_ID instead, the
  // exact shape the vulnerable code used to trust.
  const { error: forgeError } = await admin.auth.admin.updateUserById(TEST_USER_ID, {
    user_metadata: { org_id: TEST_HYBRID_ORG_ID },
  });
  assert.equal(forgeError, null);

  try {
    const res = await apiFetch('/api/product/capabilities', { token: TEST_USER_TOKEN });
    assert.equal(res.status, 200); // the forged field is simply ignored, not an error
    const body = await res.json();
    // Must still resolve to the REAL (org_members-backed) org, never the
    // forged one -- the hybrid org has both products enabled, so this
    // would silently pass (wrongly) if the forgery worked.
    assert.deepEqual(body.enabledProducts, ['travel']);
  } finally {
    // Always restore, even if an assertion above threw.
    await admin.auth.admin.updateUserById(TEST_USER_ID, { user_metadata: {} });
  }
});

test('GET /api/product/capabilities — a forged app_metadata.org_id is not blindly trusted either', { skip }, async () => {
  const admin = buildForgingAdminClient();

  const { error: forgeError } = await admin.auth.admin.updateUserById(TEST_USER_ID, {
    app_metadata: { org_id: TEST_HYBRID_ORG_ID },
  });
  assert.equal(forgeError, null);

  try {
    const res = await apiFetch('/api/product/capabilities', { token: TEST_USER_TOKEN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.enabledProducts, ['travel']);
  } finally {
    await admin.auth.admin.updateUserById(TEST_USER_ID, { app_metadata: {} });
  }
});

test('GET /api/product/capabilities — access is granted only via an authoritative org_members row', { skip }, async () => {
  const res = await apiFetch('/api/product/capabilities', { token: TEST_USER_TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  // TEST_USER_TOKEN's membership is what determines this, not anything
  // client-supplied -- cross-checked against the known-good travel org.
  assert.deepEqual(body.enabledProducts, ['travel']);
});

test('GET /api/product/capabilities — a user with zero org_members rows gets 403, not a guessed org', { skip }, async () => {
  const res = await apiFetch('/api/product/capabilities', { token: TEST_ORPHAN_USER_TOKEN });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(body.error);
  // The error must not leak internal table/column names.
  assert.doesNotMatch(body.error, /org_members|profiles|select|postgres/i);
});

test('existing organization-scoped routes are not left vulnerable to a forged user_metadata.org_id', { skip }, async () => {
  // Spot-checks the same fix across two pre-existing routes that also call
  // getRequestOrgId, rather than re-testing every route that does --
  // GET /api/teams and GET /api/billing/status cover the "direct in the
  // route handler" and "via a shared helper" call shapes respectively.
  const admin = buildForgingAdminClient();
  const { error: forgeError } = await admin.auth.admin.updateUserById(TEST_USER_ID, {
    user_metadata: { org_id: TEST_HYBRID_ORG_ID },
  });
  assert.equal(forgeError, null);

  try {
    const teamsRes = await apiFetch('/api/teams', { token: TEST_USER_TOKEN });
    assert.equal(teamsRes.status, 200);
    const teams = await teamsRes.json();
    assert.ok(Array.isArray(teams));
    assert.ok(teams.every((t) => t.org_id !== TEST_HYBRID_ORG_ID));

    const billingRes = await apiFetch('/api/billing/status', { token: TEST_USER_TOKEN });
    assert.equal(billingRes.status, 200);
    // No direct org-id field on this payload to compare, but a 200 at all
    // (rather than a 403/404 from a lookup against a hybrid-only billing
    // shape) is itself consistent with the real (travel) org resolving.
  } finally {
    await admin.auth.admin.updateUserById(TEST_USER_ID, { user_metadata: {} });
  }
});

// ── requireProductAccess, exercised against a throwaway route ──────────────
// requireProductAccess is not mounted on any production route in Phase 2
// Slice 1 -- this test mounts it on a route defined only inside this test
// file, to prove the middleware's own contract without waiting for Phase
// 3/4 to give it a real route to protect.

test('requireProductAccess(\'high_school\') denies a travel-only org and allows a hybrid org', { skip }, async () => {
  const { requireProductAccess } = require('../src/product-capabilities');
  const express = require('express');
  const app = express();

  // Minimal stand-in for the upstream middleware chain this middleware
  // expects (requireAuth + getRequestOrgId/resolveSupportSession having
  // already set req._orgId) -- not a re-implementation of that logic, just
  // enough to drive req._orgId for this isolated test.
  app.use((req, res, next) => {
    req._orgId = req.headers['x-test-org-id'];
    next();
  });
  app.get('/test/high-school-only', requireProductAccess('high_school'), (req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const travelOnlyRes = await fetch(`http://localhost:${port}/test/high-school-only`, {
      headers: { 'x-test-org-id': TEST_TRAVEL_ORG_ID },
    });
    assert.equal(travelOnlyRes.status, 403);

    const hybridOrgId = process.env.TEST_HYBRID_ORG_ID;
    const hybridRes = await fetch(`http://localhost:${port}/test/high-school-only`, {
      headers: { 'x-test-org-id': hybridOrgId },
    });
    assert.equal(hybridRes.status, 200);
  } finally {
    server.close();
  }
});

test('requireProductAccess — fails closed with no req._orgId set at all', { skip }, async () => {
  const { requireProductAccess } = require('../src/product-capabilities');
  const express = require('express');
  const app = express();
  app.get('/test/unauthenticated', requireProductAccess('travel'), (req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://localhost:${port}/test/unauthenticated`);
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
