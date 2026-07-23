'use strict';

// PATCH /api/admin/customers/:orgId/product -- Phase 2 Slice 2. See
// docs/architecture/PHASE_2_PRODUCT_CAPABILITY_RFC.md §14 for the design.
//
// All business logic lives here, not in src/admin-api.js's route handler,
// specifically so it's unit-testable without a live database -- the same
// pattern src/org-resolution.js established for resolveTrustedOrgId
// (inject the database call; test the real decision logic against a fake).
// The route handler in admin-api.js is a thin Express adapter: it supplies
// fetchOrg/callRpc bound to the real adminClient and maps whatever this
// module throws to an HTTP response.
//
// ── Why a single RPC call, not two separate Supabase calls ─────────────────
// §14's own validation-order pseudocode (steps 8-9) does the organizations
// UPDATE and the admin_audit_log INSERT as two separate calls -- the same
// shape every other existing admin-api.js route uses (see e.g.
// POST /customers/:orgId/status). That's insufficient for this route: a
// product-access change must never persist without its audit record, and
// @supabase/supabase-js (a PostgREST client -- src/supabase.js) has no
// mechanism for a client-side multi-statement transaction; each
// `.from(...).update()/.insert()` call is its own independent HTTP
// request. A crash, timeout, or 5xx between two separate calls would leave
// an unaudited product change. The fix is admin_update_org_product, a
// Postgres function
// (supabase/migrations/20260722010000_admin_update_org_product_fn.sql)
// that performs both writes inside one function body -- one implicit
// transaction, so either both happen or neither does. `callRpc` below is,
// in production, always a single
// `adminClient.rpc('admin_update_org_product', ...)` call -- this module
// never issues a second, separate write.
//
// The atomicity guarantee itself (a failed audit insert rolling back the
// org update, and vice versa) is enforced by Postgres inside that function
// body and is not something a database-free test can exercise directly.
// What the tests below verify is the application-layer discipline this
// module exists to guarantee: exactly one write call is ever made, no
// partial-success path exists in JS, and a failure from that one call
// always maps to a thrown, typed error -- never a 200 with a subset of the
// change applied.
//
// ── enabledProducts is derived in Postgres, not sent by this module ────────
// admin_update_org_product's signature does not accept enabled_products at
// all -- it derives it internally from customer_type (see that function's
// own header comment). ENABLED_PRODUCTS_BY_CUSTOMER_TYPE below exists only
// to validate/describe the request shape this module accepts and to shape
// this module's own return value in tests; it is never sent as an RPC
// parameter, so a future edit here could never desync from what actually
// gets written -- the SQL function's CASE is the only place that mapping
// has any effect on persisted data.
//
// ── Defense in depth is two-sided, not one-sided ────────────────────────────
// admin_update_org_product independently validates reason and actor
// identity itself (see that function's own header comment for exactly why
// admin_audit_log's schema doesn't already guarantee any of this) -- it
// does not depend exclusively on this module having validated first. The
// actor-identity checks in handleProductChange below exist for the
// opposite, complementary reason: to fail fast, with a clear typed error,
// before ever making the RPC round trip, and to be something a
// database-free test can actually exercise (the SQL function's own
// validation can't be -- there's no live Postgres in this test suite).
// Neither layer is there because the other can't be trusted in normal
// operation; both are there because neither should be the ONLY thing
// standing between a malformed call and a persisted change.

const KNOWN_CUSTOMER_TYPES = ['travel', 'high_school', 'hybrid', 'internal'];
const KNOWN_PRODUCTS = ['travel', 'high_school'];

// RFC-8-format UUID (any version/variant -- organizations.id has no
// version constraint of its own, just Postgres's uuid type). Malformed
// orgId is rejected here, before any I/O, so it produces a safe 400
// instead of a raw "invalid input syntax for type uuid" surfacing as an
// unexpected 500 from fetchOrg/callRpc.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one fixed lookup enabledProducts is ever derived from. Never accept
// enabledProducts as client input -- §14's "Request shape simplified"
// revision exists specifically to close that off.
const ENABLED_PRODUCTS_BY_CUSTOMER_TYPE = {
  travel: ['travel'],
  high_school: ['high_school'],
  hybrid: ['travel', 'high_school'],
  internal: ['travel', 'high_school'],
};

function typedError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Pure.
function validateOrgId(orgId) {
  if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) {
    throw typedError('orgId must be a valid UUID', 400);
  }
}

// Pure. Mirrors the checks admin_update_org_product itself independently
// makes (see that function's header comment) -- duplicated deliberately,
// not redundantly: this copy exists to fail fast, before the RPC round
// trip, with a typed error a database-free test can exercise directly.
// A failure here indicates a bug upstream of this module (requireAuth/
// requireJobuAdmin already populate adminUser/adminRole from a verified
// session before this route ever runs), not a client input problem --
// treated as a 500, same as the SQL function's own equivalent checks are
// treated as generic/unexpected by this module's RPC-error handling.
function validateActorIdentity(adminUser, adminRole) {
  if (!adminUser?.id) {
    throw typedError('Something went wrong. Please try again.', 500);
  }
  if (typeof adminUser.email !== 'string' || !adminUser.email.trim()) {
    throw typedError('Something went wrong. Please try again.', 500);
  }
  if (typeof adminRole !== 'string' || !adminRole.trim()) {
    throw typedError('Something went wrong. Please try again.', 500);
  }
}

// Pure. Validation order matches RFC §14 steps 3-5 (step 2, the
// support-session check, happens earlier -- see handleProductChange).
// Rejects any request property beyond customerType/primaryProduct/reason,
// including an explicit enabledProducts -- a caller relying on it must get
// a loud 400, not a silent no-op.
function validateProductChangeRequest(body) {
  const { customerType, primaryProduct, reason, ...rest } = body || {};

  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) {
    throw typedError(`Unknown field(s): ${unknownKeys.join(', ')}`, 400);
  }

  if (!KNOWN_CUSTOMER_TYPES.includes(customerType)) {
    throw typedError(`customerType must be one of: ${KNOWN_CUSTOMER_TYPES.join(', ')}`, 400);
  }

  const requiresChoice = customerType === 'hybrid' || customerType === 'internal';
  let resolvedPrimaryProduct;

  if (requiresChoice) {
    if (!KNOWN_PRODUCTS.includes(primaryProduct)) {
      throw typedError(
        `primaryProduct is required for customerType "${customerType}" and must be one of: ${KNOWN_PRODUCTS.join(', ')}`,
        400
      );
    }
    resolvedPrimaryProduct = primaryProduct;
  } else {
    // customerType is 'travel' or 'high_school': a supplied primaryProduct
    // that disagrees is rejected rather than silently overridden -- silent
    // overriding could mask a client bug (§14).
    if (primaryProduct !== undefined && primaryProduct !== customerType) {
      throw typedError(`primaryProduct must equal customerType ("${customerType}") for this customerType`, 400);
    }
    resolvedPrimaryProduct = customerType;
  }

  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmedReason) {
    throw typedError('A reason is required.', 400);
  }

  return {
    customerType,
    primaryProduct: resolvedPrimaryProduct,
    enabledProducts: ENABLED_PRODUCTS_BY_CUSTOMER_TYPE[customerType],
    reason: trimmedReason,
  };
}

// Orchestration -- the only place that touches (injected) I/O. Mirrors RFC
// §14's validation order, with two additions ahead of it (orgId
// well-formedness and actor-identity sanity, neither of which §14
// enumerates as a numbered step but both of which must fail safely):
//   0a. orgId is a well-formed UUID -> 400, before any I/O.
//   0b. actor identity (adminUser.id/email, adminRole) is present and
//       non-blank -> 500, before any I/O.
//   1. requireAuth/requireJobuAdmin -- already applied at the Express
//      router level before this ever runs; not this module's concern.
//   2. active support session -> 403, before any other validation.
//   3-5. request body validation (validateProductChangeRequest above).
//   6. fetch current org, 404 if missing.
//   7. derive enabledProducts (folded into validateProductChangeRequest).
//   8-9. atomic update + audit log, via the single callRpc call.
//  10. return the new state.
async function handleProductChange({
  orgId, body, hasSupportSession, adminUser, adminRole, req, fetchOrg, callRpc,
}) {
  validateOrgId(orgId);
  validateActorIdentity(adminUser, adminRole);

  if (hasSupportSession) {
    throw typedError('Product access cannot be changed during an active support session.', 403);
  }

  const validated = validateProductChangeRequest(body);

  let existing, fetchError;
  try {
    ({ data: existing, error: fetchError } = await fetchOrg(orgId));
  } catch (err) {
    fetchError = err;
  }
  if (fetchError) {
    console.error('[admin-product-route] organization existence check failed:', fetchError);
    throw typedError('Something went wrong. Please try again.', 500);
  }
  if (!existing) {
    throw typedError('Customer not found', 404);
  }

  let data, rpcError;
  try {
    ({ data, error: rpcError } = await callRpc('admin_update_org_product', {
      p_org_id: orgId,
      p_customer_type: validated.customerType,
      p_primary_product: validated.primaryProduct,
      p_admin_user_id: adminUser?.id || null,
      p_admin_email: adminUser?.email || null,
      p_admin_role: adminRole || null,
      p_reason: validated.reason,
      p_ip_address: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      p_user_agent: req?.headers?.['user-agent'] || null,
    }));
  } catch (err) {
    rpcError = err;
  }

  if (rpcError) {
    if (rpcError.code === 'P0002') {
      throw typedError('Customer not found', 404);
    }
    console.error('[admin-product-route] admin_update_org_product failed:', rpcError);
    throw typedError('Something went wrong. Please try again.', 500);
  }

  return {
    customerType: data.customerType,
    primaryProduct: data.primaryProduct,
    enabledProducts: data.enabledProducts,
  };
}

module.exports = {
  KNOWN_CUSTOMER_TYPES,
  KNOWN_PRODUCTS,
  ENABLED_PRODUCTS_BY_CUSTOMER_TYPE,
  validateProductChangeRequest,
  handleProductChange,
};
