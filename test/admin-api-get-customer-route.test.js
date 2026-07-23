'use strict';

// Focused tests for GET /api/admin/customers/:orgId, specifically the Phase
// 2 Slice 3B addition (the `organizations` product-fields lookup merged
// into `organization`). Sends real HTTP requests through the REAL router
// built by src/admin-api.js's createAdminRouter (not a re-implementation),
// exactly like test/admin-api-product-route-wiring.test.js does for the
// PATCH route -- only the Supabase client is faked, by injecting a stand-in
// module into require.cache for src/supabase.js BEFORE src/admin-api.js and
// src/admin-lib.js are (re-)required, since both capture
// `const { adminClient } = require('./supabase')` once at module load and
// share the same singleton. This never touches a real database or network.
//
// Run with: node --test test/admin-api-get-customer-route.test.js (also
// included in `npm test`, see package.json).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_USER = { id: 'admin-user-1' };

// Builds a fake chainable Supabase query builder. Records every call so
// tests can assert exactly what was queried (table, select columns, eq
// filters, terminal method) without any real database.
function makeFakeSupabase(tableHandlers, calls) {
  function makeBuilder(table) {
    const state = { table, select: null, eqs: [] };
    const resolveResult = () => {
      const handler = tableHandlers[table];
      const result = handler ? handler(state) : { data: null, error: null };
      calls.push({ ...state, eqs: [...state.eqs] });
      return result;
    };
    const builder = {
      select(cols) { state.select = cols; return builder; },
      eq(col, val) { state.eqs.push([col, val]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      range() { return builder; },
      maybeSingle() {
        state.terminal = 'maybeSingle';
        return Promise.resolve(resolveResult());
      },
      single() {
        state.terminal = 'single';
        return Promise.resolve(resolveResult());
      },
      then(resolve, reject) {
        state.terminal = state.terminal || 'then';
        return Promise.resolve(resolveResult()).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from(table) { return makeBuilder(table); },
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  };
}

// Re-requires src/admin-api.js and src/admin-lib.js fresh against a newly
// installed fake adminClient, so each test gets isolated mock data/call
// tracking despite Node's module cache.
function freshAdminRouter(tableHandlers) {
  const calls = [];
  const fakeClient = makeFakeSupabase(tableHandlers, calls);
  const supabasePath = require.resolve('../src/supabase');
  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true, exports: { adminClient: fakeClient, userClient: () => fakeClient },
  };
  delete require.cache[require.resolve('../src/admin-api')];
  delete require.cache[require.resolve('../src/admin-lib')];
  const createAdminRouter = require('../src/admin-api');
  return { createAdminRouter, calls };
}

function defaultTableHandlers(overrides) {
  return {
    platform_admins: () => ({ data: { role: 'owner', is_active: true }, error: null }),
    admin_customer_overview: () => ({ data: { id: ORG_ID, name: 'Test Org' }, error: null }),
    organizations: () => ({ data: { customer_type: 'hybrid', primary_product: 'travel', enabled_products: ['travel', 'high_school'] }, error: null }),
    org_members: () => ({ data: [], error: null }),
    teams: () => ({ data: [], error: null }),
    reports: () => ({ data: [], error: null }),
    scrape_jobs: () => ({ data: [], error: null }),
    org_entitlement_overrides: () => ({ data: [], error: null }),
    org_support_notes: () => ({ data: [], error: null }),
    admin_audit_log: () => ({ data: [], error: null }),
    ...overrides,
  };
}

async function getCustomer(tableHandlers, orgId) {
  const { createAdminRouter, calls } = freshAdminRouter(tableHandlers);
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ requireAuth: (req, res, next) => { req.user = ADMIN_USER; next(); } }));
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/api/admin/customers/${orgId}`);
    const body = await res.json();
    return { status: res.status, body, calls };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /customers/:orgId — the product-fields lookup is scoped to the requested orgId only', async () => {
  const { calls } = await getCustomer(defaultTableHandlers(), ORG_ID);
  const orgFieldsCall = calls.find(c => c.table === 'organizations');
  assert.ok(orgFieldsCall, 'expected a query against the organizations table');
  assert.deepEqual(orgFieldsCall.eqs, [['id', ORG_ID]]);
});

test('GET /customers/:orgId — the product-fields lookup selects exactly customer_type, primary_product, enabled_products (no other columns)', async () => {
  const { calls } = await getCustomer(defaultTableHandlers(), ORG_ID);
  const orgFieldsCall = calls.find(c => c.table === 'organizations');
  assert.equal(orgFieldsCall.select, 'customer_type, primary_product, enabled_products');
});

test('GET /customers/:orgId — the product-fields lookup expects exactly one authoritative row (maybeSingle, not a list)', async () => {
  const { calls } = await getCustomer(defaultTableHandlers(), ORG_ID);
  const orgFieldsCall = calls.find(c => c.table === 'organizations');
  assert.equal(orgFieldsCall.terminal, 'maybeSingle');
});

test('GET /customers/:orgId — different requests never leak another organization\'s id into the product-fields query', async () => {
  const { calls: callsA } = await getCustomer(defaultTableHandlers(), ORG_ID);
  const { calls: callsB } = await getCustomer(defaultTableHandlers(), OTHER_ORG_ID);
  const fieldsCallA = callsA.find(c => c.table === 'organizations');
  const fieldsCallB = callsB.find(c => c.table === 'organizations');
  assert.deepEqual(fieldsCallA.eqs, [['id', ORG_ID]]);
  assert.deepEqual(fieldsCallB.eqs, [['id', OTHER_ORG_ID]]);
  // every eq() call across the whole request, on every table, used only the
  // orgId that was actually requested -- never the other one
  for (const call of callsA) {
    for (const [, val] of call.eqs) assert.notEqual(val, OTHER_ORG_ID);
  }
});

test('GET /customers/:orgId — missing organization returns 404 with no partial product data', async () => {
  const { status, body } = await getCustomer(
    defaultTableHandlers({ admin_customer_overview: () => ({ data: null, error: null }) }),
    ORG_ID,
  );
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'Customer not found' });
  assert.equal('organization' in body, false);
});

// ── Corrective pass (item 1): a failed/missing authoritative product-fields
// lookup must never produce a response that looks authoritative while
// actually being partial. Verified below: neither failure mode returns an
// `organization` key at all -- the whole request fails the same way
// orgRes's own error/404 paths already do (same res.status().json({error})
// shape), with a sanitized, generic message, never productFieldsRes.error.message.

test('GET /customers/:orgId — organizations lookup error (db error) returns a sanitized failure, not a 200', async () => {
  const { status, body } = await getCustomer(
    defaultTableHandlers({
      organizations: () => ({ data: null, error: { message: 'relation "organizations" permission denied for role service_role (SQLSTATE 42501)' } }),
    }),
    ORG_ID,
  );
  assert.equal(status, 500);
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});

test('GET /customers/:orgId — organizations lookup error returns no organization object (never a partial/authoritative-looking product state)', async () => {
  const { body } = await getCustomer(
    defaultTableHandlers({
      organizations: () => ({ data: null, error: { message: 'relation "organizations" permission denied for role service_role (SQLSTATE 42501)' } }),
    }),
    ORG_ID,
  );
  assert.equal('organization' in body, false);
});

test('GET /customers/:orgId — missing authoritative row (no error, but no data) returns a sanitized failure, not a 200', async () => {
  const { status, body } = await getCustomer(
    defaultTableHandlers({
      organizations: () => ({ data: null, error: null }),
    }),
    ORG_ID,
  );
  assert.equal(status, 500);
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});

test('GET /customers/:orgId — missing authoritative row returns no organization object', async () => {
  const { body } = await getCustomer(
    defaultTableHandlers({
      organizations: () => ({ data: null, error: null }),
    }),
    ORG_ID,
  );
  assert.equal('organization' in body, false);
});

test('GET /customers/:orgId — database error details (message, SQLSTATE, table/query text) never reach the client for either failure mode', async () => {
  const hostileMessage = 'relation "organizations" permission denied for role service_role (SQLSTATE 42501) — query: select customer_type from organizations where id = $1';
  const { body: errorBody } = await getCustomer(
    defaultTableHandlers({ organizations: () => ({ data: null, error: { message: hostileMessage } }) }),
    ORG_ID,
  );
  const errorBodyJson = JSON.stringify(errorBody);
  assert.equal(errorBodyJson.includes('SQLSTATE'), false);
  assert.equal(errorBodyJson.includes('permission denied'), false);
  assert.equal(errorBodyJson.includes('select customer_type'), false);
  assert.equal(errorBodyJson.includes(hostileMessage), false);

  const { body: missingRowBody } = await getCustomer(
    defaultTableHandlers({ organizations: () => ({ data: null, error: null }) }),
    ORG_ID,
  );
  assert.equal(JSON.stringify(missingRowBody).includes('SQLSTATE'), false);
});

test('GET /customers/:orgId — an absent admin_customer_overview row still returns the existing 404 behavior (unaffected by the product-fields change)', async () => {
  const { status, body } = await getCustomer(
    defaultTableHandlers({ admin_customer_overview: () => ({ data: null, error: null }) }),
    ORG_ID,
  );
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'Customer not found' });
});

// ── Final corrective pass (item 2): admin_customer_overview's own error
// path previously forwarded orgRes.error.message verbatim -- a raw
// Supabase/Postgres message could reach the client. Sanitized the same way
// the product-fields failure already is: generic message, no
// `organization` key, real detail logged server-side only. The 404 path
// (row genuinely absent, no error) is unchanged and re-verified below.

test('GET /customers/:orgId — admin_customer_overview query failure returns a sanitized 500, not the raw database message', async () => {
  const { status, body } = await getCustomer(
    defaultTableHandlers({
      admin_customer_overview: () => ({ data: null, error: { message: 'connection terminated unexpectedly' } }),
    }),
    ORG_ID,
  );
  assert.equal(status, 500);
  assert.equal(typeof body.error, 'string');
  assert.notEqual(body.error, 'connection terminated unexpectedly');
});

test('GET /customers/:orgId — admin_customer_overview query failure: raw database details (message, SQLSTATE, relation name, query text) are absent from the response', async () => {
  const hostileMessage = 'relation "admin_customer_overview" does not exist (SQLSTATE 42P01) — query: select * from admin_customer_overview where id = $1';
  const { body } = await getCustomer(
    defaultTableHandlers({
      admin_customer_overview: () => ({ data: null, error: { message: hostileMessage } }),
    }),
    ORG_ID,
  );
  const bodyJson = JSON.stringify(body);
  assert.equal(bodyJson.includes(hostileMessage), false);
  assert.equal(bodyJson.includes('SQLSTATE'), false);
  assert.equal(bodyJson.includes('does not exist'), false);
  assert.equal(bodyJson.includes('admin_customer_overview'), false);
});

test('GET /customers/:orgId — admin_customer_overview query failure returns no organization object', async () => {
  const { body } = await getCustomer(
    defaultTableHandlers({
      admin_customer_overview: () => ({ data: null, error: { message: 'connection terminated unexpectedly' } }),
    }),
    ORG_ID,
  );
  assert.equal('organization' in body, false);
});

test('GET /customers/:orgId — a valid overview row and a valid authoritative product lookup still return the complete response (organization, members, teams, reports, etc.)', async () => {
  const { status, body } = await getCustomer(defaultTableHandlers(), ORG_ID);
  assert.equal(status, 200);
  assert.equal(body.organization.customerType, 'hybrid');
  assert.equal(body.organization.primaryProduct, 'travel');
  assert.deepEqual(body.organization.enabledProducts, ['travel', 'high_school']);
  assert.deepEqual(Object.keys(body).sort(), ['auditLog', 'members', 'notes', 'organization', 'overrides', 'reports', 'scrapeJobs', 'teams']);
});

test('GET /customers/:orgId — authoritative organizations values win even if admin_customer_overview already has same-named fields', async () => {
  const { body } = await getCustomer(
    defaultTableHandlers({
      admin_customer_overview: () => ({
        data: { id: ORG_ID, name: 'Test Org', customerType: 'STALE-FROM-VIEW', primaryProduct: 'STALE', enabledProducts: ['STALE'] },
        error: null,
      }),
      organizations: () => ({ data: { customer_type: 'hybrid', primary_product: 'travel', enabled_products: ['travel', 'high_school'] }, error: null }),
    }),
    ORG_ID,
  );
  assert.equal(body.organization.customerType, 'hybrid');
  assert.equal(body.organization.primaryProduct, 'travel');
  assert.deepEqual(body.organization.enabledProducts, ['travel', 'high_school']);
});

test('GET /customers/:orgId — null enabled_products is passed through unchanged (no invented normalization beyond the existing schema contract)', async () => {
  const { body } = await getCustomer(
    defaultTableHandlers({
      organizations: () => ({ data: { customer_type: 'travel', primary_product: 'travel', enabled_products: null }, error: null }),
    }),
    ORG_ID,
  );
  assert.equal(body.organization.enabledProducts, null);
});

test('GET /customers/:orgId — every per-org table query (members, teams, reports, etc.) is scoped to org_id = the requested orgId', async () => {
  const { calls } = await getCustomer(defaultTableHandlers(), ORG_ID);
  const scopedTables = ['org_members', 'teams', 'reports', 'scrape_jobs', 'org_entitlement_overrides', 'org_support_notes', 'admin_audit_log'];
  for (const table of scopedTables) {
    const call = calls.find(c => c.table === table);
    assert.ok(call, `expected a query against ${table}`);
    assert.deepEqual(call.eqs, [['org_id', ORG_ID]]);
  }
});
