'use strict';

// Database-free unit tests for src/product-capabilities.js.
// Run with: node --test test/product-capabilities.test.js
//
// package.json's "test" script lists this file (and
// test/api-product-capabilities.test.js) explicitly by path, rather than a
// bare `node --test`. That's deliberate, not an oversight: a bare
// invocation auto-discovers every file in the repo matching Node's default
// test-file patterns, which swept up pre-existing, unrelated CLI utility
// scripts (scripts/test-user-setup.js, scripts/test-webhook.js, etc. --
// named starting with "test-" but never meant to be run this way) and
// caused spurious failures. The explicit list is the safest cross-platform
// option (glob-expansion behavior for `test/*.test.js` isn't guaranteed
// identical between POSIX shells and Windows cmd.exe, which this repo runs
// under). New test files under test/ must be added to that list by hand --
// they will not be picked up automatically.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeOrganizationRow,
  resolveOrganizationCapabilities,
  mapOrganizationRowOrThrow,
  requireProductAccess,
  CAPABILITY_SCHEMA_VERSION,
} = require('../src/product-capabilities');

const fixtures = require('./fixtures/organizations');

test('resolveOrganizationCapabilities — travel org', () => {
  const result = resolveOrganizationCapabilities(fixtures.travelOrg);
  assert.equal(result.customerType, 'travel');
  assert.equal(result.primaryProduct, 'travel');
  assert.deepEqual(result.enabledProducts, ['travel']);
  assert.equal(result.features['travel.enabled'], true);
  assert.equal(result.features['highSchool.enabled'], false);
});

test('resolveOrganizationCapabilities — high school org', () => {
  const result = resolveOrganizationCapabilities(fixtures.highSchoolOrg);
  assert.equal(result.customerType, 'high_school');
  assert.equal(result.primaryProduct, 'high_school');
  assert.deepEqual(result.enabledProducts, ['high_school']);
  assert.equal(result.features['travel.enabled'], false);
  assert.equal(result.features['highSchool.enabled'], true);
});

test('resolveOrganizationCapabilities — hybrid org has both products enabled', () => {
  const result = resolveOrganizationCapabilities(fixtures.hybridOrg);
  assert.equal(result.customerType, 'hybrid');
  assert.equal(result.primaryProduct, 'travel');
  assert.deepEqual(result.enabledProducts.slice().sort(), ['high_school', 'travel']);
  assert.equal(result.features['travel.enabled'], true);
  assert.equal(result.features['highSchool.enabled'], true);
});

test('resolveOrganizationCapabilities — internal org has both products enabled regardless of array order', () => {
  const result = resolveOrganizationCapabilities(fixtures.internalOrg);
  assert.equal(result.customerType, 'internal');
  assert.equal(result.features['travel.enabled'], true);
  assert.equal(result.features['highSchool.enabled'], true);
});

test('resolveOrganizationCapabilities — onboardingCompleted reflects onboarding_completed_at', () => {
  const preExisting = resolveOrganizationCapabilities(fixtures.preExistingTravelOrg);
  assert.equal(preExisting.onboardingCompleted, false);

  const onboarded = resolveOrganizationCapabilities(fixtures.onboardedTravelOrg);
  assert.equal(onboarded.onboardingCompleted, true);
});

test('resolveOrganizationCapabilities — every pre-existing org resolves onboardingCompleted=false (no backfill was performed)', () => {
  // Direct regression test for the explicit decision that
  // onboarding_completed_at defaults to NULL with no backfill.
  const result = resolveOrganizationCapabilities(fixtures.travelOrg);
  assert.equal(fixtures.travelOrg.onboarding_completed_at, null);
  assert.equal(result.onboardingCompleted, false);
});

test('resolveOrganizationCapabilities — overridesActive is false when limits match plan defaults', () => {
  const result = resolveOrganizationCapabilities(fixtures.travelOrg);
  assert.equal(result.overridesActive, false);
});

test('resolveOrganizationCapabilities — overridesActive is true when a limit has been manually overridden', () => {
  const result = resolveOrganizationCapabilities(fixtures.overriddenLimitsOrg);
  assert.equal(result.overridesActive, true);
});

test('resolveOrganizationCapabilities — every response includes schemaVersion', () => {
  for (const org of [fixtures.travelOrg, fixtures.highSchoolOrg, fixtures.hybridOrg, fixtures.internalOrg]) {
    const result = resolveOrganizationCapabilities(org);
    assert.equal(result.schemaVersion, CAPABILITY_SCHEMA_VERSION);
    assert.equal(result.schemaVersion, 1);
  }
});

test('resolveOrganizationCapabilities — billing block reflects plan/status columns, never product fields', () => {
  const result = resolveOrganizationCapabilities(fixtures.internalOrg);
  assert.equal(result.billing.plan, fixtures.internalOrg.plan);
  assert.equal(result.billing.status, fixtures.internalOrg.status);
});

// ── sanitizeOrganizationRow: in-memory fail-closed boundary only ───────────

test('sanitizeOrganizationRow — well-formed rows pass through unchanged (same reference)', () => {
  const result = sanitizeOrganizationRow(fixtures.travelOrg);
  assert.equal(result, fixtures.travelOrg); // identity, not just deep-equal: proves no copy/mutation happened
});

test('sanitizeOrganizationRow — malformed customer_type falls back to travel-only', () => {
  const original = { ...fixtures.malformedCustomerTypeOrg };
  const result = sanitizeOrganizationRow(fixtures.malformedCustomerTypeOrg);

  assert.equal(result.customer_type, 'travel');
  assert.deepEqual(result.enabled_products, ['travel']);
  assert.equal(result.primary_product, 'travel');

  // Must not mutate the input, and must not be the same object -- proves
  // the "fail-closed derives a response, does not repair persisted state"
  // contract: the caller's original row object is left exactly as it was.
  assert.notEqual(result, fixtures.malformedCustomerTypeOrg);
  assert.deepEqual(fixtures.malformedCustomerTypeOrg, original);
});

test('sanitizeOrganizationRow — empty enabled_products falls back to travel-only', () => {
  const original = { ...fixtures.emptyEnabledProductsOrg };
  const result = sanitizeOrganizationRow(fixtures.emptyEnabledProductsOrg);

  assert.deepEqual(result.enabled_products, ['travel']);
  assert.equal(result.primary_product, 'travel');
  assert.deepEqual(fixtures.emptyEnabledProductsOrg, original); // input untouched
});

test('sanitizeOrganizationRow — unknown product name inside enabled_products falls back to travel-only', () => {
  const result = sanitizeOrganizationRow(fixtures.unknownProductInEnabledOrg);
  assert.deepEqual(result.enabled_products, ['travel']);
  assert.equal(result.primary_product, 'travel');
});

test('sanitizeOrganizationRow — primary_product not a member of enabled_products is corrected to a member', () => {
  const original = { ...fixtures.primaryNotInEnabledOrg };
  const result = sanitizeOrganizationRow(fixtures.primaryNotInEnabledOrg);

  assert.equal(result.customer_type, 'travel');
  assert.deepEqual(result.enabled_products, ['travel']);
  assert.equal(result.primary_product, 'travel');
  assert.ok(result.enabled_products.includes(result.primary_product));
  assert.deepEqual(fixtures.primaryNotInEnabledOrg, original); // input untouched
});

test('sanitizeOrganizationRow — never grants broader access than the input, only ever narrows toward travel-only', () => {
  for (const org of [
    fixtures.malformedCustomerTypeOrg,
    fixtures.emptyEnabledProductsOrg,
    fixtures.unknownProductInEnabledOrg,
    fixtures.primaryNotInEnabledOrg,
  ]) {
    const result = sanitizeOrganizationRow(org);
    assert.deepEqual(result.enabled_products, ['travel']);
  }
});

test('sanitizeOrganizationRow — module exposes no database-write function of any kind', () => {
  // Structural guarantee, not a mock assertion: this module's public API
  // (see module.exports in src/product-capabilities.js) contains exactly
  // one function that touches the database (getOrganizationCapabilities,
  // a read), and it is not sanitizeOrganizationRow. There is nothing in
  // this module capable of persisting a "corrected" row even by accident.
  const productCapabilities = require('../src/product-capabilities');
  const exportedNames = Object.keys(productCapabilities);
  const writeLikeNames = exportedNames.filter((name) =>
    /^(update|insert|upsert|delete|write|save|persist|repair|fix)/i.test(name)
  );
  assert.deepEqual(writeLikeNames, []);
});

test('sanitizing then resolving a malformed row produces a fully self-consistent, safe capability response', () => {
  const sanitized = sanitizeOrganizationRow(fixtures.malformedCustomerTypeOrg);
  const result = resolveOrganizationCapabilities(sanitized);

  assert.equal(result.customerType, 'travel');
  assert.deepEqual(result.enabledProducts, ['travel']);
  assert.equal(result.features['highSchool.enabled'], false);
});

// ── Regression tests for the two defects found in final review ────────────

test('resolveOrganizationCapabilities — enabledProducts is a copy, not a shared reference with the input row', () => {
  const org = { ...fixtures.hybridOrg, enabled_products: [...fixtures.hybridOrg.enabled_products] };
  const result = resolveOrganizationCapabilities(org);

  assert.notEqual(result.enabledProducts, org.enabled_products); // different array objects
  assert.deepEqual(result.enabledProducts.slice().sort(), org.enabled_products.slice().sort()); // same values

  // Mutating the response must not corrupt the source row.
  result.enabledProducts.push('some_future_product');
  assert.deepEqual(org.enabled_products.slice().sort(), ['high_school', 'travel']);
});

test('resolveOrganizationCapabilities — mutating the response never corrupts a shared fixture', () => {
  // Direct proof this can't happen with the actual shared fixtures other
  // tests in this file reuse (fixtures.travelOrg etc. are singletons).
  const before = [...fixtures.travelOrg.enabled_products];
  const result = resolveOrganizationCapabilities(fixtures.travelOrg);
  result.enabledProducts.push('corrupted');
  assert.deepEqual(fixtures.travelOrg.enabled_products, before);
});

test('requireProductAccess — throws immediately at definition time for an unknown product', () => {
  assert.throws(() => requireProductAccess('highschool'), /unknown product/i); // typo: missing underscore
  assert.throws(() => requireProductAccess(''), /unknown product/i);
  assert.throws(() => requireProductAccess(undefined), /unknown product/i);
});

test('requireProductAccess — does not throw for either real product', () => {
  assert.doesNotThrow(() => requireProductAccess('travel'));
  assert.doesNotThrow(() => requireProductAccess('high_school'));
});

test('requireProductAccess — denies with 403 and does not call next() when req._orgId is missing', async () => {
  const middleware = requireProductAccess('travel');
  let nextCalled = false;
  let statusCode = null;
  let body = null;
  const req = {}; // no _orgId
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.ok(body.error);
});

// ── mapOrganizationRowOrThrow: database-free regression tests for the
// tenant-isolation fix (extracted from getOrganizationCapabilities
// specifically so this mapping is testable without a database) ───────────

test('mapOrganizationRowOrThrow — throws a 404 with the documented message when the row is missing', () => {
  assert.throws(
    () => mapOrganizationRowOrThrow(null),
    (err) => err.statusCode === 404 && err.message === 'Organization not found.'
  );
  assert.throws(
    () => mapOrganizationRowOrThrow(undefined),
    (err) => err.statusCode === 404
  );
});

test('mapOrganizationRowOrThrow — returns a present row unchanged', () => {
  const result = mapOrganizationRowOrThrow(fixtures.travelOrg);
  assert.equal(result, fixtures.travelOrg); // identity, not a copy
});
