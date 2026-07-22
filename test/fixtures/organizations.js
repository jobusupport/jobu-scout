'use strict';

// Reusable `organizations` row fixtures for Phase 2 capability tests.
//
// Plain data objects, not test-framework-specific helpers, so both the
// database-free unit tests in test/product-capabilities.test.js and the
// (written-but-not-yet-run) integration tests in
// test/api-product-capabilities.test.js can import the same fixtures --
// and so these can become real seed rows for Slice 2's integration tests
// later without rewriting them.
//
// Shape matches ORGANIZATION_SELECT_COLUMNS in src/product-capabilities.js.

const { limitsColumnsForTier } = require('../../src/stripe');

function baseRow(overrides = {}) {
  const tierDefaults = limitsColumnsForTier(overrides.plan || 'coach');
  return {
    customer_type: 'travel',
    primary_product: 'travel',
    enabled_products: ['travel'],
    onboarding_completed_at: null,
    plan: 'coach',
    status: 'active',
    max_opponent_teams: tierDefaults.max_opponent_teams,
    max_reports_per_month: tierDefaults.max_reports_per_month,
    max_self_scout_reports_per_month: tierDefaults.max_self_scout_reports_per_month,
    max_matchup_reports_per_month: tierDefaults.max_matchup_reports_per_month,
    ...overrides,
  };
}

// ── Valid, well-formed organizations (satisfy the DB constraints) ──────────

const travelOrg = baseRow({
  customer_type: 'travel',
  primary_product: 'travel',
  enabled_products: ['travel'],
});

const highSchoolOrg = baseRow({
  customer_type: 'high_school',
  primary_product: 'high_school',
  enabled_products: ['high_school'],
});

const hybridOrg = baseRow({
  customer_type: 'hybrid',
  primary_product: 'travel',
  enabled_products: ['travel', 'high_school'],
});

const internalOrg = baseRow({
  customer_type: 'internal',
  primary_product: 'high_school',
  enabled_products: ['high_school', 'travel'], // deliberately reversed order vs hybridOrg
  plan: 'organization',
});

// A pre-existing organization backfilled by the Phase 2 Slice 1 migration:
// onboarding_completed_at stays null (no backfill was performed).
const preExistingTravelOrg = baseRow({
  customer_type: 'travel',
  primary_product: 'travel',
  enabled_products: ['travel'],
  onboarding_completed_at: null,
});

// A newer organization that has since completed onboarding.
const onboardedTravelOrg = baseRow({
  onboarding_completed_at: '2026-06-01T12:00:00.000Z',
});

// An organization with an active admin entitlement override (a limit column
// manually adjusted away from its plan default).
const overriddenLimitsOrg = baseRow({
  plan: 'coach',
  max_reports_per_month: 999999, // UNLIMITED_VALUE sentinel, matches src/admin-api.js
});

// ── Malformed organizations (should never occur given the DB constraints in
//    supabase/migrations/20260721140000_add_organization_product_fields.sql;
//    these exercise sanitizeOrganizationRow's defense-in-depth branches for
//    an out-of-band manual edit that bypassed them) ─────────────────────────

const malformedCustomerTypeOrg = baseRow({
  customer_type: 'not_a_real_type',
  primary_product: 'travel',
  enabled_products: ['travel'],
});

const emptyEnabledProductsOrg = baseRow({
  customer_type: 'travel',
  primary_product: 'travel',
  enabled_products: [],
});

const unknownProductInEnabledOrg = baseRow({
  customer_type: 'hybrid',
  primary_product: 'travel',
  enabled_products: ['travel', 'college_showcase'],
});

const primaryNotInEnabledOrg = baseRow({
  customer_type: 'travel',
  primary_product: 'high_school', // not a member of enabled_products below
  enabled_products: ['travel'],
});

module.exports = {
  baseRow,
  travelOrg,
  highSchoolOrg,
  hybridOrg,
  internalOrg,
  preExistingTravelOrg,
  onboardedTravelOrg,
  overriddenLimitsOrg,
  malformedCustomerTypeOrg,
  emptyEnabledProductsOrg,
  unknownProductInEnabledOrg,
  primaryNotInEnabledOrg,
};
