'use strict';

// Product-capability resolution -- the single source of truth for which
// products (Travel / High School) an organization may access, and for the
// rest of the derived state ("what can this org actually do") a route or
// page would otherwise have to independently reinterpret from raw
// organization columns.
//
// Two distinctions this module exists to keep clear:
//
// 1. IDENTITY vs. LICENSING. `customer_type` describes what kind of
//    baseball program an organization is (travel / high_school / hybrid /
//    internal) -- it is not itself a license grant. `enabled_products` is
//    the actual licensing/entitlement field. As of Phase 2 Slice 1 the two
//    are fully correlated by a database constraint (there are only two
//    products, so every customer_type maps to exactly one valid product
//    set) -- but they remain conceptually distinct, and `enabled_products`
//    stays its own stored column rather than a value derived from
//    customer_type at read time, specifically so a future third product
//    doesn't require reshaping every place that reads it.
//
// 2. FAIL-CLOSED RESPONSES vs. DATA REPAIR. `sanitizeOrganizationRow` below
//    corrects what a single caller sees in a single response when the
//    persisted row is malformed. It does NOT write anything back to the
//    database. A malformed row stays exactly as malformed in Postgres as it
//    was before the call -- only the in-memory value handed to the pure
//    resolver, and therefore the API response, is corrected. Treat a
//    warning logged by that function as a data-quality incident to
//    investigate (most likely an out-of-band manual edit, since the
//    database CHECK constraints in
//    supabase/migrations/20260721140000_add_organization_product_fields.sql
//    make this unreachable through any normal application code path), not
//    as something already handled.

const { limitsColumnsForTier } = require('./stripe');

// Lazily required inside getOrganizationCapabilities (below), not at module
// load time. src/supabase.js constructs a Supabase client as soon as it's
// required, which throws if Supabase env vars aren't set -- eagerly
// requiring it here would mean simply importing this module (to reach the
// pure sanitizeOrganizationRow/resolveOrganizationCapabilities functions,
// as the database-free unit tests do) could fail in an environment with no
// Supabase configuration at all, which defeats the point of those functions
// being pure and dependency-free in the first place.
function loadAdminClient() {
  return require('./supabase').adminClient;
}

const KNOWN_PRODUCTS = ['travel', 'high_school'];
const KNOWN_CUSTOMER_TYPES = ['travel', 'high_school', 'hybrid', 'internal'];
const CAPABILITY_SCHEMA_VERSION = 1;

const LIMIT_COLUMNS = [
  'max_opponent_teams',
  'max_reports_per_month',
  'max_self_scout_reports_per_month',
  'max_matchup_reports_per_month',
];

const ORGANIZATION_SELECT_COLUMNS = [
  'customer_type',
  'primary_product',
  'enabled_products',
  'onboarding_completed_at',
  'plan',
  'status',
  ...LIMIT_COLUMNS,
].join(', ');

// ── Sanitization: in-memory fail-closed boundary only ───────────────────────
//
// Never persists anything. Returns a corrected copy of orgRow when the
// stored product fields are malformed (outside the value set / relationship
// the DB constraints are supposed to guarantee), collapsed toward the
// smallest currently-functional product set (Travel-only) -- never toward a
// broader one. Every correction is logged so a malformed row is visible as
// an operational signal, not silently absorbed.
function sanitizeOrganizationRow(orgRow) {
  if (!orgRow) return orgRow;

  let { customer_type, primary_product, enabled_products } = orgRow;
  let corrected = false;

  if (!KNOWN_CUSTOMER_TYPES.includes(customer_type)) {
    console.warn(
      '[product-capabilities] malformed customer_type on organization; falling back to travel-only for this response only (database row is untouched):',
      { customer_type }
    );
    customer_type = 'travel';
    enabled_products = ['travel'];
    primary_product = 'travel';
    corrected = true;
  } else if (
    !Array.isArray(enabled_products) ||
    enabled_products.length === 0 ||
    enabled_products.some((p) => !KNOWN_PRODUCTS.includes(p))
  ) {
    console.warn(
      '[product-capabilities] malformed enabled_products on organization; falling back to travel-only for this response only (database row is untouched):',
      { enabled_products }
    );
    enabled_products = ['travel'];
    primary_product = 'travel';
    corrected = true;
  } else if (!enabled_products.includes(primary_product)) {
    console.warn(
      '[product-capabilities] primary_product not present in enabled_products; correcting for this response only (database row is untouched):',
      { primary_product, enabled_products }
    );
    primary_product = enabled_products[0];
    corrected = true;
  }

  if (!corrected) return orgRow;
  return { ...orgRow, customer_type, primary_product, enabled_products };
}

// ── Pure resolver ────────────────────────────────────────────────────────────
//
// No I/O, no logging, no defensive correction -- assumes orgRow already
// satisfies the invariants sanitizeOrganizationRow exists to guarantee.
// Given the same input, always returns the same output.
function resolveOrganizationCapabilities(orgRow) {
  // Copied, not referenced: the caller's response must not share a mutable
  // array with orgRow.enabled_products. sanitizeOrganizationRow can return
  // the input row unchanged (same object, same nested array) when nothing
  // needed correcting, and callers may hold onto that same orgRow elsewhere
  // (a Supabase client result, a shared test fixture) -- if a downstream
  // consumer ever mutated the returned enabledProducts array in place, an
  // uncopied reference here would silently corrupt that shared source.
  const enabledProducts = [...orgRow.enabled_products];

  const features = {
    'travel.enabled': enabledProducts.includes('travel'),
    'highSchool.enabled': enabledProducts.includes('high_school'),
  };

  const tierDefaults = limitsColumnsForTier(orgRow.plan);
  const overridesActive = LIMIT_COLUMNS.some(
    (col) => orgRow[col] !== tierDefaults[col]
  );

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    customerType: orgRow.customer_type,
    primaryProduct: orgRow.primary_product,
    enabledProducts,
    onboardingCompleted: orgRow.onboarding_completed_at !== null,
    features,
    limits: {
      opponentTeams: orgRow.max_opponent_teams,
      travelReportsPerMonth: orgRow.max_reports_per_month,
      selfScoutReportsPerMonth: orgRow.max_self_scout_reports_per_month,
      matchupReportsPerMonth: orgRow.max_matchup_reports_per_month,
    },
    billing: {
      plan: orgRow.plan,
      status: orgRow.status,
    },
    overridesActive,
  };
}

// ── Row-existence mapping: pure, database-free ──────────────────────────────
//
// Split out from getOrganizationCapabilities specifically so the
// row-not-found -> 404 mapping is unit-testable without a database
// connection. Returns orgRow unchanged when present.
function mapOrganizationRowOrThrow(orgRow) {
  if (!orgRow) {
    const err = new Error('Organization not found.');
    err.statusCode = 404;
    throw err;
  }
  return orgRow;
}

// ── Orchestration: the only exported function that touches the database ────
//
// Takes a plain orgId, not an Express req -- getRequestOrgId is private to
// server.js (not exported; the same problem admin-api.js already avoids
// today by having server.js inject requireAuth rather than importing it).
// The route handler in server.js resolves orgId itself and passes it in,
// keeping this module fully decoupled from Express request objects.
//
// A query error is thrown unchanged (not mapped to a safe message here) --
// deciding what's safe to show a client is the route layer's job, not
// this module's; see GET /api/product/capabilities's catch block in
// server.js, which only ever forwards err.message when err.statusCode was
// set explicitly by this module (the 404 case), and substitutes a generic
// message for anything else, including a raw error from this line.
async function getOrganizationCapabilities(orgId) {
  const adminClient = loadAdminClient();
  const { data: orgRow, error } = await adminClient
    .from('organizations')
    .select(ORGANIZATION_SELECT_COLUMNS)
    .eq('id', orgId)
    .maybeSingle();

  if (error) throw error;
  mapOrganizationRowOrThrow(orgRow);

  const safeRow = sanitizeOrganizationRow(orgRow);
  return resolveOrganizationCapabilities(safeRow);
}

// ── Middleware: built and unit-tested, not mounted on any route yet ────────
//
// Fails closed on every path: an error resolving capabilities, a missing
// org, or the requested product not being enabled all deny (403). Never
// trusts a client-supplied product value -- `product` is always a literal
// baked into a route definition by the developer, never read from
// req.body/req.query/req.params.
//
// Expects req._orgId to already be populated by upstream middleware (the
// same invariant blockWriteDuringReadOnlySupport in src/admin-lib.js
// already relies on) -- this middleware does not perform org resolution
// itself.
function requireProductAccess(product) {
  // Validated once, at route-definition time, not per-request: a typo'd
  // product name (e.g. 'highschool' instead of 'high_school') would
  // otherwise deny every request forever with no indication why -- fail
  // loudly here, at server startup, rather than as a silent permanent 403.
  if (!KNOWN_PRODUCTS.includes(product)) {
    throw new Error(
      `requireProductAccess: unknown product "${product}". Expected one of: ${KNOWN_PRODUCTS.join(', ')}.`
    );
  }
  return async function requireProductAccessMiddleware(req, res, next) {
    try {
      const orgId = req._orgId;
      if (!orgId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const capabilities = await getOrganizationCapabilities(orgId);
      if (!capabilities.enabledProducts.includes(product)) {
        return res.status(403).json({ error: `This organization does not have ${product} access.` });
      }
      req.productCapabilities = capabilities;
      next();
    } catch (err) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  };
}

module.exports = {
  sanitizeOrganizationRow,
  resolveOrganizationCapabilities,
  mapOrganizationRowOrThrow,
  getOrganizationCapabilities,
  requireProductAccess,
  KNOWN_PRODUCTS,
  KNOWN_CUSTOMER_TYPES,
  CAPABILITY_SCHEMA_VERSION,
};
