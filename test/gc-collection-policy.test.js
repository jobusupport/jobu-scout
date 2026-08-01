'use strict';

// Database-free unit tests for src/gc-collection-policy.js -- the
// centralized kill-switch/concurrency/backoff boundary the licensed
// GameChanger ingestion adapter (src/high-school-gc-import.js) and its
// HTTP routes (src/high-school-import-routes.js) both read from
// exclusively. Every test resets and restores the relevant env vars so
// this file never leaks state into any other test file's process.env.

const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) original[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

// Re-require fresh each call so env-var reads aren't cached across tests --
// the module itself reads process.env live on every function call (no
// module-load-time caching), so a plain require() is fine, but isolating
// it here documents that assumption explicitly.
function loadPolicy() {
  delete require.cache[require.resolve('../src/gc-collection-policy')];
  return require('../src/gc-collection-policy');
}

test('isCollectionEnabled defaults to true (collection is the primary ingestion method per product decision)', () => {
  withEnv({ GC_COLLECTION_ENABLED: undefined }, () => {
    delete process.env.GC_COLLECTION_ENABLED;
    assert.equal(loadPolicy().isCollectionEnabled(), true);
  });
});

test('isCollectionEnabled respects the kill switch when explicitly disabled', () => {
  withEnv({ GC_COLLECTION_ENABLED: 'false' }, () => {
    assert.equal(loadPolicy().isCollectionEnabled(), false);
  });
});

test('isCollectionEnabled is re-read live, not cached at module load -- flipping the env var mid-process changes the result immediately', () => {
  const policy = loadPolicy();
  withEnv({ GC_COLLECTION_ENABLED: 'true' }, () => {
    assert.equal(policy.isCollectionEnabled(), true);
  });
  withEnv({ GC_COLLECTION_ENABLED: 'false' }, () => {
    assert.equal(policy.isCollectionEnabled(), false);
  });
});

test('every numeric policy knob has a conservative, non-zero-by-accident default', () => {
  withEnv({
    GC_MAX_CONCURRENT_IMPORT_JOBS: undefined,
    GC_MIN_REQUEST_DELAY_MS: undefined,
    GC_RETRY_CEILING: undefined,
    GC_MAX_GAMES_PER_RUN: undefined,
  }, () => {
    for (const key of ['GC_MAX_CONCURRENT_IMPORT_JOBS', 'GC_MIN_REQUEST_DELAY_MS', 'GC_RETRY_CEILING', 'GC_MAX_GAMES_PER_RUN']) delete process.env[key];
    const policy = loadPolicy();
    assert.equal(policy.getMaxConcurrentImportJobs(), 1);
    assert.ok(policy.getMinRequestDelayMs() >= 1000, 'default request delay should be at least 1s, matching the license\'s "do not degrade performance" requirement');
    assert.ok(policy.getRetryCeiling() >= 1 && policy.getRetryCeiling() <= 5);
    assert.ok(policy.getMaxGamesPerRun() > 0 && policy.getMaxGamesPerRun() <= 200);
  });
});

test('numeric knobs are overridable via env, and an invalid value falls back to the default rather than NaN/negative', () => {
  const policy = loadPolicy();
  withEnv({ GC_RETRY_CEILING: '7' }, () => assert.equal(policy.getRetryCeiling(), 7));
  withEnv({ GC_RETRY_CEILING: 'not-a-number' }, () => assert.equal(policy.getRetryCeiling(), 3));
  withEnv({ GC_RETRY_CEILING: '-5' }, () => assert.equal(policy.getRetryCeiling(), 3));
});

test('computeBackoffDelayMs grows exponentially, is capped, and adds bounded jitter -- never used to retry FASTER', () => {
  const policy = loadPolicy();
  const fixedRandom = () => 0; // zero jitter for a deterministic assertion
  const d1 = policy.computeBackoffDelayMs(1, { random: fixedRandom });
  const d2 = policy.computeBackoffDelayMs(2, { random: fixedRandom });
  const d3 = policy.computeBackoffDelayMs(3, { random: fixedRandom });
  assert.ok(d2 > d1, 'attempt 2 must wait longer than attempt 1');
  assert.ok(d3 >= d2, 'attempt 3 must never wait less than attempt 2');
  assert.ok(d3 <= policy.getBackoffMaxMs() + policy.getBackoffJitterMs(), 'delay must respect the configured ceiling');

  const withJitter = policy.computeBackoffDelayMs(1, { random: () => 0.999 });
  assert.ok(withJitter >= d1, 'jitter can only add delay, never subtract it');
});

test('classifyCollectionFailure treats CAPTCHA/rate-limit/access-denied signals as an access-control challenge, never as an ordinary retryable error', () => {
  const policy = loadPolicy();
  for (const msg of ['CAPTCHA required', 'HTTP 429 Too Many Requests', 'Access Denied', '403 Forbidden', 'rate limit exceeded', 'request blocked']) {
    assert.equal(policy.classifyCollectionFailure(new Error(msg)), policy.ACCESS_CONTROL_CHALLENGE, `expected "${msg}" to classify as an access-control challenge`);
  }
});

test('classifyCollectionFailure treats network/timeout errors as retryable', () => {
  const policy = loadPolicy();
  for (const msg of ['Navigation timeout of 30000ms exceeded', 'ECONNRESET', 'ECONNREFUSED', 'network error']) {
    assert.equal(policy.classifyCollectionFailure(new Error(msg)), policy.RETRYABLE, `expected "${msg}" to classify as retryable`);
  }
});

test('classifyCollectionFailure treats an unrecognized error as non-retryable (fails closed, never assumes a stranger error is safe to retry indefinitely)', () => {
  const policy = loadPolicy();
  assert.equal(policy.classifyCollectionFailure(new Error('selector not found: .totally-unexpected')), policy.NON_RETRYABLE);
});

test('sanitizeCollectionErrorMessage never echoes a URL or filesystem path, and gives a generic message for an access-control challenge', () => {
  const policy = loadPolicy();
  const withUrl = policy.sanitizeCollectionErrorMessage('failed to load https://web.gc.com/teams/abc123/xyz?token=secret');
  assert.ok(!withUrl.includes('https://'));
  assert.ok(!withUrl.includes('token=secret'));

  const withPath = policy.sanitizeCollectionErrorMessage('ENOENT: no such file or directory, open \'C:\\app\\storage\\gamechanger-auth.json\'');
  assert.ok(!withPath.includes('gamechanger-auth.json'));

  const challenge = policy.sanitizeCollectionErrorMessage('429 Too Many Requests');
  assert.match(challenge, /rate-limited|challenged/i);
});

test('sanitizeCollectionErrorMessage never returns an empty string for an empty/undefined input', () => {
  const policy = loadPolicy();
  assert.ok(policy.sanitizeCollectionErrorMessage('').length > 0);
  assert.ok(policy.sanitizeCollectionErrorMessage(undefined).length > 0);
});
