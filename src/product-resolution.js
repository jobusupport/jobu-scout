'use strict';

// Canonical, server-authoritative active-product resolution for the
// Jobu Scout Travel / Jobu Scout High School product split.
//
// This is the SINGLE place that decides, given an organization's
// already-resolved capabilities (src/product-capabilities.js's
// getOrganizationCapabilities output -- { enabledProducts, primaryProduct,
// ... }) and a requested product (typically parsed from a URL path, NEVER
// itself an entitlement grant), what the effective active product is and
// whether a redirect is required.
//
// Deliberately decoupled from Express and from
// src/product-capabilities.js's I/O: it operates purely on the
// capabilities shape, so it is unit-testable without a database and
// reusable identically by page routing, navigation rendering, and any
// future API authorization -- one algorithm, not a fourth hand-rolled
// copy alongside the three enabledProducts-derivation copies already
// documented in src/admin-product-route.js, the
// admin_update_org_product Postgres function, and admin/index.html.
//
// Fails closed exactly like src/product-capabilities.js's
// sanitizeOrganizationRow: malformed or missing capabilities resolve to
// Travel-only, never to "allow everything." A requested product that
// isn't in the sanitized enabledProducts list can only ever narrow the
// result (fall back to primaryProduct) -- there is no code path here that
// adds a product to what the server already granted.
//
// customer_type ('travel' | 'high_school' | 'hybrid' | 'internal') is
// intentionally NOT read by this module at all. Per the product-split
// design, hybrid and internal are account classifications that resolve
// into an allowed-product SET (via enabledProducts/primaryProduct, which
// product-capabilities.js already derives correctly for every customer
// type) -- they are not separate customer-facing product shells. This
// module only ever resolves to one of the two real, customer-facing
// products below.

const PRODUCTS = Object.freeze({
  travel: Object.freeze({
    key: 'travel',
    routeKey: 'travel',
    path: '/travel',
    label: 'Jobu Scout Travel',
  }),
  high_school: Object.freeze({
    key: 'high_school',
    routeKey: 'high-school',
    path: '/high-school',
    label: 'Jobu Scout High School',
  }),
});

const PRODUCT_KEYS = Object.freeze(Object.keys(PRODUCTS)); // ['travel', 'high_school']
const DEFAULT_PRODUCT = 'travel';

function isKnownProduct(product) {
  return PRODUCT_KEYS.includes(product);
}

// Inverse of PRODUCTS[key].routeKey -- maps a URL path segment
// ('travel' | 'high-school') back to its product key. Centralized here so
// no route or navigation code hand-rolls its own path<->product mapping.
// Returns null for anything unrecognized (an unknown product identifier
// must fail safely, not throw or guess).
function productForRouteKey(routeKey) {
  return PRODUCT_KEYS.find((key) => PRODUCTS[key].routeKey === routeKey) || null;
}

// Sanitizes a capabilities object (or anything missing/malformed) down to
// a safe { enabledProducts, primaryProduct } pair. This function has no
// access to a request, cookies, query params, or localStorage -- there is
// nothing client-controlled here to expand entitlements with. It only
// ever narrows toward Travel-only, mirroring
// product-capabilities.js's sanitizeOrganizationRow fail-closed direction.
function safeEntitlements(capabilities) {
  const enabledProducts = Array.isArray(capabilities?.enabledProducts)
    ? capabilities.enabledProducts.filter(isKnownProduct)
    : [];

  if (enabledProducts.length === 0) {
    return { enabledProducts: [DEFAULT_PRODUCT], primaryProduct: DEFAULT_PRODUCT };
  }

  const primaryProduct =
    isKnownProduct(capabilities.primaryProduct) && enabledProducts.includes(capabilities.primaryProduct)
      ? capabilities.primaryProduct
      : enabledProducts[0];

  return { enabledProducts, primaryProduct };
}

// The canonical resolution function.
//
// `requestedProduct` is whatever the caller is ASKING for (e.g. parsed
// from a URL path via productForRouteKey) -- it is a request to validate
// against entitlements, never a source of entitlement itself. Omit it (or
// pass null/undefined) to resolve the default landing product.
//
// Returns:
//   {
//     activeProduct,    // the product that should actually render
//     enabledProducts,  // sanitized entitlement list (defensive copy)
//     primaryProduct,   // sanitized primary product
//     showSwitcher,     // true only when entitled to more than one product
//     redirected,       // true when activeProduct differs from what was requested
//   }
function resolveActiveProduct(capabilities, requestedProduct) {
  const { enabledProducts, primaryProduct } = safeEntitlements(capabilities);

  const activeProduct =
    requestedProduct && isKnownProduct(requestedProduct) && enabledProducts.includes(requestedProduct)
      ? requestedProduct
      : primaryProduct;

  return {
    activeProduct,
    enabledProducts,
    primaryProduct,
    showSwitcher: enabledProducts.length > 1,
    redirected: activeProduct !== requestedProduct,
  };
}

module.exports = {
  PRODUCTS,
  PRODUCT_KEYS,
  DEFAULT_PRODUCT,
  isKnownProduct,
  productForRouteKey,
  safeEntitlements,
  resolveActiveProduct,
};
