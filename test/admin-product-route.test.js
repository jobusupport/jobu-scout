'use strict';

// Database-free regression tests for src/admin-product-route.js -- the
// PATCH /api/admin/customers/:orgId/product route from Phase 2 Slice 2
// (docs/architecture/PHASE_2_PRODUCT_CAPABILITY_RFC.md §14). These execute
// the ACTUAL route logic (validateProductChangeRequest, handleProductChange),
// not a re-implementation of it -- the only things mocked are the two
// injected I/O points, fetchOrg and callRpc, mirroring the pattern
// test/org-resolution.test.js established for resolveTrustedOrgId.
//
// What these tests do NOT and cannot prove: that Postgres actually rolls
// back the organizations UPDATE when the admin_audit_log INSERT fails
// inside admin_update_org_product() (or vice versa), or that the SQL
// function's own independent validation (reason/actor-identity, both
// re-checked inside Postgres per that function's header comment) actually
// fires the way the SQL reads. Both guarantees live entirely inside the
// Postgres function body
// (supabase/migrations/20260722010000_admin_update_org_product_fn.sql) and
// require a live database to exercise for real -- there is no pg driver or
// local Postgres in this test suite. What IS proven here, database-free,
// is the application-layer half of both guarantees: exactly one write call
// (callRpc) is ever made for a product change, there is no code path that
// issues a separate organizations update and a separate audit-log insert,
// any failure from that one call always surfaces as a thrown, typed error
// (never a 200 describing a change that didn't fully happen), and
// handleProductChange's OWN copy of the actor-identity/orgId checks --
// which exist specifically to fail fast, before the RPC round trip, and to
// be testable at all -- behave exactly as specified.
//
// Run with: node --test test/admin-product-route.test.js (also included
// in `npm test`, see package.json).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateProductChangeRequest,
  handleProductChange,
  ENABLED_PRODUCTS_BY_CUSTOMER_TYPE,
} = require('../src/admin-product-route');

// ── Test helpers ────────────────────────────────────────────────────────────

const VALID_ORG_ID = '11111111-1111-4111-8111-111111111111';

function fetchOrgThatMustNotBeCalled() {
  return async () => {
    throw new Error('fetchOrg should not have been called');
  };
}

function callRpcThatMustNotBeCalled() {
  return async () => {
    throw new Error('callRpc should not have been called');
  };
}

function fetchOrgFound(id = VALID_ORG_ID) {
  return async () => ({ data: { id }, error: null });
}

function fetchOrgNotFound() {
  return async () => ({ data: null, error: null });
}

function fetchOrgErrors(message = 'connection reset') {
  return async () => ({ data: null, error: new Error(message) });
}

// Records every call it receives and returns a successful RPC response
// shaped like the real admin_update_org_product() return value. The real
// function derives enabledProducts server-side from p_customer_type alone
// (it doesn't even accept an enabled_products parameter -- see that
// function's header comment) -- this fake reproduces that derivation
// independently, via ENABLED_PRODUCTS_BY_CUSTOMER_TYPE, specifically so a
// test asserting on the RPC call's args would catch it if
// handleProductChange ever regressed to sending a p_enabled_products
// argument the real function doesn't accept.
function callRpcSpy() {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return {
      data: {
        customerType: args.p_customer_type,
        primaryProduct: args.p_primary_product,
        enabledProducts: ENABLED_PRODUCTS_BY_CUSTOMER_TYPE[args.p_customer_type],
      },
      error: null,
    };
  };
  fn.calls = calls;
  return fn;
}

function callRpcNotFound() {
  return async () => ({ data: null, error: { code: 'P0002', message: 'organization_not_found' } });
}

function callRpcErrors() {
  return async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
}

const baseArgs = (overrides = {}) => ({
  orgId: VALID_ORG_ID,
  body: { customerType: 'travel', reason: 'switching to travel-only' },
  hasSupportSession: false,
  adminUser: { id: 'admin-1', email: 'admin@jobuscout.com' },
  adminRole: 'owner',
  req: { ip: '1.2.3.4', headers: { 'user-agent': 'test-agent' } },
  fetchOrg: fetchOrgFound(),
  callRpc: callRpcSpy(),
  ...overrides,
});

// ── validateProductChangeRequest: the full customerType/primaryProduct matrix ─

const VALID_COMBINATIONS = [
  { customerType: 'travel', primaryProduct: undefined, expectedPrimary: 'travel', expectedEnabled: ['travel'] },
  { customerType: 'travel', primaryProduct: 'travel', expectedPrimary: 'travel', expectedEnabled: ['travel'] },
  { customerType: 'high_school', primaryProduct: undefined, expectedPrimary: 'high_school', expectedEnabled: ['high_school'] },
  { customerType: 'high_school', primaryProduct: 'high_school', expectedPrimary: 'high_school', expectedEnabled: ['high_school'] },
  { customerType: 'hybrid', primaryProduct: 'travel', expectedPrimary: 'travel', expectedEnabled: ['travel', 'high_school'] },
  { customerType: 'hybrid', primaryProduct: 'high_school', expectedPrimary: 'high_school', expectedEnabled: ['travel', 'high_school'] },
  { customerType: 'internal', primaryProduct: 'travel', expectedPrimary: 'travel', expectedEnabled: ['travel', 'high_school'] },
  { customerType: 'internal', primaryProduct: 'high_school', expectedPrimary: 'high_school', expectedEnabled: ['travel', 'high_school'] },
];

for (const { customerType, primaryProduct, expectedPrimary, expectedEnabled } of VALID_COMBINATIONS) {
  test(`validateProductChangeRequest — valid combination: customerType=${customerType}, primaryProduct=${primaryProduct}`, () => {
    const body = { customerType, reason: 'r' };
    if (primaryProduct !== undefined) body.primaryProduct = primaryProduct;
    const result = validateProductChangeRequest(body);
    assert.equal(result.primaryProduct, expectedPrimary);
    assert.deepEqual(result.enabledProducts, expectedEnabled);
  });
}

// Every invalid customerType/primaryProduct combination required by the
// review: travel/high_school with a disagreeing (or bogus) primaryProduct,
// hybrid/internal with a missing or bogus primaryProduct.
const INVALID_COMBINATIONS = [
  { customerType: 'travel', primaryProduct: 'high_school', reason: 'a disagreeing primaryProduct for travel' },
  { customerType: 'travel', primaryProduct: 'bogus', reason: 'a bogus primaryProduct for travel' },
  { customerType: 'high_school', primaryProduct: 'travel', reason: 'a disagreeing primaryProduct for high_school' },
  { customerType: 'high_school', primaryProduct: 'bogus', reason: 'a bogus primaryProduct for high_school' },
  { customerType: 'hybrid', primaryProduct: undefined, reason: 'a missing primaryProduct for hybrid' },
  { customerType: 'hybrid', primaryProduct: 'bogus', reason: 'a bogus primaryProduct for hybrid' },
  { customerType: 'internal', primaryProduct: undefined, reason: 'a missing primaryProduct for internal' },
  { customerType: 'internal', primaryProduct: 'bogus', reason: 'a bogus primaryProduct for internal' },
];

for (const { customerType, primaryProduct, reason } of INVALID_COMBINATIONS) {
  test(`validateProductChangeRequest — invalid combination is rejected: ${reason}`, () => {
    const body = { customerType, reason: 'r' };
    if (primaryProduct !== undefined) body.primaryProduct = primaryProduct;
    assert.throws(() => validateProductChangeRequest(body), (err) => err.statusCode === 400);
  });
}

test('validateProductChangeRequest — unknown customerType is rejected', () => {
  assert.throws(
    () => validateProductChangeRequest({ customerType: 'bogus', reason: 'r' }),
    (err) => err.statusCode === 400
  );
});

test('validateProductChangeRequest — missing reason is rejected', () => {
  assert.throws(
    () => validateProductChangeRequest({ customerType: 'travel' }),
    (err) => err.statusCode === 400 && /reason/i.test(err.message)
  );
});

test('validateProductChangeRequest — a reason containing only whitespace is rejected', () => {
  assert.throws(
    () => validateProductChangeRequest({ customerType: 'travel', reason: '   \t\n  ' }),
    (err) => err.statusCode === 400 && /reason/i.test(err.message)
  );
});

test('validateProductChangeRequest — reason is trimmed before being accepted', () => {
  const result = validateProductChangeRequest({ customerType: 'travel', reason: '  needs trimming  ' });
  assert.equal(result.reason, 'needs trimming');
});

test('validateProductChangeRequest — a client-supplied enabledProducts is rejected, even if it matches the derived value', () => {
  assert.throws(
    () => validateProductChangeRequest({ customerType: 'travel', reason: 'r', enabledProducts: ['travel'] }),
    (err) => err.statusCode === 400 && /enabledProducts/.test(err.message)
  );
});

test('validateProductChangeRequest — any unknown request property is rejected', () => {
  assert.throws(
    () => validateProductChangeRequest({ customerType: 'travel', reason: 'r', isAdmin: true }),
    (err) => err.statusCode === 400 && /isAdmin/.test(err.message)
  );
});

test('ENABLED_PRODUCTS_BY_CUSTOMER_TYPE matches the RFC §14 derivation table exactly', () => {
  assert.deepEqual(ENABLED_PRODUCTS_BY_CUSTOMER_TYPE, {
    travel: ['travel'],
    high_school: ['high_school'],
    hybrid: ['travel', 'high_school'],
    internal: ['travel', 'high_school'],
  });
});

// ── handleProductChange: malformed orgId ────────────────────────────────────

const MALFORMED_ORG_IDS = [
  'not-a-uuid',
  '12345',
  '',
  '11111111-1111-1111-1111-11111111111', // one hex digit short
  '11111111_1111_4111_8111_111111111111', // wrong separators
  'DROP TABLE organizations;--',
];

for (const badOrgId of MALFORMED_ORG_IDS) {
  test(`handleProductChange — malformed orgId (${JSON.stringify(badOrgId)}) is rejected with 400 before any I/O`, async () => {
    await assert.rejects(
      handleProductChange(baseArgs({
        orgId: badOrgId,
        fetchOrg: fetchOrgThatMustNotBeCalled(),
        callRpc: callRpcThatMustNotBeCalled(),
      })),
      (err) => err.statusCode === 400
    );
  });
}

test('handleProductChange — a well-formed UUID orgId is accepted', async () => {
  const result = await handleProductChange(baseArgs());
  assert.equal(result.customerType, 'travel');
});

// ── handleProductChange: actor-identity validation ──────────────────────────
// Mirrors the independent checks admin_update_org_product itself makes in
// SQL (see that function's header comment) -- this is the JS-layer half,
// which exists to fail fast and to be testable at all.

test('handleProductChange — a missing actor ID (adminUser null) is rejected with a generic 500, before any I/O', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({
      adminUser: null,
      fetchOrg: fetchOrgThatMustNotBeCalled(),
      callRpc: callRpcThatMustNotBeCalled(),
    })),
    (err) => err.statusCode === 500
  );
});

test('handleProductChange — a missing actor ID (adminUser.id absent) is rejected with a generic 500, before any I/O', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({
      adminUser: { email: 'admin@jobuscout.com' },
      fetchOrg: fetchOrgThatMustNotBeCalled(),
      callRpc: callRpcThatMustNotBeCalled(),
    })),
    (err) => err.statusCode === 500
  );
});

test('handleProductChange — a missing actor email is rejected with a generic 500, before any I/O', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({
      adminUser: { id: 'admin-1' },
      fetchOrg: fetchOrgThatMustNotBeCalled(),
      callRpc: callRpcThatMustNotBeCalled(),
    })),
    (err) => err.statusCode === 500
  );
});

test('handleProductChange — a blank (whitespace-only) actor email is rejected with a generic 500, before any I/O', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({
      adminUser: { id: 'admin-1', email: '   ' },
      fetchOrg: fetchOrgThatMustNotBeCalled(),
      callRpc: callRpcThatMustNotBeCalled(),
    })),
    (err) => err.statusCode === 500
  );
});

test('handleProductChange — a missing actor role is rejected with a generic 500, before any I/O', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({
      adminRole: undefined,
      fetchOrg: fetchOrgThatMustNotBeCalled(),
      callRpc: callRpcThatMustNotBeCalled(),
    })),
    (err) => err.statusCode === 500
  );
});

test('handleProductChange — a blank (whitespace-only) actor role is rejected with a generic 500, before any I/O', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({
      adminRole: '   ',
      fetchOrg: fetchOrgThatMustNotBeCalled(),
      callRpc: callRpcThatMustNotBeCalled(),
    })),
    (err) => err.statusCode === 500
  );
});

test('handleProductChange — none of the actor-identity/orgId checks ever leak into a client-visible message', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({ adminUser: null })),
    (err) => {
      assert.equal(err.statusCode, 500);
      assert.equal(err.message, 'Something went wrong. Please try again.');
      return true;
    }
  );
});

// ── handleProductChange: support-session denial ─────────────────────────────

test('handleProductChange — an active support session is rejected with 403 before any body validation or I/O', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({
      hasSupportSession: true,
      body: { customerType: 'bogus' }, // would also fail validation -- proving support-session check runs first
      fetchOrg: fetchOrgThatMustNotBeCalled(),
      callRpc: callRpcThatMustNotBeCalled(),
    })),
    (err) => err.statusCode === 403
  );
});

// ── handleProductChange: 404 ─────────────────────────────────────────────────

test('handleProductChange — organization not found (pre-fetch) returns 404 and never calls the RPC', async () => {
  const rpc = callRpcThatMustNotBeCalled();
  await assert.rejects(
    handleProductChange(baseArgs({ fetchOrg: fetchOrgNotFound(), callRpc: rpc })),
    (err) => err.statusCode === 404
  );
});

test('handleProductChange — organization deleted in the race window (RPC returns P0002) also maps to 404', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({ callRpc: callRpcNotFound() })),
    (err) => err.statusCode === 404
  );
});

// ── handleProductChange: database-error sanitization ────────────────────────

test('handleProductChange — a raw fetchOrg error is sanitized to a generic 500, never leaking the raw message', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({ fetchOrg: fetchOrgErrors('relation "organizations" does not exist: postgres://admin:s3cr3t@db') })),
    (err) => {
      assert.equal(err.statusCode, 500);
      assert.doesNotMatch(err.message, /organizations|postgres|s3cr3t/i);
      return true;
    }
  );
});

test('handleProductChange — a raw RPC error is sanitized to a generic 500, never leaking the raw message', async () => {
  await assert.rejects(
    handleProductChange(baseArgs({ callRpc: callRpcErrors() })),
    (err) => {
      assert.equal(err.statusCode, 500);
      assert.doesNotMatch(err.message, /duplicate key|constraint/i);
      return true;
    }
  );
});

test('handleProductChange — fetchOrg throwing synchronously (not just rejecting) is also sanitized to a generic 500', async () => {
  const throwingFetch = () => { throw new Error('unexpected sync throw with sensitive detail'); };
  await assert.rejects(
    handleProductChange(baseArgs({ fetchOrg: throwingFetch })),
    (err) => err.statusCode === 500
  );
});

// ── handleProductChange: server-derived products + audit-log data plumbing ──

test('handleProductChange — success: derives enabledProducts server-side and calls the RPC exactly once with the full audit payload', async () => {
  const rpc = callRpcSpy();
  const result = await handleProductChange(baseArgs({
    body: { customerType: 'hybrid', primaryProduct: 'high_school', reason: '  going hybrid  ' },
    callRpc: rpc,
  }));

  assert.equal(rpc.calls.length, 1); // exactly one write call -- no separate update + insert
  assert.equal(rpc.calls[0].name, 'admin_update_org_product');
  // No p_enabled_products key -- the real SQL function derives it
  // server-side from p_customer_type alone and doesn't accept it as a
  // parameter at all (see admin_update_org_product's header comment in
  // supabase/migrations/20260722010000_admin_update_org_product_fn.sql).
  assert.deepEqual(rpc.calls[0].args, {
    p_org_id: VALID_ORG_ID,
    p_customer_type: 'hybrid',
    p_primary_product: 'high_school',
    p_admin_user_id: 'admin-1',
    p_admin_email: 'admin@jobuscout.com',
    p_admin_role: 'owner',
    p_reason: 'going hybrid',
    p_ip_address: '1.2.3.4',
    p_user_agent: 'test-agent',
  });

  assert.deepEqual(result, {
    customerType: 'hybrid',
    primaryProduct: 'high_school',
    enabledProducts: ['travel', 'high_school'],
  });
});

test('handleProductChange — success: the reason reaching the RPC is the JS-trimmed value, not the raw request body value', async () => {
  const rpc = callRpcSpy();
  await handleProductChange(baseArgs({
    body: { customerType: 'travel', reason: '   padded on both sides   \n' },
    callRpc: rpc,
  }));
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].args.p_reason, 'padded on both sides');
});

test('handleProductChange — success: a client-supplied enabledProducts never reaches the RPC call, even if present in the body', async () => {
  const rpc = callRpcSpy();
  await assert.rejects(
    handleProductChange(baseArgs({
      body: { customerType: 'travel', reason: 'r', enabledProducts: ['travel', 'high_school'] },
      callRpc: rpc,
    })),
    (err) => err.statusCode === 400
  );
  assert.equal(rpc.calls.length, 0);
});

test('handleProductChange — success: returns exactly {customerType, primaryProduct, enabledProducts}, no extra fields', async () => {
  const result = await handleProductChange(baseArgs());
  assert.deepEqual(Object.keys(result).sort(), ['customerType', 'enabledProducts', 'primaryProduct']);
});
