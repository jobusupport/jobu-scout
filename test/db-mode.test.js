'use strict';

// Security Slice T3F: src/db-mode.js#resolveDatabaseMode() is the single
// authoritative decision of which repository (Supabase vs. local SQLite) a
// process may use. Before this slice, src/db.js and server.js each
// independently computed this from USE_SUPABASE/SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY, and both formulas resolved to SQLite whenever
// USE_SUPABASE was missing, blank, or malformed -- including in
// production, where every SQLite query has no org_id column to filter on
// at all. These tests exercise the real resolver directly, with `env`
// injected (never mutating real process.env), covering the full matrix
// required by the T3F security contract.
//
// Run with: node --test test/db-mode.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDatabaseMode,
  parseUseSupabaseFlag,
  isProductionEnv,
  DatabaseModeConfigError,
} = require('../src/db-mode');

const FAKE_URL = 'https://example.invalid';
const FAKE_ANON_KEY = 'synthetic-anon-key-not-real';
const FAKE_SERVICE_KEY = 'synthetic-service-role-key-not-real';

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    USE_SUPABASE: 'true',
    SUPABASE_URL: FAKE_URL,
    SUPABASE_ANON_KEY: FAKE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY,
    ...overrides,
  };
}

// ── 1. Production with explicit valid Supabase mode resolves to Supabase ───

test('production with USE_SUPABASE=true and complete Supabase config resolves to supabase', () => {
  assert.equal(resolveDatabaseMode(productionEnv()), 'supabase');
});

test('production accepts USE_SUPABASE in any case/whitespace variant that trims to "true"', () => {
  for (const raw of ['true', 'TRUE', 'True', '  true  ', '\ttrue\n']) {
    assert.equal(resolveDatabaseMode(productionEnv({ USE_SUPABASE: raw })), 'supabase', `raw=${JSON.stringify(raw)}`);
  }
});

// ── 2/3. Production with USE_SUPABASE missing/blank fails closed ───────────

test('production with USE_SUPABASE missing (key absent) fails closed', () => {
  const env = productionEnv();
  delete env.USE_SUPABASE;
  assert.throws(() => resolveDatabaseMode(env), DatabaseModeConfigError);
});

test('production with USE_SUPABASE blank/whitespace-only fails closed', () => {
  for (const raw of ['', '   ', '\t\n']) {
    assert.throws(() => resolveDatabaseMode(productionEnv({ USE_SUPABASE: raw })), DatabaseModeConfigError, `raw=${JSON.stringify(raw)}`);
  }
});

// ── 4. Production with explicit false-like SQLite selection fails closed ───

test('production with USE_SUPABASE=false fails closed rather than selecting SQLite', () => {
  assert.throws(() => resolveDatabaseMode(productionEnv({ USE_SUPABASE: 'false' })), DatabaseModeConfigError);
});

test('production with USE_SUPABASE=FALSE (any case/whitespace) fails closed', () => {
  for (const raw of ['FALSE', 'False', '  false  ']) {
    assert.throws(() => resolveDatabaseMode(productionEnv({ USE_SUPABASE: raw })), DatabaseModeConfigError, `raw=${JSON.stringify(raw)}`);
  }
});

// ── 5. Production with malformed/unrecognized mode fails closed ────────────

test('production with an unrecognized USE_SUPABASE value fails closed', () => {
  for (const raw of ['ture', 'yes', 'no', 'TRUE1', ' true false ', 'null', 'undefined']) {
    assert.throws(() => resolveDatabaseMode(productionEnv({ USE_SUPABASE: raw })), DatabaseModeConfigError, `raw=${JSON.stringify(raw)}`);
  }
});

// ── 6/7. Production with required Supabase config missing fails closed ─────

test('production with SUPABASE_URL missing fails closed even though USE_SUPABASE=true', () => {
  const env = productionEnv();
  delete env.SUPABASE_URL;
  assert.throws(() => resolveDatabaseMode(env), DatabaseModeConfigError);
});

test('production with SUPABASE_SERVICE_ROLE_KEY missing fails closed even though USE_SUPABASE=true', () => {
  const env = productionEnv();
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  assert.throws(() => resolveDatabaseMode(env), DatabaseModeConfigError);
});

test('production with SUPABASE_ANON_KEY missing fails closed even though USE_SUPABASE=true', () => {
  const env = productionEnv();
  delete env.SUPABASE_ANON_KEY;
  assert.throws(() => resolveDatabaseMode(env), DatabaseModeConfigError);
});

test('production with a blank (whitespace-only) SUPABASE_URL fails closed, not merely a missing key', () => {
  assert.throws(() => resolveDatabaseMode(productionEnv({ SUPABASE_URL: '   ' })), DatabaseModeConfigError);
});

test('production reports every missing Supabase config category, not just the first', () => {
  const env = productionEnv();
  delete env.SUPABASE_URL;
  delete env.SUPABASE_ANON_KEY;
  try {
    resolveDatabaseMode(env);
    assert.fail('expected resolveDatabaseMode to throw');
  } catch (err) {
    assert.match(err.message, /SUPABASE_URL/);
    assert.match(err.message, /SUPABASE_ANON_KEY/);
  }
});

// ── 8. Errors do not include the supplied secret value ─────────────────────

test('the error for an unrecognized USE_SUPABASE value never echoes the supplied value', () => {
  const secretLookingValue = 'sb_super_secret_token_abc123XYZ';
  try {
    resolveDatabaseMode(productionEnv({ USE_SUPABASE: secretLookingValue }));
    assert.fail('expected resolveDatabaseMode to throw');
  } catch (err) {
    assert.doesNotMatch(err.message, /sb_super_secret_token_abc123XYZ/);
  }
});

test('the error for missing Supabase config never echoes any configured secret value', () => {
  const env = productionEnv({
    SUPABASE_SERVICE_ROLE_KEY: 'REAL_LOOKING_SECRET_service_role_key_value',
  });
  delete env.SUPABASE_URL;
  try {
    resolveDatabaseMode(env);
    assert.fail('expected resolveDatabaseMode to throw');
  } catch (err) {
    assert.doesNotMatch(err.message, /REAL_LOOKING_SECRET_service_role_key_value/);
  }
});

test('DatabaseModeConfigError instances never carry the raw env object or any secret property', () => {
  try {
    resolveDatabaseMode(productionEnv({ USE_SUPABASE: 'maybe' }));
    assert.fail('expected resolveDatabaseMode to throw');
  } catch (err) {
    assert.ok(err instanceof DatabaseModeConfigError);
    const serialized = JSON.stringify(Object.assign({}, err, { message: err.message, stack: undefined }));
    assert.doesNotMatch(serialized, new RegExp(FAKE_SERVICE_KEY));
  }
});

// ── 9/10. Local development ─────────────────────────────────────────────────

test('local development with explicit USE_SUPABASE=true resolves to supabase', () => {
  const env = { NODE_ENV: 'development', USE_SUPABASE: 'true', SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY };
  assert.equal(resolveDatabaseMode(env), 'supabase');
});

test('local development with explicit USE_SUPABASE=false resolves to sqlite', () => {
  assert.equal(resolveDatabaseMode({ NODE_ENV: 'development', USE_SUPABASE: 'false' }), 'sqlite');
});

test('local development (NODE_ENV unset) with no USE_SUPABASE at all resolves to sqlite -- the pre-existing default, unchanged', () => {
  assert.equal(resolveDatabaseMode({}), 'sqlite');
});

// ── 11. Test mode uses only the deliberately supported test behavior ───────

test('NODE_ENV=test with no USE_SUPABASE resolves to sqlite, same as local development (never treated as production)', () => {
  assert.equal(resolveDatabaseMode({ NODE_ENV: 'test' }), 'sqlite');
});

test('NODE_ENV=test with explicit USE_SUPABASE=true resolves to supabase (deliberate opt-in only)', () => {
  const env = { NODE_ENV: 'test', USE_SUPABASE: 'true', SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY };
  assert.equal(resolveDatabaseMode(env), 'supabase');
});

// ── 12. "false" is parsed as false, not JavaScript truthiness ──────────────

test('parseUseSupabaseFlag("false") is the boolean false, not a truthy nonempty string', () => {
  const result = parseUseSupabaseFlag('false');
  assert.equal(result.present, true);
  assert.equal(result.value, false);
  assert.notEqual(result.value, true);
});

test('a non-production resolution honors an explicit "false" as sqlite, proving it is not coerced truthy', () => {
  assert.equal(resolveDatabaseMode({ NODE_ENV: 'development', USE_SUPABASE: 'false' }), 'sqlite');
});

// ── 13. Case and whitespace behavior is defined and tested ─────────────────

test('parseUseSupabaseFlag trims surrounding whitespace and lowercases before comparing', () => {
  assert.deepEqual(parseUseSupabaseFlag('  TrUe  '), { present: true, value: true });
  assert.deepEqual(parseUseSupabaseFlag('  FaLsE  '), { present: true, value: false });
});

test('parseUseSupabaseFlag treats undefined, null, and "" identically as absent', () => {
  assert.deepEqual(parseUseSupabaseFlag(undefined), { present: false, value: undefined });
  assert.deepEqual(parseUseSupabaseFlag(null), { present: false, value: undefined });
  assert.deepEqual(parseUseSupabaseFlag(''), { present: false, value: undefined });
  assert.deepEqual(parseUseSupabaseFlag('   '), { present: false, value: undefined });
});

// ── 14. Edge values cannot broaden access accidentally ──────────────────────

test('production: "0", "1", "no", "off", "on", "yes" are all malformed, never interpreted as a boolean', () => {
  for (const raw of ['0', '1', 'no', 'off', 'on', 'yes']) {
    assert.throws(() => resolveDatabaseMode(productionEnv({ USE_SUPABASE: raw })), DatabaseModeConfigError, `raw=${JSON.stringify(raw)}`);
  }
});

test('non-production: "0", "1", "no", "off", "on", "yes" are also malformed -- unrecognized values fail validation everywhere, not just in production', () => {
  for (const raw of ['0', '1', 'no', 'off', 'on', 'yes']) {
    assert.throws(() => resolveDatabaseMode({ NODE_ENV: 'development', USE_SUPABASE: raw }), DatabaseModeConfigError, `raw=${JSON.stringify(raw)}`);
  }
});

test('an arbitrary string value can never silently broaden a production resolution into supabase or sqlite', () => {
  assert.throws(() => resolveDatabaseMode(productionEnv({ USE_SUPABASE: 'please-use-supabase' })), DatabaseModeConfigError);
});

// ── isProductionEnv ──────────────────────────────────────────────────────────

test('isProductionEnv is true only for the exact (trimmed, case-insensitive) string "production"', () => {
  assert.equal(isProductionEnv({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEnv({ NODE_ENV: 'PRODUCTION' }), true);
  assert.equal(isProductionEnv({ NODE_ENV: '  production  ' }), true);
  assert.equal(isProductionEnv({ NODE_ENV: 'production-like' }), false);
  assert.equal(isProductionEnv({ NODE_ENV: 'development' }), false);
  assert.equal(isProductionEnv({ NODE_ENV: 'test' }), false);
  assert.equal(isProductionEnv({}), false);
});

// ── 19/20 regression: mode resolution never implies a query-level change ───

test('resolveDatabaseMode never returns any value other than the literal strings "supabase" or "sqlite"', () => {
  const cases = [
    productionEnv(),
    { NODE_ENV: 'development' },
    { NODE_ENV: 'test' },
    { NODE_ENV: 'development', USE_SUPABASE: 'true', SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY },
  ];
  for (const env of cases) {
    const mode = resolveDatabaseMode(env);
    assert.ok(mode === 'supabase' || mode === 'sqlite', `unexpected mode: ${mode}`);
  }
});
