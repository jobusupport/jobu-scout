'use strict';

// Pure unit tests for src/high-school-import-sanitizer.js -- no database,
// no network, no filesystem. Run with:
//   node --test test/high-school-import-sanitizer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  importError,
  requireEnum,
  optionalEnum,
  requireNonEmptyString,
  requireNonNegativeInteger,
  validateImportContext,
  assertNoCredentialLikeKeys,
  assertJsonSerializable,
  sanitizeErrorMessage,
  isCredentialLikeKey,
  IMPORT_RUN_STATUSES,
  TRIGGER_KINDS,
  SNAPSHOT_KINDS,
} = require('../src/high-school-import-sanitizer');

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const VALID_UUID_2 = '22222222-2222-2222-2222-222222222222';
const VALID_UUID_3 = '33333333-3333-3333-3333-333333333333';

// ── importError shape ─────────────────────────────────────────────────────

test('importError produces a stable, programmatically-usable error shape', () => {
  const err = importError('SOME_CODE', 'a message', { statusCode: 409, retryable: true, context: { field: 'x' } });
  assert.equal(err.code, 'SOME_CODE');
  assert.equal(err.message, 'a message');
  assert.equal(err.statusCode, 409);
  assert.equal(err.retryable, true);
  assert.deepEqual(err.context, { field: 'x' });
});

test('importError defaults statusCode=500 and retryable=false when unspecified', () => {
  const err = importError('X', 'msg');
  assert.equal(err.statusCode, 500);
  assert.equal(err.retryable, false);
});

// ── enum validation (item 3: invalid run status is rejected) ────────────

test('requireEnum accepts every schema-approved IMPORT_RUN_STATUSES value', () => {
  for (const status of IMPORT_RUN_STATUSES) {
    assert.equal(requireEnum(status, IMPORT_RUN_STATUSES, 'status'), status);
  }
});

test('requireEnum rejects a status value not in the schema-approved list', () => {
  assert.throws(() => requireEnum('bogus', IMPORT_RUN_STATUSES, 'status'), (err) => {
    assert.equal(err.code, 'INVALID_ENUM_VALUE');
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('requireEnum rejects an almost-right value (case/whitespace) rather than coercing it', () => {
  assert.throws(() => requireEnum('Running', IMPORT_RUN_STATUSES, 'status'));
  assert.throws(() => requireEnum('running ', IMPORT_RUN_STATUSES, 'status'));
});

test('optionalEnum allows null/undefined but still rejects an invalid supplied value', () => {
  assert.equal(optionalEnum(undefined, TRIGGER_KINDS, 'triggerKind'), null);
  assert.equal(optionalEnum(null, TRIGGER_KINDS, 'triggerKind'), null);
  assert.throws(() => optionalEnum('nope', TRIGGER_KINDS, 'triggerKind'));
});

// ── context validation (item 2: missing tenant/program/team is rejected) ─

test('validateImportContext accepts a fully-scoped valid context', () => {
  const ctx = validateImportContext({ orgId: VALID_UUID, programId: VALID_UUID_2, teamId: VALID_UUID_3, seasonId: null });
  assert.deepEqual(ctx, { orgId: VALID_UUID, programId: VALID_UUID_2, teamId: VALID_UUID_3, seasonId: null });
});

test('validateImportContext rejects a missing orgId', () => {
  assert.throws(() => validateImportContext({ orgId: undefined, programId: VALID_UUID_2, teamId: VALID_UUID_3 }), (err) => {
    assert.equal(err.code, 'INVALID_FIELD');
    assert.match(err.message, /orgId/);
    return true;
  });
});

test('validateImportContext rejects a missing programId', () => {
  assert.throws(() => validateImportContext({ orgId: VALID_UUID, programId: null, teamId: VALID_UUID_3 }), /programId/);
});

test('validateImportContext rejects a missing teamId', () => {
  assert.throws(() => validateImportContext({ orgId: VALID_UUID, programId: VALID_UUID_2, teamId: '' }), /teamId/);
});

test('validateImportContext rejects a non-UUID-shaped id rather than accepting an arbitrary string', () => {
  assert.throws(() => validateImportContext({ orgId: 'the-only-org', programId: VALID_UUID_2, teamId: VALID_UUID_3 }));
});

test('validateImportContext rejects an invalid seasonId when one is supplied, but allows it to be omitted entirely', () => {
  assert.throws(() => validateImportContext({ orgId: VALID_UUID, programId: VALID_UUID_2, teamId: VALID_UUID_3, seasonId: 'not-a-uuid' }));
  assert.equal(validateImportContext({ orgId: VALID_UUID, programId: VALID_UUID_2, teamId: VALID_UUID_3 }).seasonId, null);
});

// ── recursive credential-key rejection (items 10, 11) ────────────────────

test('isCredentialLikeKey recognizes the documented marker fragments regardless of separator style', () => {
  for (const key of ['Authorization', 'auth-token', 'access_token', 'Cookie', 'Set-Cookie', 'apiKey', 'api_key', 'SERVICE_ROLE', 'password', 'secret', 'sessionState', 'storage_state']) {
    assert.equal(isCredentialLikeKey(key), true, `expected ${key} to be flagged`);
  }
});

test('isCredentialLikeKey does not flag ordinary baseball fields', () => {
  for (const key of ['pitch_count', 'inning', 'batter_name', 'jersey_number', 'game_date', 'opponent_name', 'gc_game_id']) {
    assert.equal(isCredentialLikeKey(key), false, `expected ${key} NOT to be flagged`);
  }
});

test('isCredentialLikeKey deliberately flags game_token (unresolved ambiguity, rejected rather than quietly permitted)', () => {
  assert.equal(isCredentialLikeKey('game_token'), true);
});

test('assertNoCredentialLikeKeys passes silently on a clean payload', () => {
  assert.doesNotThrow(() => assertNoCredentialLikeKeys({ batting: [{ player: 'Alice', ab: 3, h: 1 }], plays: [{ text: 'Alice singles' }] }));
});

test('assertNoCredentialLikeKeys rejects a top-level credential-shaped key', () => {
  assert.throws(() => assertNoCredentialLikeKeys({ authorization: 'Bearer xyz' }), (err) => {
    assert.equal(err.code, 'CREDENTIAL_LIKE_KEY_REJECTED');
    return true;
  });
});

test('assertNoCredentialLikeKeys rejects a DEEPLY NESTED credential-shaped key inside arrays and objects', () => {
  const payload = { boxScore: { batting: [{ player: 'Alice', meta: { request: { headers: { cookie: 'sess=abc' } } } }] } };
  assert.throws(() => assertNoCredentialLikeKeys(payload), (err) => {
    assert.equal(err.code, 'CREDENTIAL_LIKE_KEY_REJECTED');
    assert.match(err.context.path, /cookie/);
    return true;
  });
});

test('assertNoCredentialLikeKeys names the offending key PATH but never echoes the secret VALUE in the thrown error', () => {
  const secretValue = 'sk_live_super_secret_value_12345';
  try {
    assertNoCredentialLikeKeys({ nested: { api_key: secretValue } });
    assert.fail('expected assertNoCredentialLikeKeys to throw');
  } catch (err) {
    assert.doesNotMatch(err.message, new RegExp(secretValue));
    assert.doesNotMatch(JSON.stringify(err.context), new RegExp(secretValue));
    assert.match(err.message, /api_key/);
  }
});

test('assertNoCredentialLikeKeys guards against pathological nesting depth', () => {
  let deep = { leaf: true };
  for (let i = 0; i < 40; i++) deep = { child: deep };
  assert.throws(() => assertNoCredentialLikeKeys(deep), (err) => {
    assert.equal(err.code, 'PAYLOAD_TOO_DEEPLY_NESTED');
    return true;
  });
});

test('assertNoCredentialLikeKeys accepts arrays of plain scalars and null/primitive leaves without error', () => {
  assert.doesNotThrow(() => assertNoCredentialLikeKeys({ scores: [1, 2, 3], notes: null, flag: true, label: 'ok' }));
});

// ── JSON-serializability guard ────────────────────────────────────────────

test('assertJsonSerializable rejects undefined and functions', () => {
  assert.throws(() => assertJsonSerializable(undefined, 'payload'), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
  assert.throws(() => assertJsonSerializable(() => {}, 'payload'));
});

test('assertJsonSerializable rejects a circular object rather than crashing on JSON.stringify', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => assertJsonSerializable(circular, 'payload'), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
});

test('assertJsonSerializable accepts plain objects, arrays, numbers, and null', () => {
  assert.doesNotThrow(() => assertJsonSerializable({ a: [1, 2, { b: null }] }, 'payload'));
});

// ── error-message sanitization (reused from high-school-importer-contract.js) ─

test('sanitizeErrorMessage bounds an overlong message to the schema length limit', () => {
  const long = 'x'.repeat(3000);
  const sanitized = sanitizeErrorMessage(long);
  assert.ok(sanitized.length <= 2000);
});

test('sanitizeErrorMessage withholds a message that resembles credential/session data', () => {
  const sanitized = sanitizeErrorMessage('request failed: Authorization: Bearer abc123');
  assert.doesNotMatch(sanitized, /abc123/);
  assert.match(sanitized, /withheld/i);
});

test('sanitizeErrorMessage returns null for an empty/missing message', () => {
  assert.equal(sanitizeErrorMessage(''), null);
  assert.equal(sanitizeErrorMessage(undefined), null);
});

// ── small field helpers ───────────────────────────────────────────────────

test('requireNonEmptyString rejects blank/whitespace-only and non-string values', () => {
  assert.throws(() => requireNonEmptyString('   ', 'field'));
  assert.throws(() => requireNonEmptyString(42, 'field'));
  assert.equal(requireNonEmptyString(' hello ', 'field'), 'hello');
});

test('requireNonNegativeInteger rejects negatives, floats, and non-numbers', () => {
  assert.throws(() => requireNonNegativeInteger(-1, 'count'));
  assert.throws(() => requireNonNegativeInteger(1.5, 'count'));
  assert.throws(() => requireNonNegativeInteger('3', 'count'));
  assert.equal(requireNonNegativeInteger(0, 'count'), 0);
});

test('SNAPSHOT_KINDS is exactly the migration-approved five values (item 12: unsupported snapshot types are rejected)', () => {
  assert.deepEqual(SNAPSHOT_KINDS, ['schedule_discovery', 'game_header', 'box_score', 'play_by_play', 'roster']);
  assert.throws(() => requireEnum('screenshot', SNAPSHOT_KINDS, 'snapshotKind'));
});
