'use strict';

// Unit tests for src/gc-session-loader.js. Every fixture written here is
// synthetic, generated fresh per test into a throwaway temp directory, and
// unmistakably fake (values like 'synthetic-test-cookie-value', never a
// real GameChanger cookie/token). No real session file is read, and no
// fixture is ever committed to the repo -- each is created in os.tmpdir()
// and removed in the test's own cleanup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getStorageStatePath,
  validateStorageStateFile,
  assertLandedOnAuthenticatedGameChangerPage,
  SessionValidationError,
} = require('../src/gc-session-loader');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-session-loader-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeSyntheticSessionFile(dir, content) {
  const file = path.join(dir, 'synthetic-gamechanger-auth.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const SYNTHETIC_VALID_SESSION = {
  cookies: [{ name: 'synthetic_test_session', value: 'synthetic-test-cookie-value-not-real', domain: '.gc.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [{ origin: 'https://web.gc.com', localStorage: [{ name: 'synthetic-test-key', value: 'synthetic-test-value' }] }],
};

test('getStorageStatePath: defaults to the established repo-relative storage/gamechanger-auth.json path when GC_AUTH_FILE_PATH is unset', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  try {
    const resolved = getStorageStatePath();
    assert.ok(resolved.endsWith(path.join('storage', 'gamechanger-auth.json')));
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
  }
});

test('getStorageStatePath: honors a configured GC_AUTH_FILE_PATH, e.g. a secret-mounted runtime path', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  process.env.GC_AUTH_FILE_PATH = '/run/secrets/synthetic-test-gc-auth.json';
  try {
    assert.equal(getStorageStatePath(), '/run/secrets/synthetic-test-gc-auth.json');
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
  }
});

test('validateStorageStateFile: accepts a well-formed synthetic session file', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, SYNTHETIC_VALID_SESSION);
    assert.equal(validateStorageStateFile(file), true);
  });
});

test('validateStorageStateFile: fails safely with a generic message, no path included, when the file is missing', () => {
  withTempDir((dir) => {
    const missing = path.join(dir, 'does-not-exist.json');
    assert.throws(() => validateStorageStateFile(missing), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.ok(!err.message.includes(missing), 'error message must never include the file path');
      assert.match(err.message, /missing/i);
      return true;
    });
  });
});

test('validateStorageStateFile: fails safely when the path is a directory, not a file', () => {
  withTempDir((dir) => {
    assert.throws(() => validateStorageStateFile(dir), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.ok(!err.message.includes(dir));
      return true;
    });
  });
});

test('validateStorageStateFile: fails safely on empty file content', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, '');
    assert.throws(() => validateStorageStateFile(file), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.match(err.message, /empty/i);
      return true;
    });
  });
});

test('validateStorageStateFile: fails safely on malformed JSON, without echoing the malformed content', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, '{ "cookies": [ this is not valid json');
    assert.throws(() => validateStorageStateFile(file), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.ok(!err.message.includes('this is not valid json'));
      assert.match(err.message, /not valid JSON/i);
      return true;
    });
  });
});

test('validateStorageStateFile: fails safely on structurally valid JSON that is not an object (e.g. an array)', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, [1, 2, 3]);
    assert.throws(() => validateStorageStateFile(file), (err) => {
      assert.ok(err instanceof SessionValidationError);
      return true;
    });
  });
});

test('validateStorageStateFile: fails safely when neither cookies nor origins is present', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, { unrelated_field: 'synthetic-test-value' });
    assert.throws(() => validateStorageStateFile(file), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.match(err.message, /storage-state shape/i);
      return true;
    });
  });
});

test('validateStorageStateFile: fails safely when cookies and origins are both present but empty', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, { cookies: [], origins: [] });
    assert.throws(() => validateStorageStateFile(file), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.match(err.message, /no session data/i);
      return true;
    });
  });
});

test('validateStorageStateFile: accepts cookies-only (no origins key at all)', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, { cookies: SYNTHETIC_VALID_SESSION.cookies });
    assert.equal(validateStorageStateFile(file), true);
  });
});

test('no SessionValidationError message ever contains a value resembling a real cookie or token', () => {
  withTempDir((dir) => {
    const file = writeSyntheticSessionFile(dir, '{ broken json with "supersecretcookievalue123"');
    try {
      validateStorageStateFile(file);
      assert.fail('expected validateStorageStateFile to throw');
    } catch (err) {
      assert.ok(!err.message.includes('supersecretcookievalue123'));
    }
  });
});

test('assertLandedOnAuthenticatedGameChangerPage: accepts a genuine team schedule URL', () => {
  assert.equal(assertLandedOnAuthenticatedGameChangerPage('https://web.gc.com/teams/synthetic-org/synthetic-team/schedule'), true);
});

test('assertLandedOnAuthenticatedGameChangerPage: rejects a login-page redirect', () => {
  assert.throws(() => assertLandedOnAuthenticatedGameChangerPage('https://web.gc.com/login?next=%2Fteams%2Fsynthetic-org'), (err) => {
    assert.ok(err instanceof SessionValidationError);
    assert.match(err.message, /expired or was rejected/i);
    return true;
  });
});

test('assertLandedOnAuthenticatedGameChangerPage: rejects an unrelated domain', () => {
  assert.throws(() => assertLandedOnAuthenticatedGameChangerPage('https://evil.example.com/phish'), (err) => {
    assert.ok(err instanceof SessionValidationError);
    return true;
  });
});

test('assertLandedOnAuthenticatedGameChangerPage: never includes the landed URL (which may carry query-string tokens) in its error message', () => {
  const suspiciousUrl = 'https://web.gc.com/login?token=synthetic-test-should-never-appear-in-message';
  try {
    assertLandedOnAuthenticatedGameChangerPage(suspiciousUrl);
    assert.fail('expected assertLandedOnAuthenticatedGameChangerPage to throw');
  } catch (err) {
    assert.ok(!err.message.includes('synthetic-test-should-never-appear-in-message'));
  }
});
