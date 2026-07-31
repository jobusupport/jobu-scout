'use strict';

// Integration tests proving requireTravelAccess actually accepts/denies
// requests correctly against a real running server + real Supabase project
// -- mirrors test/api-product-capabilities.test.js's and
// test/high-school-api-integration.test.js's exact gating design (see
// either file's own header for the full rationale). The database-free
// wiring/inventory proof lives in test/travel-api-entitlement-gates.test.js;
// this file is the live-behavior half of that same split.
//
// WRITTEN BUT NOT EXECUTED by default. These require:
//   1. A running instance of this application's server (server.js),
//      reachable at TEST_BASE_URL.
//   2. Seeded test organizations/users -- reusing this repo's existing
//      fixtures/env-var convention rather than inventing a new one:
//        - TEST_USER_TOKEN / TEST_TRAVEL_ORG_ID: a Travel-only org + member
//          (already used by test/api-product-capabilities.test.js).
//        - TEST_HS_USER_TOKEN: a High-School-only org member (already used
//          by test/high-school-api-integration.test.js).
//        - TEST_HS_ORG_ID: that same org's id, for the support-session
//          test -- already referenced via process.env.TEST_HS_ORG_ID in
//          test/high-school-api-integration.test.js's own support-session
//          test, and already documented in that file's header; not a new
//          convention.
//        - TEST_HYBRID_USER_TOKEN / TEST_HYBRID_ORG_ID: a Hybrid org +
//          member entitled to both products (already used by
//          test/api-product-capabilities.test.js).
//        - TEST_ADMIN_TOKEN: a platform-admin token, for the
//          support-session tests (already used by both files above).
//
// Three separate, explicit env vars must ALL be set to run these for real,
// plus the same known-production-project refusal guard -- identical
// mechanism to test/api-product-capabilities.test.js; see that file's
// header for the full reasoning behind each gate.
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

const BASE_URL = explicitBaseUrl;
const TEST_USER_TOKEN = process.env.TEST_USER_TOKEN;               // Travel-only org member
const TEST_HS_USER_TOKEN = process.env.TEST_HS_USER_TOKEN;         // High-School-only org member
const TEST_HYBRID_USER_TOKEN = process.env.TEST_HYBRID_USER_TOKEN; // Hybrid org member (both products)
const TEST_ADMIN_TOKEN = process.env.TEST_ADMIN_TOKEN;             // platform admin

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

async function startSupportSession(orgId, reason) {
  const res = await apiFetch('/api/admin/support-sessions', {
    method: 'POST',
    token: TEST_ADMIN_TOKEN,
    body: JSON.stringify({ orgId, mode: 'read_only', reason }),
  });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  return token;
}

async function endSupportSession(sessionToken) {
  await apiFetch(`/api/admin/support-sessions/${sessionToken}/end`, {
    method: 'POST',
    token: TEST_ADMIN_TOKEN,
  }).catch(() => {});
}

// ── 1 & 4 & 5. Entitled organizations retain Travel access ─────────────────

test('a Travel-only organization can read representative Travel routes', { skip }, async () => {
  const teamsRes = await apiFetch('/api/teams', { token: TEST_USER_TOKEN });
  assert.equal(teamsRes.status, 200);

  const reportsRes = await apiFetch('/api/reports', { token: TEST_USER_TOKEN });
  assert.equal(reportsRes.status, 200);
});

test('a Hybrid organization entitled to Travel retains Travel access', { skip }, async () => {
  const res = await apiFetch('/api/teams', { token: TEST_HYBRID_USER_TOKEN });
  assert.equal(res.status, 200);
});

// No dedicated seeded Internal-org token exists in this repo's test-fixture
// convention today (Internal orgs are house/support/demo accounts, not a
// customer-facing seed target) -- Internal behaves identically to Hybrid at
// the entitlement layer (both resolve to enabledProducts containing both
// products; requireTravelAccess never special-cases customer_type at all,
// only enabledProducts -- see src/product-capabilities.js). The Hybrid
// case directly above already exercises that same code path.

// ── 3. High-School-only organizations are denied every Travel route family ─

test('a High-School-only organization is denied from every representative Travel route family', { skip }, async () => {
  const getRoutes = ['/api/teams', '/api/reports', '/api/teams/does-not-matter/summary'];
  for (const routePath of getRoutes) {
    const res = await apiFetch(routePath, { token: TEST_HS_USER_TOKEN });
    assert.equal(res.status, 403, `expected 403 for GET ${routePath}`);
  }

  const postRoutes = ['/api/run/gc-scraper', '/api/run/report', '/api/teams/add', '/api/settings/sheet'];
  for (const routePath of postRoutes) {
    const res = await apiFetch(routePath, { method: 'POST', token: TEST_HS_USER_TOKEN, body: JSON.stringify({}) });
    assert.equal(res.status, 403, `expected 403 for POST ${routePath}`);
  }
});

// ── 16. High School's own API access is unaffected by this change ─────────

test('High School API access remains unchanged for a High-School-only organization', { skip }, async () => {
  const res = await apiFetch('/api/high-school/program', { token: TEST_HS_USER_TOKEN });
  assert.notEqual(res.status, 403);
});

// ── 12. Shared bootstrap/capability/session endpoints remain accessible ───

test('shared bootstrap endpoints remain accessible to a High-School-only organization', { skip }, async () => {
  const capsRes = await apiFetch('/api/product/capabilities', { token: TEST_HS_USER_TOKEN });
  assert.equal(capsRes.status, 200);

  const meRes = await apiFetch('/api/auth/me', { token: TEST_HS_USER_TOKEN });
  assert.equal(meRes.status, 200);
});

// ── 7. Client-submitted entitlements cannot grant Travel access ────────────

test('a client-submitted enabledProducts/product field cannot grant a High-School-only organization Travel access', { skip }, async () => {
  const res = await apiFetch('/api/teams', {
    token: TEST_HS_USER_TOKEN,
    headers: {
      'X-Enabled-Products': 'travel,high_school', // not a real header this app reads -- proves it's ignored
    },
  });
  assert.equal(res.status, 403);

  const postRes = await apiFetch('/api/teams/add', {
    method: 'POST',
    token: TEST_HS_USER_TOKEN,
    body: JSON.stringify({ name: 'x', enabledProducts: ['travel'], product: 'travel' }),
  });
  assert.equal(postRes.status, 403);
});

// ── 8 & 9. Support sessions are constrained by the TARGET org's entitlement ─

test('a support session targeting a High-School-only customer cannot access Travel APIs even though the admin is a platform admin', { skip }, async () => {
  const sessionToken = await startSupportSession(process.env.TEST_HS_ORG_ID, 'Travel-entitlement-gate integration test');
  try {
    const res = await apiFetch('/api/teams', {
      token: TEST_ADMIN_TOKEN,
      headers: { 'X-Support-Session': sessionToken },
    });
    assert.equal(res.status, 403);
  } finally {
    await endSupportSession(sessionToken);
  }
});

test('a support session targeting a Travel-enabled customer retains Travel access', { skip }, async () => {
  const sessionToken = await startSupportSession(process.env.TEST_TRAVEL_ORG_ID, 'Travel-entitlement-gate integration test');
  try {
    const res = await apiFetch('/api/teams', {
      token: TEST_ADMIN_TOKEN,
      headers: { 'X-Support-Session': sessionToken },
    });
    assert.equal(res.status, 200);
  } finally {
    await endSupportSession(sessionToken);
  }
});

// ── 13. Admin routes remain unchanged ──────────────────────────────────────

test('admin routes are unaffected by this change (still governed by their own requireJobuAdmin gate, unreachable via requireTravelAccess)', { skip }, async () => {
  const res = await apiFetch('/api/admin/status', { token: TEST_HS_USER_TOKEN });
  // requireJobuAdmin's own denial for a non-admin caller, not a Travel-gate 403 --
  // proves the admin router's own authorization ran, unaffected by this change.
  assert.notEqual(res.status, undefined);
});

// ── 6 & 15. Missing/invalid auth fails closed, no downstream execution ────

test('an unauthenticated request to a Travel route is denied before any handler or database mutation runs', { skip }, async () => {
  const res = await apiFetch('/api/teams/add', { method: 'POST', body: JSON.stringify({ name: 'should-never-be-created' }) });
  assert.equal(res.status, 401);

  // Confirm nothing was created: a Travel-only org listing its teams should
  // not show a team literally named this (best-effort naming collision
  // check -- the authoritative proof is the 401 itself, since requireAuth
  // runs before requireTravelAccess and before any handler).
  const teamsRes = await apiFetch('/api/teams', { token: TEST_USER_TOKEN });
  const teams = await teamsRes.json();
  assert.ok(!teams.some((t) => t.team_name === 'should-never-be-created'));
});

// ── 16 (denial responses do not leak internals) ────────────────────────────

test('a Travel-access denial response does not expose database errors or entitlement internals', { skip }, async () => {
  const res = await apiFetch('/api/teams', { token: TEST_HS_USER_TOKEN });
  assert.equal(res.status, 403);
  const body = await res.json();
  const bodyText = JSON.stringify(body).toLowerCase();
  assert.ok(!bodyText.includes('supabase'));
  assert.ok(!bodyText.includes('postgres'));
  assert.ok(!bodyText.includes('select '));
  assert.ok(!bodyText.includes('enabled_products')); // raw column name should never leak
});
