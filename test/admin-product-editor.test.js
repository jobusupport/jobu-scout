'use strict';

// Database-free, DOM-free regression tests for the Phase 2 Slice 3B product
// access editor (admin/index.html). This repo has no jsdom/Playwright-spec
// infrastructure for the admin frontend (confirmed absent during Slice 3A;
// introducing either would itself be new test tooling beyond what this
// slice's own scope allows) -- admin/index.html is a single file with an
// inline, non-module <script>, not something `require()` can import
// directly.
//
// Rather than re-implement the real logic in a separate, parallel copy
// (which risks silent drift from what actually ships), these tests extract
// the REAL inline script text from admin/index.html and execute it via
// Node's built-in `vm` module against a minimal stub DOM -- the exact same
// technique already used to syntax-check this file throughout Slice 3A/3B,
// extended here to actually invoke the real, unmodified functions and
// assert on their real return values. `vm`'s per-context global lexical
// environment persists across multiple runInContext() calls against the
// same context object, which is what lets a short follow-up snippet (e.g.
// `JSON.stringify(validateProductEditForm({...}))`) see and call a
// top-level `function`/`const` declared by the one full script execution
// that happened first, in the same context.
//
// What this genuinely proves: the real pure-logic functions (validation,
// derivation, diffing, request-body shape, response-shape checking,
// confirmation-summary content) behave exactly as specified, executed as
// real code, not a reimplementation.
//
// What this does NOT and cannot prove, and is NOT claimed here: full modal
// keyboard/focus behavior (Tab trap, Escape, focus restoration), real
// click-driven request flow, or visual/CSS overflow behavior -- none of
// which a stub DOM can faithfully reproduce. Those were verified instead
// by exercising the real file live in the Browser pane against mocked
// (never production) data, documented in this session's report with
// concrete results (exact request URL/method/headers/body captured,
// before/after screenshots at 1440/1024/390px, repeated open/close and
// error-path cycles).
//
// Run with: node --test test/admin-product-editor.test.js (also included
// in `npm test`, see package.json).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ADMIN_HTML_PATH = path.join(__dirname, '..', 'admin', 'index.html');

// Minimal stub DOM -- just enough that the real script's top-level code
// (including the boot() IIFE at the very bottom) executes without
// throwing. boot() short-circuits at its very first line when
// localStorage has no session (`if (!session?.accessToken) { ... return; }`),
// so nothing beyond that needs to be real.
function buildSandbox() {
  const elements = new Map();
  function stubElement(id) {
    if (!elements.has(id)) {
      elements.set(id, { id, innerHTML: '', style: {}, children: [], addEventListener() {}, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
    }
    return elements.get(id);
  }
  const documentStub = {
    getElementById: (id) => stubElement(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { addEventListener() {}, appendChild() {}, children: [] },
    createElement: () => ({ style: {}, addEventListener() {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
    addEventListener() {},
  };
  const sandbox = {
    document: documentStub,
    window: null, // set to sandbox itself below
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    history: { pushState() {}, replaceState() {} },
    location: { href: '', pathname: '/admin', search: '' },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('fetch should not be called during script load'); },
    URLSearchParams,
    KeyboardEvent: class {},
    MouseEvent: class {},
    Event: class {},
    HTMLElement: class {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

function extractInlineScript(html) {
  const m = html.match(/<script>\r?\n'use strict';([\s\S]*?)<\/script>/);
  if (!m) throw new Error('inline <script> block not found in admin/index.html');
  return "'use strict';" + m[1];
}

// Loads the REAL admin/index.html script once into a fresh vm context and
// returns a `run(expr)` helper that evaluates a follow-up expression in
// that SAME context (so it can see the script's top-level functions/consts)
// and returns the real JS value (round-tripped through JSON, since values
// cross the vm boundary by reference within the same context but this
// keeps call sites simple and avoids any accidental cross-context proxy
// weirdness).
function loadAdminScript() {
  const html = fs.readFileSync(ADMIN_HTML_PATH, 'utf8');
  const script = extractInlineScript(html);
  const context = buildSandbox();
  vm.runInContext(script, context, { filename: 'admin/index.html (extracted inline script)' });
  return {
    context,
    call(fnName, ...args) {
      const argsJson = JSON.stringify(args);
      const expr = `JSON.stringify((function(){ return ${fnName}.apply(null, ${argsJson}); })())`;
      const resultJson = vm.runInContext(expr, context);
      return JSON.parse(resultJson);
    },
    // Reads a plain top-level const/variable (not a function call) by name.
    get(varName) {
      const resultJson = vm.runInContext(`JSON.stringify(${varName})`, context);
      return JSON.parse(resultJson);
    },
    // Same as call(), but awaits the real function's Promise first --
    // needed for apiFetch, which is declared `async`. The vm-realm Promise
    // returned by the IIFE below is still a standard thenable, so a normal
    // Node-side `await` on it resolves correctly across the context boundary.
    async callAsync(fnName, ...args) {
      const argsJson = JSON.stringify(args);
      const expr = `(async () => { try { const r = await ${fnName}.apply(null, ${argsJson}); return JSON.stringify({ ok: true, value: r }); } catch (err) { return JSON.stringify({ ok: false, message: err && err.message }); } })()`;
      const resultJson = await vm.runInContext(expr, context);
      const parsed = JSON.parse(resultJson);
      if (!parsed.ok) { const e = new Error(parsed.message); e.__vmThrew = true; throw e; }
      return parsed.value;
    },
  };
}

// ── Loaded once, real script, real functions ────────────────────────────────
const admin = loadAdminScript();
const adminContext = admin.context;

// ── deriveEnabledProducts / customerTypeRequiresChoice ──────────────────────

test('deriveEnabledProducts — matches the server exactly for every known customer type', () => {
  assert.deepEqual(admin.call('deriveEnabledProducts', 'travel'), ['travel']);
  assert.deepEqual(admin.call('deriveEnabledProducts', 'high_school'), ['high_school']);
  assert.deepEqual(admin.call('deriveEnabledProducts', 'hybrid'), ['travel', 'high_school']);
  assert.deepEqual(admin.call('deriveEnabledProducts', 'internal'), ['travel', 'high_school']);
});

test('productCustomerTypeRequiresChoice — only hybrid/internal require a primary-product choice', () => {
  assert.equal(admin.call('productCustomerTypeRequiresChoice', 'travel'), false);
  assert.equal(admin.call('productCustomerTypeRequiresChoice', 'high_school'), false);
  assert.equal(admin.call('productCustomerTypeRequiresChoice', 'hybrid'), true);
  assert.equal(admin.call('productCustomerTypeRequiresChoice', 'internal'), true);
});

// ── validateProductEditForm: current-value rendering + prepopulation shape ──
// (test requirements #1/#2: the same function that validates is what
// produces the {customerType, primaryProduct, enabledProducts} shape the
// UI prepopulates and previews from, so correctness here is correctness
// there too.)

test('validateProductEditForm — travel: derives enabledProducts/primaryProduct, valid with a reason', () => {
  const r = admin.call('validateProductEditForm', { customerType: 'travel', primaryProduct: undefined, reason: 'r' });
  assert.equal(r.valid, true);
  assert.equal(r.primaryProduct, 'travel');
  assert.deepEqual(r.enabledProducts, ['travel']);
});

test('validateProductEditForm — hybrid without a primary product is invalid (test req #6/#9: primary must be in enabled)', () => {
  const r = admin.call('validateProductEditForm', { customerType: 'hybrid', primaryProduct: undefined, reason: 'r' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.primaryProduct);
});

test('validateProductEditForm — hybrid with a bogus primary product is invalid', () => {
  const r = admin.call('validateProductEditForm', { customerType: 'hybrid', primaryProduct: 'bogus', reason: 'r' });
  assert.equal(r.valid, false);
});

test('validateProductEditForm — internal requires a real primary-product choice too', () => {
  const invalid = admin.call('validateProductEditForm', { customerType: 'internal', primaryProduct: undefined, reason: 'r' });
  assert.equal(invalid.valid, false);
  const valid = admin.call('validateProductEditForm', { customerType: 'internal', primaryProduct: 'high_school', reason: 'r' });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.enabledProducts, ['travel', 'high_school']);
});

test('validateProductEditForm — every valid combination always has primaryProduct included in enabledProducts (test req #10)', () => {
  const combos = [
    { customerType: 'travel', primaryProduct: undefined },
    { customerType: 'high_school', primaryProduct: undefined },
    { customerType: 'hybrid', primaryProduct: 'travel' },
    { customerType: 'hybrid', primaryProduct: 'high_school' },
    { customerType: 'internal', primaryProduct: 'travel' },
    { customerType: 'internal', primaryProduct: 'high_school' },
  ];
  for (const c of combos) {
    const r = admin.call('validateProductEditForm', { ...c, reason: 'r' });
    assert.equal(r.valid, true, JSON.stringify(c));
    assert.ok(r.enabledProducts.includes(r.primaryProduct), JSON.stringify(c));
  }
});

// ── Reason: blank/whitespace rejection, trimming, boundaries ───────────────
// (test req #7/#8: the real contract has a minimum -- non-blank after trim
// -- and NO maximum anywhere in src/admin-product-route.js or the deployed
// admin_update_org_product SQL function (verified directly against both
// before implementing). This suite tests exactly that real minimum and
// does not assert a fabricated maximum.)

test('validateProductEditForm — a blank reason is rejected', () => {
  const r = admin.call('validateProductEditForm', { customerType: 'travel', reason: '' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.reason);
});

test('validateProductEditForm — a whitespace-only reason is rejected', () => {
  const r = admin.call('validateProductEditForm', { customerType: 'travel', reason: '   \t\n  ' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.reason);
});

test('validateProductEditForm — reason is trimmed in the returned value', () => {
  const r = admin.call('validateProductEditForm', { customerType: 'travel', reason: '  padded reason  ' });
  assert.equal(r.reason, 'padded reason');
});

test('validateProductEditForm — a single non-whitespace character clears the minimum (no fabricated length floor beyond non-blank)', () => {
  const r = admin.call('validateProductEditForm', { customerType: 'travel', reason: 'x' });
  assert.equal(r.valid, true);
});

// ── productFormHasChanges: "nothing changed" disables submission ───────────

test('productFormHasChanges — identical customerType/primaryProduct is not a change', () => {
  const changed = admin.call('productFormHasChanges', { customerType: 'travel', primaryProduct: 'travel' }, { customerType: 'travel', primaryProduct: 'travel' });
  assert.equal(changed, false);
});

test('productFormHasChanges — a different customerType is a change', () => {
  const changed = admin.call('productFormHasChanges', { customerType: 'travel', primaryProduct: 'travel' }, { customerType: 'hybrid', primaryProduct: 'travel' });
  assert.equal(changed, true);
});

test('productFormHasChanges — same customerType but different primaryProduct is a change', () => {
  const changed = admin.call('productFormHasChanges', { customerType: 'hybrid', primaryProduct: 'travel' }, { customerType: 'hybrid', primaryProduct: 'high_school' });
  assert.equal(changed, true);
});

// ── buildProductChangeRequestBody: exact request shape ──────────────────────

test('buildProductChangeRequestBody — exactly the three keys the server accepts, nothing else', () => {
  const body = admin.call('buildProductChangeRequestBody', { customerType: 'hybrid', primaryProduct: 'travel', reason: 'r', enabledProducts: ['travel', 'high_school'], extraJunk: 'nope' });
  assert.deepEqual(Object.keys(body).sort(), ['customerType', 'primaryProduct', 'reason']);
  assert.deepEqual(body, { customerType: 'hybrid', primaryProduct: 'travel', reason: 'r' });
});

// ── buildConfirmationSummary: accurate old/new diff (test req #9) ──────────

test('buildConfirmationSummary — accurately reflects old and new values for every field', () => {
  const org = { name: 'Acme Travel', customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] };
  const next = { customerType: 'hybrid', primaryProduct: 'high_school', enabledProducts: ['travel', 'high_school'], reason: 'upgrading' };
  const summary = admin.call('buildConfirmationSummary', org, next);
  assert.deepEqual(summary, {
    organizationName: 'Acme Travel',
    customerType: { from: 'travel', to: 'hybrid' },
    primaryProduct: { from: 'travel', to: 'high_school' },
    enabledProducts: { from: ['travel'], to: ['travel', 'high_school'] },
    reason: 'upgrading',
  });
});

// ── Error message mapping: sanitized, safe, retryable ───────────────────────

test('describeProductChangeError — a server-provided message (already sanitized server-side) is passed through', () => {
  assert.equal(admin.call('describeProductChangeError', { message: 'customerType must be one of: travel, high_school, hybrid, internal' }), 'customerType must be one of: travel, high_school, hybrid, internal');
});

test('describeProductChangeError — a missing/empty message falls back to a generic safe string', () => {
  assert.equal(admin.call('describeProductChangeError', {}), 'Something went wrong. Please try again.');
  assert.equal(admin.call('describeProductChangeError', null), 'Something went wrong. Please try again.');
});

test('describeProductChangeError — never echoes anything beyond .message (no accidental stack-trace leakage)', () => {
  // A plain object, not `new Error(...)` -- arguments to admin.call() cross
  // into the vm context via JSON.stringify/parse, and Error instances
  // serialize to `{}` (message/stack are non-enumerable own properties),
  // which would make this assert the wrong thing for the wrong reason.
  // describeProductChangeError itself only ever reads a plain `.message`
  // string, so a plain object is the faithful equivalent here.
  const err = { message: 'Failed to fetch', stack: 'Error: Failed to fetch\n    at fakeInternal.js:123:45\n    at SECRET_INTERNAL_PATH' };
  const msg = admin.call('describeProductChangeError', err);
  assert.equal(msg, 'Failed to fetch');
  assert.doesNotMatch(msg, /SECRET_INTERNAL_PATH|fakeInternal/);
});

// ── Response-shape validation: malformed/unexpected responses ──────────────

test('isValidProductChangeResponse — accepts the real, exact server response shape', () => {
  assert.equal(admin.call('isValidProductChangeResponse', { customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] }), true);
});

test('isValidProductChangeResponse — rejects a missing field', () => {
  assert.equal(admin.call('isValidProductChangeResponse', { customerType: 'travel', primaryProduct: 'travel' }), false);
});

test('isValidProductChangeResponse — rejects enabledProducts that is not an array', () => {
  assert.equal(admin.call('isValidProductChangeResponse', { customerType: 'travel', primaryProduct: 'travel', enabledProducts: 'travel' }), false);
});

test('isValidProductChangeResponse — rejects null/undefined outright', () => {
  assert.equal(admin.call('isValidProductChangeResponse', null), false);
  assert.equal(admin.call('isValidProductChangeResponse', undefined), false);
});

// ── Known-value lists: exact match to the server contract ──────────────────
// Directly cross-checked against src/admin-product-route.js's own
// KNOWN_CUSTOMER_TYPES/KNOWN_PRODUCTS/ENABLED_PRODUCTS_BY_CUSTOMER_TYPE --
// this is the one place a future edit to either file, without updating the
// other, would be caught automatically rather than silently drifting,
// instead of only being noticed live against the real server.
test('known-value lists match the deployed server contract exactly', () => {
  const server = require('../src/admin-product-route.js');
  assert.deepEqual(admin.get('PRODUCT_KNOWN_CUSTOMER_TYPES'), server.KNOWN_CUSTOMER_TYPES);
  assert.deepEqual(admin.get('PRODUCT_KNOWN_PRODUCTS'), server.KNOWN_PRODUCTS);
  assert.deepEqual(admin.get('PRODUCT_ENABLED_BY_CUSTOMER_TYPE'), server.ENABLED_PRODUCTS_BY_CUSTOMER_TYPE);
});

// ── esc(): the one place any of this data becomes HTML ──────────────────────
// Every value the product-access/audit UI renders (org name, customer type,
// primary product, enabled products, audit old/new values, admin_email,
// reason) goes through this exact function before reaching innerHTML. If
// this is safe, every call site that uses it is safe by construction.

test('esc — neutralizes an <img onerror> payload', () => {
  const out = admin.call('esc', '<img src=x onerror=alert(1)>');
  assert.equal(out, '&lt;img src=x onerror=alert(1)&gt;');
  assert.doesNotMatch(out, /<img/);
});

test('esc — neutralizes a script-tag-breakout payload', () => {
  const out = admin.call('esc', '</td><script>alert(1)</script>');
  assert.doesNotMatch(out, /<script>|<\/td>/);
  assert.equal(out, '&lt;/td&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('esc — escapes quotes and ampersands (attribute-breakout safe)', () => {
  assert.equal(admin.call('esc', `travel & "friends" 'quoted'`), 'travel &amp; &quot;friends&quot; &#39;quoted&#39;');
});

test('esc — null/undefined become empty string, not the literal word "null"', () => {
  assert.equal(admin.call('esc', null), '');
  assert.equal(admin.call('esc', undefined), '');
});

test('esc — coerces non-string values (numbers, plain objects) to a safely-escaped string instead of throwing', () => {
  assert.equal(admin.call('esc', 5), '5');
  assert.doesNotThrow(() => admin.call('esc', { some: 'object' }));
});

test('esc — a malicious .toString() cannot smuggle raw HTML through the String() coercion inside esc', () => {
  // admin.call()'s JSON-based argument passing can't carry a live object
  // with a custom toString across the vm boundary, so this constructs the
  // hostile value and calls esc() with a single expression evaluated
  // directly inside the SAME persistent context loadAdminScript() already
  // populated -- still the real esc(), not a reimplementation.
  const html = JSON.parse(vm.runInContext(
    `JSON.stringify(esc({ toString() { return '<script>alert(1)</script>'; } }))`,
    adminContext
  ));
  assert.doesNotMatch(html, /<script>/i);
  assert.equal(html, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

// ── renderProductAccessReadout: the read-only card + audit history table ───
// Exercises the REAL rendering function with hostile values in every field
// it touches, including nested audit old_values/new_values, and asserts the
// resulting HTML string is fully inert: no unescaped tag, no event-handler
// attribute construction, and no scriptable element survives.

function assertInertHtml(html, rawPayloads) {
  for (const payload of rawPayloads) {
    assert.equal(html.includes(payload), false, `raw payload leaked unescaped into rendered HTML: ${payload}`);
  }
  // The real safety property: no LIVE tag exists for the browser to parse
  // (an escaped "&lt;img ... onerror=..." is inert text and legitimately
  // contains the literal substring "onerror=" -- that's fine and expected,
  // so this only rules out an actual unescaped, parseable element).
  assert.doesNotMatch(html, /<script[\s>]/i);
  assert.doesNotMatch(html, /<img\s/i);
  assert.doesNotMatch(html, /<svg\s/i);
}

test('renderProductAccessReadout — an XSS payload as customerType/primaryProduct/enabledProducts never reaches the kv grid: isValidProductFields rejects it and the unavailable banner renders instead', () => {
  // Since isValidProductFields gates the kv-grid path on the known-value
  // lists, an injected string in any of these three fields can never be
  // "valid" -- it always falls to the read-only unavailable state instead,
  // which is a stronger guarantee than escaping alone (nothing to escape
  // if the value never reaches that render path at all).
  const org = {
    customerType: '</td><script>alert(1)</script>',
    primaryProduct: `travel & "friends"`,
    enabledProducts: ['<svg onload=alert(2)>', 'high_school'],
  };
  const html = admin.call('renderProductAccessReadout', org, []);
  assertInertHtml(html, [
    '</td><script>alert(1)</script>',
    '<svg onload=alert(2)>',
  ]);
  assert.doesNotMatch(html, /paCustomerType|paPrimaryProduct|paEnabledProducts/);
  assert.match(html, /paUnavailable/);
  assert.doesNotMatch(html, /id="btnEditProduct"/);
});

test('renderProductAccessReadout — audit log admin_email/reason/old_values/new_values XSS payloads render as inert text', () => {
  const org = { name: 'Acme', customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] };
  const auditLog = [{
    created_at: '2026-01-01T00:00:00Z',
    admin_email: '"><script>alert(2)</script>',
    action: 'product_access_changed',
    reason: '<img src=x onerror=alert(3)>',
    old_values: { customerType: '<svg onload=alert(4)>' },
    new_values: { customerType: 'hybrid' },
  }];
  const html = admin.call('renderProductAccessReadout', org, auditLog);
  assertInertHtml(html, [
    '"><script>alert(2)</script>',
    '<img src=x onerror=alert(3)>',
    '<svg onload=alert(4)>',
  ]);
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test('renderProductAccessReadout — malformed old_values/new_values (not objects) do not throw and do not leak raw content', () => {
  const org = { name: 'Acme', customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] };
  const malformed = [
    { created_at: 't', admin_email: 'a@b.com', action: 'product_access_changed', reason: 'r', old_values: '<script>alert(1)</script>', new_values: null },
    { created_at: 't', admin_email: 'a@b.com', action: 'product_access_changed', reason: 'r', old_values: null, new_values: '<script>alert(1)</script>' },
    { created_at: 't', admin_email: 'a@b.com', action: 'product_access_changed', reason: 'r', old_values: 42, new_values: ['array', 'not', 'object'] },
  ];
  for (const entry of malformed) {
    assert.doesNotThrow(() => admin.call('renderProductAccessReadout', org, [entry]));
    const html = admin.call('renderProductAccessReadout', org, [entry]);
    assert.doesNotMatch(html, /<script>/i);
  }
});

test('renderProductAccessReadout — null/undefined-ish org product fields render the unavailable state, never "null"/"undefined" literals or a crash', () => {
  const org = { name: 'Acme', customerType: null, primaryProduct: undefined, enabledProducts: null };
  assert.doesNotThrow(() => admin.call('renderProductAccessReadout', org, []));
  const html = admin.call('renderProductAccessReadout', org, []);
  assert.doesNotMatch(html, /\bnull\b/);
  assert.doesNotMatch(html, /\bundefined\b/);
  assert.match(html, /paUnavailable/);
});

// ── isValidProductFields: the single gate for both display and edit ────────
// Item 3 (Slice 3B corrective pass): defines and tests safe behavior for
// every malformed shape the GET response's product fields could take.
// Nothing here ever guesses/repairs a default -- every case below must
// come back false, never a "best effort" true.

test('isValidProductFields — a normal, fully valid record for every real customer type is valid', () => {
  const cases = [
    { customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] },
    { customerType: 'high_school', primaryProduct: 'high_school', enabledProducts: ['high_school'] },
    { customerType: 'hybrid', primaryProduct: 'travel', enabledProducts: ['travel', 'high_school'] },
    { customerType: 'hybrid', primaryProduct: 'high_school', enabledProducts: ['travel', 'high_school'] },
    { customerType: 'internal', primaryProduct: 'travel', enabledProducts: ['travel', 'high_school'] },
  ];
  for (const org of cases) assert.equal(admin.call('isValidProductFields', org), true, JSON.stringify(org));
});

test('isValidProductFields — unrelated fields from the real GET response shape (id, name, slug, status, plan, ...) never affect validity', () => {
  // The real organization object carries many fields beyond the three
  // product ones -- this asserts isValidProductFields judges only
  // customerType/primaryProduct/enabledProducts, exactly as documented,
  // against a realistically-shaped object rather than an invented one.
  const org = { id: 'c1', name: 'Acme', slug: 'acme', status: 'active', plan: 'organization', customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] };
  assert.equal(admin.call('isValidProductFields', org), true);
});

test('isValidProductFields — null customerType is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: null, primaryProduct: 'travel', enabledProducts: ['travel'] }), false);
});

test('isValidProductFields — an unknown customerType is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'enterprise', primaryProduct: 'travel', enabledProducts: ['travel'] }), false);
});

test('isValidProductFields — null primaryProduct is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'travel', primaryProduct: null, enabledProducts: ['travel'] }), false);
});

test('isValidProductFields — an unknown primaryProduct is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'hybrid', primaryProduct: 'enterprise', enabledProducts: ['travel', 'high_school'] }), false);
});

test('isValidProductFields — null enabledProducts is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'travel', primaryProduct: 'travel', enabledProducts: null }), false);
});

test('isValidProductFields — a non-array enabledProducts is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'travel', primaryProduct: 'travel', enabledProducts: 'travel' }), false);
});

test('isValidProductFields — an empty enabledProducts array is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'travel', primaryProduct: 'travel', enabledProducts: [] }), false);
});

test('isValidProductFields — enabledProducts containing an unexpected/unknown value is invalid', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'hybrid', primaryProduct: 'travel', enabledProducts: ['travel', 'enterprise'] }), false);
  assert.equal(admin.call('isValidProductFields', { customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['<script>alert(1)</script>'] }), false);
});

test('isValidProductFields — primaryProduct absent from enabledProducts is invalid, even if both are individually known values', () => {
  assert.equal(admin.call('isValidProductFields', { customerType: 'hybrid', primaryProduct: 'high_school', enabledProducts: ['travel'] }), false);
});

test('isValidProductFields — null/undefined org itself is invalid', () => {
  assert.equal(admin.call('isValidProductFields', null), false);
  assert.equal(admin.call('isValidProductFields', undefined), false);
});

// ── openProductChangeModal: never opens on invalid product data ────────────
// openProductChangeModal is a DOM closure (not directly callable via the vm
// technique), but its very first line is `if (!isValidProductFields(org)) return;`
// -- read directly in admin/index.html and exercised live in the Browser
// pane (see report): calling it with a locally-inconsistent product state
// (the realistic org shape used below) produces no modal-overlay element
// at all.

// ── renderProductAccessReadout: unavailable state never shows Edit ─────────

test('renderProductAccessReadout — a real GET response shape with a locally-inconsistent product state (primaryProduct not in enabledProducts) renders the unavailable banner, never the kv grid or Edit button', () => {
  // A failed/missing product-fields lookup now fails the whole GET request
  // server-side (src/admin-api.js) rather than returning a 200 with a
  // signal flag -- so the only way isValidProductFields(org) can actually
  // see false on a genuinely-200 response is a logically-inconsistent but
  // structurally well-typed combination like this one (both values are
  // individually known, but primaryProduct isn't a member of
  // enabledProducts), which is exactly what was exercised live against the
  // real page in the Browser pane for this report.
  const org = { name: 'Acme', customerType: 'hybrid', primaryProduct: 'high_school', enabledProducts: ['travel'] };
  const html = admin.call('renderProductAccessReadout', org, []);
  assert.match(html, /paUnavailable/);
  assert.match(html, /Product settings unavailable/);
  assert.doesNotMatch(html, /id="btnEditProduct"/);
  assert.doesNotMatch(html, /id="paCustomerType"/);
});

test('renderProductAccessReadout — a fully valid record still renders the normal editable kv grid and Edit button', () => {
  const org = { name: 'Acme', customerType: 'hybrid', primaryProduct: 'travel', enabledProducts: ['travel', 'high_school'] };
  const html = admin.call('renderProductAccessReadout', org, []);
  assert.doesNotMatch(html, /paUnavailable/);
  assert.match(html, /id="btnEditProduct"/);
  assert.match(html, /id="paCustomerType">hybrid</);
  assert.match(html, /id="paPrimaryProduct">travel</);
  assert.match(html, /id="paEnabledProducts">travel, high_school</);
});

// ── renderProductChangeDiff: the audit table's "Change" cell ───────────────
// Verified against admin_update_org_product()'s ACTUAL deployed definition
// (inspected directly via the Supabase project, not inferred from the PATCH
// response): old_values/new_values are built via jsonb_build_object with
// EXACTLY these camelCase keys --
//   jsonb_build_object('customerType', ..., 'primaryProduct', ...,
//                       'enabledProducts', to_jsonb(...))
// -- so reading old_values.customerType / .primaryProduct / .enabledProducts
// is correct for every row this RPC has ever written or will write (the
// live admin_audit_log table currently has zero product_access_changed
// rows to cross-check against, since this feature isn't merged yet, but
// the function definition itself is authoritative and was read directly).

test('renderProductChangeDiff — a real admin_audit_log row shape (exact keys the RPC writes) displays all three fields', () => {
  const realRow = {
    old_values: { customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'] },
    new_values: { customerType: 'hybrid', primaryProduct: 'travel', enabledProducts: ['travel', 'high_school'] },
  };
  const cell = admin.call('renderProductChangeDiff', realRow);
  assert.match(cell, /Type: travel .*hybrid/);
  assert.match(cell, /Primary: travel .*travel/);
  assert.match(cell, /Enabled: travel .*travel, high_school/);
});

test('renderProductChangeDiff — snake_case keys (not what the RPC writes) are NOT read -- confirms camelCase is the verified authoritative shape, not a guess', () => {
  const snakeCaseRow = {
    old_values: { customer_type: 'travel', primary_product: 'travel', enabled_products: ['travel'] },
    new_values: { customer_type: 'hybrid', primary_product: 'travel', enabled_products: ['travel', 'high_school'] },
  };
  // None of the camelCase keys this function reads are present, so every
  // field is legitimately absent -- '—' for the whole cell, not a crash,
  // and not fabricated content the snake_case values weren't meant to fill.
  assert.equal(admin.call('renderProductChangeDiff', snakeCaseRow), '—');
});

test('renderProductChangeDiff — null old_values/new_values (legacy or unrelated audit action) renders "—" without throwing', () => {
  assert.equal(admin.call('renderProductChangeDiff', { old_values: null, new_values: null }), '—');
  assert.equal(admin.call('renderProductChangeDiff', {}), '—');
  assert.doesNotThrow(() => admin.call('renderProductChangeDiff', { old_values: null, new_values: { customerType: 'travel' } }));
});

test('renderProductChangeDiff — a partially-populated row (only customerType present) still shows that field without crashing on the missing ones', () => {
  const cell = admin.call('renderProductChangeDiff', { old_values: { customerType: 'travel' }, new_values: { customerType: 'hybrid' } });
  assert.match(cell, /Type: travel .*hybrid/);
  assert.doesNotMatch(cell, /Primary:/);
  assert.doesNotMatch(cell, /Enabled:/);
});

test('renderProductChangeDiff — malformed old_values/new_values (non-object) never throw and never leak raw content', () => {
  const malformed = [
    { old_values: '<script>alert(1)</script>', new_values: { customerType: 'travel' } },
    { old_values: 42, new_values: ['array', 'not', 'object'] },
    { old_values: { customerType: 'travel' }, new_values: undefined },
  ];
  for (const entry of malformed) {
    assert.doesNotThrow(() => admin.call('renderProductChangeDiff', entry));
    const cell = admin.call('renderProductChangeDiff', entry);
    assert.doesNotMatch(cell, /<script>/i);
  }
});

test('renderProductChangeDiff — XSS payloads inside old_values/new_values render as inert escaped text', () => {
  const hostileRow = {
    old_values: { customerType: '<svg onload=alert(1)>', primaryProduct: 'travel', enabledProducts: ['travel'] },
    new_values: { customerType: 'hybrid', primaryProduct: '"><script>alert(2)</script>', enabledProducts: ['travel', 'high_school'] },
  };
  const cell = admin.call('renderProductChangeDiff', hostileRow);
  assert.equal(cell.includes('<svg onload=alert(1)>'), false);
  assert.equal(cell.includes('"><script>alert(2)</script>'), false);
  assert.doesNotMatch(cell, /<script[\s>]/i);
  assert.doesNotMatch(cell, /<svg\s/i);
  assert.match(cell, /&lt;svg onload=alert\(1\)&gt;/);
});

test('renderProductChangeDiff — does not surface unrelated keys that might be present on old_values/new_values', () => {
  const rowWithExtraMetadata = {
    old_values: { customerType: 'travel', internalDebugNote: 'SECRET_INTERNAL_DETAIL', service_role_key: 'sk_should_never_appear' },
    new_values: { customerType: 'hybrid' },
  };
  const cell = admin.call('renderProductChangeDiff', rowWithExtraMetadata);
  assert.doesNotMatch(cell, /SECRET_INTERNAL_DETAIL|service_role_key|sk_should_never_appear/);
});

// ── Robustness: deriveEnabledProducts against prototype-chain property names ─
// PRODUCT_ENABLED_BY_CUSTOMER_TYPE is a plain object literal; a naive
// `obj[customerType] || []` lookup resolves inherited Object.prototype
// members (constructor, toString, hasOwnProperty, __proto__) to a function,
// not an array, for those exact strings -- which every caller then calls
// .join() on and crashes. deriveEnabledProducts must gate on the known-value
// list first so any such input safely falls back to [].

test('deriveEnabledProducts — prototype-chain property names never resolve to a non-array', () => {
  for (const hostileName of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const result = admin.call('deriveEnabledProducts', hostileName);
    assert.ok(Array.isArray(result), `deriveEnabledProducts(${JSON.stringify(hostileName)}) should return an array, got ${JSON.stringify(result)}`);
    assert.deepEqual(result, []);
  }
});

// ── Robustness: buildConfirmationSummary against a malformed enabledProducts ─

test('buildConfirmationSummary — a non-array org.enabledProducts (malformed server data) does not throw and normalizes to []', () => {
  const org = { name: 'Acme', customerType: 'travel', primaryProduct: 'travel', enabledProducts: 'not-an-array' };
  const next = { customerType: 'hybrid', primaryProduct: 'travel', enabledProducts: ['travel', 'high_school'], reason: 'r' };
  assert.doesNotThrow(() => admin.call('buildConfirmationSummary', org, next));
  const summary = admin.call('buildConfirmationSummary', org, next);
  assert.deepEqual(summary.enabledProducts.from, []);
});

test('buildConfirmationSummary — a null org.enabledProducts does not throw and normalizes to []', () => {
  const org = { name: 'Acme', customerType: 'travel', primaryProduct: 'travel', enabledProducts: null };
  const next = { customerType: 'travel', primaryProduct: 'travel', enabledProducts: ['travel'], reason: 'r' };
  const summary = admin.call('buildConfirmationSummary', org, next);
  assert.deepEqual(summary.enabledProducts.from, []);
});

// ── enabledProducts is never client-submitted (test req: PATCH body shape) ──

test('buildProductChangeRequestBody — an enabledProducts property on the input can never enter the PATCH body, even a hostile/spoofed one', () => {
  const body = admin.call('buildProductChangeRequestBody', {
    customerType: 'travel', primaryProduct: 'travel', reason: 'r',
    enabledProducts: ['travel', 'high_school', 'internal', 'admin_bypass'],
  });
  assert.equal('enabledProducts' in body, false);
  assert.deepEqual(Object.keys(body).sort(), ['customerType', 'primaryProduct', 'reason']);
});

// ── apiFetch: the shared request helper the PATCH call goes through ────────
// openProductChangeModal's confirm handler calls apiFetch(...) directly
// (see admin/index.html, `showConfirmPhase`'s #pcConfirm handler) -- the
// exact same helper every other admin-page request already uses, not an
// independent fetch. These tests exercise the real apiFetch function
// (top-level, callable via the vm technique above) directly: its auth
// header attachment, its 401 handling, and its sanitized error extraction.
// The literal PATCH call site's URL/method/body were additionally captured
// live against the real file in the Browser pane (see report) since
// showConfirmPhase itself is a DOM closure this stub-DOM harness can't
// drive.

function setFakeSession(accessToken) {
  adminContext.localStorage.getItem = () => (accessToken ? JSON.stringify({ accessToken, user: { id: 'u1' } }) : null);
}

test('apiFetch — attaches Authorization: Bearer <token> and Content-Type: application/json from the stored session', async () => {
  setFakeSession('secret-token-abc');
  let captured = null;
  adminContext.fetch = async (url, opts) => {
    captured = { url, opts };
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };
  await admin.callAsync('apiFetch', '/api/admin/customers/c2/product', { method: 'PATCH', body: JSON.stringify({ customerType: 'travel', primaryProduct: 'travel', reason: 'r' }) });
  assert.equal(captured.url, '/api/admin/customers/c2/product');
  assert.equal(captured.opts.method, 'PATCH');
  assert.equal(captured.opts.headers['Content-Type'], 'application/json');
  assert.equal(captured.opts.headers['Authorization'], 'Bearer secret-token-abc');
  assert.equal(captured.opts.body, JSON.stringify({ customerType: 'travel', primaryProduct: 'travel', reason: 'r' }));
});

test('apiFetch — no session, no Authorization header is sent (never a blank/forged token)', async () => {
  setFakeSession(null);
  let captured = null;
  adminContext.fetch = async (url, opts) => { captured = { url, opts }; return { status: 200, ok: true, json: async () => ({}) }; };
  await admin.callAsync('apiFetch', '/api/admin/customers/c2/product', { method: 'PATCH', body: '{}' });
  assert.equal('Authorization' in captured.opts.headers, false);
});

test('apiFetch — a 401 response redirects to "/" and throws, never returning response data to the caller', async () => {
  setFakeSession('secret-token-abc');
  adminContext.location.href = '';
  adminContext.fetch = async () => ({ status: 401, ok: false, json: async () => ({ error: 'jwt expired' }) });
  await assert.rejects(() => admin.callAsync('apiFetch', '/api/admin/customers/c2/product', { method: 'PATCH', body: '{}' }));
  assert.equal(adminContext.location.href, '/');
});

test('apiFetch — a non-2xx response with a JSON {error} body surfaces exactly that sanitized message, nothing else', async () => {
  setFakeSession('secret-token-abc');
  adminContext.fetch = async () => ({ status: 400, ok: false, json: async () => ({ error: 'customerType must be one of: travel, high_school, hybrid, internal' }) });
  await assert.rejects(
    () => admin.callAsync('apiFetch', '/api/admin/customers/c2/product', { method: 'PATCH', body: '{}' }),
    (err) => { assert.equal(err.message, 'customerType must be one of: travel, high_school, hybrid, internal'); return true; },
  );
});

test('apiFetch — a non-2xx response with no parseable JSON body falls back to a generic status message (no stack trace/HTML leaked)', async () => {
  setFakeSession('secret-token-abc');
  adminContext.fetch = async () => ({ status: 500, ok: false, json: async () => { throw new Error('Unexpected token < in JSON'); } });
  await assert.rejects(
    () => admin.callAsync('apiFetch', '/api/admin/customers/c2/product', { method: 'PATCH', body: '{}' }),
    (err) => { assert.equal(err.message, 'Request failed (500)'); return true; },
  );
});

test('apiFetch — a rejected fetch (network failure) propagates as a plain Error, not swallowed or misrepresented', async () => {
  setFakeSession('secret-token-abc');
  adminContext.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    () => admin.callAsync('apiFetch', '/api/admin/customers/c2/product', { method: 'PATCH', body: '{}' }),
    (err) => { assert.equal(err.message, 'Failed to fetch'); return true; },
  );
});

test('apiFetch — request opts never carry a CSRF token or credentials field of any kind (Bearer-header auth needs none, and none exists to bypass)', async () => {
  setFakeSession('secret-token-abc');
  let captured = null;
  adminContext.fetch = async (url, opts) => { captured = { url, opts }; return { status: 200, ok: true, json: async () => ({}) }; };
  await admin.callAsync('apiFetch', '/api/admin/customers/c2/product', { method: 'PATCH', body: '{}' });
  assert.deepEqual(Object.keys(captured.opts).sort(), ['body', 'headers', 'method']);
  assert.deepEqual(Object.keys(captured.opts.headers).sort(), ['Authorization', 'Content-Type']);
});

// ── Customer-detail request failure rendering (final corrective pass) ──────
// router() previously did `return renderCustomerDetail(...)` inside its own
// try/catch without awaiting it -- an async rejection from
// renderCustomerDetail's internal `await apiFetch(...)` therefore bypassed
// that catch entirely (a `return somePromise` only hands back a pending
// promise synchronously; the promise's later rejection happens outside the
// try block's execution window), leaving the page stuck on
// "Loading customer…" forever. Confirmed live against the real file before
// this fix (screenshot evidence in the report) and fixed two ways:
// router() now `await`s the call so its existing catch is a real safety
// net, AND renderCustomerDetail now catches apiFetch's rejection itself so
// it can render an org-specific error state with a Retry action (the
// router-level catch has no orgId to retry with).
//
// describeCustomerLoadError/renderCustomerDetailError are pure top-level
// functions (real code, callable via the vm technique above) covering the
// message-safety and HTML-shape side of this fix directly. The click-driven
// side (Retry re-running the same request, one request per click, the page
// actually leaving the loading state, a successful retry rendering the
// customer, navigation still working afterward) needs real DOM interaction
// this stub-DOM harness can't faithfully provide -- verified instead live
// in the Browser pane against the real file with mocked (never production)
// responses, with a request counter instrumented on window.fetch;
// concrete results (screenshots, exact call counts) are in the report.

test('describeCustomerLoadError — a server-provided message (already sanitized server-side by apiFetch) is passed through', () => {
  assert.equal(admin.call('describeCustomerLoadError', { message: 'Unable to load this customer. Please try again.' }), 'Unable to load this customer. Please try again.');
});

test('describeCustomerLoadError — a network-failure message (browser-generated, e.g. "Failed to fetch") is passed through', () => {
  assert.equal(admin.call('describeCustomerLoadError', { message: 'Failed to fetch' }), 'Failed to fetch');
});

test('describeCustomerLoadError — a missing/empty message falls back to a generic safe string', () => {
  assert.equal(admin.call('describeCustomerLoadError', {}), 'Something went wrong loading this customer. Please try again.');
  assert.equal(admin.call('describeCustomerLoadError', null), 'Something went wrong loading this customer. Please try again.');
});

test('describeCustomerLoadError — never echoes anything beyond .message (no accidental stack-trace leakage)', () => {
  const err = { message: 'Request failed (500)', stack: 'Error: Request failed (500)\n    at fakeInternal.js:99:1\n    at SECRET_INTERNAL_PATH' };
  const msg = admin.call('describeCustomerLoadError', err);
  assert.equal(msg, 'Request failed (500)');
  assert.doesNotMatch(msg, /SECRET_INTERNAL_PATH|fakeInternal/);
});

test('renderCustomerDetailError — a 500 response error renders the sanitized message and a Retry button, leaving no loading indicator markup', () => {
  const html = admin.call('renderCustomerDetailError', { message: 'Unable to load this customer. Please try again.' });
  assert.match(html, /Unable to load this customer\. Please try again\./);
  assert.match(html, /id="btnRetryCustomerDetail"/);
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, /Loading customer/);
});

test('renderCustomerDetailError — a network-rejection error (e.g. TypeError "Failed to fetch") renders that message and a Retry button', () => {
  const html = admin.call('renderCustomerDetailError', { message: 'Failed to fetch' });
  assert.match(html, /Failed to fetch/);
  assert.match(html, /id="btnRetryCustomerDetail"/);
});

test('renderCustomerDetailError — a malformed-JSON-response error (apiFetch\'s own generic fallback) renders the generic message and a Retry button', () => {
  const html = admin.call('renderCustomerDetailError', { message: 'Request failed (500)' });
  assert.match(html, /Request failed \(500\)/);
  assert.match(html, /id="btnRetryCustomerDetail"/);
});

test('renderCustomerDetailError — a missing/empty error message still renders the generic fallback and a Retry button (never blank)', () => {
  const html = admin.call('renderCustomerDetailError', {});
  assert.match(html, /Something went wrong loading this customer/);
  assert.match(html, /id="btnRetryCustomerDetail"/);
});

test('renderCustomerDetailError — hostile error content cannot create HTML elements or event-handler attributes', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '</div><script>alert(1)</script>',
    '"><svg onload=alert(2)>',
  ];
  for (const payload of payloads) {
    const html = admin.call('renderCustomerDetailError', { message: payload });
    assert.equal(html.includes(payload), false, `raw payload leaked unescaped: ${payload}`);
    assert.doesNotMatch(html, /<script[\s>]/i);
    assert.doesNotMatch(html, /<img\s/i);
    assert.doesNotMatch(html, /<svg\s/i);
  }
});
