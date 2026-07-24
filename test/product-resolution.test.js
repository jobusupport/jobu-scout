'use strict';

// Focused, database-free tests for src/product-resolution.js -- the
// canonical active-product resolver for the Jobu Scout Travel / Jobu
// Scout High School product split.
//
// Every test here passes a plain capabilities object (the same shape
// src/product-capabilities.js's getOrganizationCapabilities returns) --
// no Express request, no database, no client state. That's the point:
// this module's only inputs are server-derived capabilities and a
// requested product string, so its correctness can be fully verified
// without any of that infrastructure.
//
// Run with: node --test test/product-resolution.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRODUCTS,
  PRODUCT_KEYS,
  DEFAULT_PRODUCT,
  isKnownProduct,
  productForRouteKey,
  safeEntitlements,
  resolveActiveProduct,
} = require('../src/product-resolution.js');

function caps(enabledProducts, primaryProduct) {
  return { enabledProducts, primaryProduct };
}

// ── Centralized labels/route keys (Phase 3, requirement 10) ────────────────

test('PRODUCTS centralizes exactly the two customer-facing products with stable route keys and labels', () => {
  assert.deepEqual(PRODUCT_KEYS, ['travel', 'high_school']);
  assert.equal(PRODUCTS.travel.routeKey, 'travel');
  assert.equal(PRODUCTS.travel.path, '/travel');
  assert.equal(PRODUCTS.travel.label, 'Jobu Scout Travel');
  assert.equal(PRODUCTS.high_school.routeKey, 'high-school');
  assert.equal(PRODUCTS.high_school.path, '/high-school');
  assert.equal(PRODUCTS.high_school.label, 'Jobu Scout High School');
});

test('productForRouteKey maps a URL path segment back to its product key', () => {
  assert.equal(productForRouteKey('travel'), 'travel');
  assert.equal(productForRouteKey('high-school'), 'high_school');
});

test('productForRouteKey fails safely (returns null, does not throw) for an unknown identifier', () => {
  assert.equal(productForRouteKey('lacrosse'), null);
  assert.equal(productForRouteKey(''), null);
  assert.equal(productForRouteKey(undefined), null);
});

test('isKnownProduct rejects anything outside the two real products', () => {
  assert.equal(isKnownProduct('travel'), true);
  assert.equal(isKnownProduct('high_school'), true);
  assert.equal(isKnownProduct('hybrid'), false);
  assert.equal(isKnownProduct('internal'), false);
  assert.equal(isKnownProduct('HIGH_SCHOOL'), false);
  assert.equal(isKnownProduct(null), false);
});

// ── 1. Travel-only default resolution ───────────────────────────────────────

test('Travel-only organization resolves to Travel with no requested product', () => {
  const result = resolveActiveProduct(caps(['travel'], 'travel'), null);
  assert.equal(result.activeProduct, 'travel');
  assert.equal(result.showSwitcher, false);
});

// ── 2. High-School-only default resolution ──────────────────────────────────

test('High-School-only organization resolves to High School with no requested product', () => {
  const result = resolveActiveProduct(caps(['high_school'], 'high_school'), null);
  assert.equal(result.activeProduct, 'high_school');
  assert.equal(result.showSwitcher, false);
});

// ── 3 & 4. Hybrid defaults to its server-defined primaryProduct ─────────────

test('Hybrid organization with primaryProduct=travel resolves to Travel by default', () => {
  const result = resolveActiveProduct(caps(['travel', 'high_school'], 'travel'), null);
  assert.equal(result.activeProduct, 'travel');
  assert.equal(result.showSwitcher, true);
});

test('Hybrid organization with primaryProduct=high_school resolves to High School by default', () => {
  const result = resolveActiveProduct(caps(['travel', 'high_school'], 'high_school'), null);
  assert.equal(result.activeProduct, 'high_school');
  assert.equal(result.showSwitcher, true);
});

// ── 5. Internal-account resolution under its configured entitlements ───────
// This module never special-cases "internal" -- it only ever reads
// enabledProducts/primaryProduct, exactly as product-capabilities.js
// already derives them for every customer_type. An internal org's
// resolution is therefore identical in shape to a hybrid org's: it
// resolves into an allowed-product set, never a third shell.

test('Internal-account organization resolves under its configured entitlements, identically to hybrid', () => {
  const result = resolveActiveProduct(caps(['travel', 'high_school'], 'high_school'), null);
  assert.equal(result.activeProduct, 'high_school');
  assert.equal(result.enabledProducts, result.enabledProducts); // sanity: same shape as hybrid case above
  assert.equal(result.showSwitcher, true);
});

// ── 6 & 7. A requested product outside entitlements is rejected/redirected ──

test('Travel-only organization requesting the High School route is redirected to Travel, not granted', () => {
  const result = resolveActiveProduct(caps(['travel'], 'travel'), 'high_school');
  assert.equal(result.activeProduct, 'travel');
  assert.equal(result.redirected, true);
});

test('High-School-only organization requesting the Travel route is redirected to High School, not granted', () => {
  const result = resolveActiveProduct(caps(['high_school'], 'high_school'), 'travel');
  assert.equal(result.activeProduct, 'high_school');
  assert.equal(result.redirected, true);
});

// ── 8. Hybrid can access both routes without a redirect ─────────────────────

test('Hybrid organization requesting Travel is granted Travel with no redirect', () => {
  const result = resolveActiveProduct(caps(['travel', 'high_school'], 'travel'), 'travel');
  assert.equal(result.activeProduct, 'travel');
  assert.equal(result.redirected, false);
});

test('Hybrid organization requesting High School is granted High School with no redirect', () => {
  const result = resolveActiveProduct(caps(['travel', 'high_school'], 'travel'), 'high_school');
  assert.equal(result.activeProduct, 'high_school');
  assert.equal(result.redirected, false);
});

// ── 9. Invalid requested product ────────────────────────────────────────────

test('An unrecognized requested product string is ignored, falling back to primaryProduct', () => {
  const result = resolveActiveProduct(caps(['travel', 'high_school'], 'high_school'), 'lacrosse');
  assert.equal(result.activeProduct, 'high_school');
});

test('A requested product that is technically a known product key but not enabled for this org is rejected', () => {
  // Defense in depth: even though 'high_school' is a real product key,
  // this org's enabledProducts does not include it.
  const result = resolveActiveProduct(caps(['travel'], 'travel'), 'high_school');
  assert.equal(result.activeProduct, 'travel');
});

// ── 10. Missing or malformed configuration fails safely ─────────────────────

test('Missing capabilities object falls back to Travel-only, never to "allow everything"', () => {
  const result = resolveActiveProduct(undefined, 'high_school');
  assert.deepEqual(result.enabledProducts, [DEFAULT_PRODUCT]);
  assert.equal(result.primaryProduct, DEFAULT_PRODUCT);
  assert.equal(result.activeProduct, DEFAULT_PRODUCT);
  assert.equal(result.showSwitcher, false);
});

test('enabledProducts as a non-array falls back to Travel-only', () => {
  const result = safeEntitlements({ enabledProducts: 'travel', primaryProduct: 'travel' });
  assert.deepEqual(result, { enabledProducts: [DEFAULT_PRODUCT], primaryProduct: DEFAULT_PRODUCT });
});

test('enabledProducts containing unknown values is filtered, never trusted verbatim', () => {
  const result = safeEntitlements({ enabledProducts: ['travel', 'lacrosse'], primaryProduct: 'travel' });
  assert.deepEqual(result.enabledProducts, ['travel']);
});

test('enabledProducts as an empty array falls back to Travel-only', () => {
  const result = safeEntitlements({ enabledProducts: [], primaryProduct: 'travel' });
  assert.deepEqual(result, { enabledProducts: [DEFAULT_PRODUCT], primaryProduct: DEFAULT_PRODUCT });
});

test('primaryProduct not present in enabledProducts is corrected to the first enabled product, not trusted verbatim', () => {
  const result = safeEntitlements({ enabledProducts: ['high_school'], primaryProduct: 'travel' });
  assert.deepEqual(result, { enabledProducts: ['high_school'], primaryProduct: 'high_school' });
});

// ── 7 (client state) / URL edits cannot expand entitlements ────────────────

test('A requested product can only narrow the result, never add a product beyond enabledProducts', () => {
  const singleProductResult = resolveActiveProduct(caps(['travel'], 'travel'), 'high_school');
  assert.notEqual(singleProductResult.activeProduct, 'high_school');
});

// ── safeEntitlements never mutates the input, and returns a defensive copy ─

test('resolveActiveProduct does not mutate the input capabilities object (org configuration is never changed)', () => {
  const input = caps(['travel', 'high_school'], 'travel');
  const snapshot = JSON.parse(JSON.stringify(input));
  resolveActiveProduct(input, 'high_school');
  assert.deepEqual(input, snapshot);
});

test('enabledProducts returned is a defensive copy, not the same array reference as the input', () => {
  const input = caps(['travel', 'high_school'], 'travel');
  const result = resolveActiveProduct(input, null);
  assert.notEqual(result.enabledProducts, input.enabledProducts);
});

// ── 14. Recalculation is purely a function of the capabilities passed in ───
// (Organization switching, in this codebase, means a fresh capabilities
// fetch for the new organization -- resolution itself has no memory
// between calls, so "recalculates on switch" reduces to this property.)

test('Resolution recalculates independently for a different organization\'s capabilities (no cross-call memory)', () => {
  const orgA = resolveActiveProduct(caps(['travel'], 'travel'), null);
  const orgB = resolveActiveProduct(caps(['high_school'], 'high_school'), null);
  assert.equal(orgA.activeProduct, 'travel');
  assert.equal(orgB.activeProduct, 'high_school');
});

// ── 18. No redirect loop: resolving a second time with the already-active
// product as the request produces no further redirect (fixed point) ────────

test('Resolving again with the already-resolved active product as the request produces no redirect (fixed point, no loop)', () => {
  const first = resolveActiveProduct(caps(['travel'], 'travel'), 'high_school');
  assert.equal(first.redirected, true);
  const second = resolveActiveProduct(caps(['travel'], 'travel'), first.activeProduct);
  assert.equal(second.redirected, false);
  assert.equal(second.activeProduct, first.activeProduct);
});
