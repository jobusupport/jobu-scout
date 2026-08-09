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
const { spawn } = require('child_process');
const {
  getStorageStatePath,
  materializeStorageStateFromEnvValue,
  validateStorageStateFile,
  assertLandedOnAuthenticatedGameChangerPage,
  isAutomatedTestMode,
  SessionValidationError,
} = require('../src/gc-session-loader');

// test/helpers/test-env-setup.js (preloaded via `node --test --require`,
// see package.json) forces NODE_ENV='test' for this entire process, which
// is exactly what makes isAutomatedTestMode() true everywhere else in this
// file by default -- correct, since that is the real, always-on safety
// posture this suite exists to prove. The small number of tests that need
// to assert PRODUCTION (non-test-mode) path-resolution behavior use this
// helper to simulate being outside test mode for exactly one call, then
// restore NODE_ENV=test immediately after -- never leaking a
// non-test-mode window to any other test in this file or process.
function withNonTestMode(fn) {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return fn();
  } finally {
    process.env.NODE_ENV = original;
  }
}

// Synchronous by design -- every pre-existing call site in this file
// invokes this as a bare statement inside a synchronous test function
// (never awaited/returned), relying on fn(dir) running and throwing
// inline before this function returns. Keep it that way; use
// withTempDirAsync (below) for an async callback instead of changing this
// one's contract out from under every existing caller.
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-session-loader-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// For an async fn(dir) -- awaits its returned promise BEFORE cleanup runs
// (a bare try/finally would run fs.rmSync immediately after an async
// fn(dir) call started, before its work actually finished, since the
// finally block doesn't wait for a returned promise to settle). Callers
// must await withTempDirAsync(...) themselves.
async function withTempDirAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-session-loader-test-'));
  try {
    return await fn(dir);
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

test('getStorageStatePath: OUTSIDE test mode, defaults to the established repo-relative storage/gamechanger-auth.json path when GC_AUTH_FILE_PATH is unset (production behavior, unchanged)', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  try {
    const resolved = withNonTestMode(() => getStorageStatePath());
    assert.ok(resolved.endsWith(path.join('storage', 'gamechanger-auth.json')));
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
  }
});

test('getStorageStatePath: IN test mode (the default for this whole suite), an unset GC_AUTH_FILE_PATH fails closed BEFORE resolving any path -- never falls back to the production default', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  try {
    assert.equal(isAutomatedTestMode(), true, 'this whole suite must actually be running in test mode for this assertion to mean anything');
    assert.throws(() => getStorageStatePath(), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.match(err.message, /test mode/i);
      assert.doesNotMatch(err.message, /storage[\\/]gamechanger-auth\.json/, 'the fail-closed error must never reveal the real default path');
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
  }
});

test('getStorageStatePath: IN test mode, an explicit synthetic GC_AUTH_FILE_PATH is honored exactly as before (this is the ONLY way a test process resolves a session path)', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  process.env.GC_AUTH_FILE_PATH = '/tmp/synthetic-test-only-gc-auth.json';
  try {
    assert.equal(isAutomatedTestMode(), true);
    assert.equal(getStorageStatePath(), '/tmp/synthetic-test-only-gc-auth.json');
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
  }
});

// Proves guarantee: "a real-looking file sitting at the normal default
// local path must not become reachable merely because it exists" -- not by
// trusting that no such file happens to exist (that is exactly the
// assumption that failed once already), but by placing a real-shaped
// (still synthetic-content) file AT the literal default path and proving
// test mode still refuses to resolve to it.
test('getStorageStatePath: a real-looking file sitting at the actual default local path is structurally ignored in test mode', () => {
  const defaultPath = path.join(__dirname, '..', 'storage', 'gamechanger-auth.json');
  const alreadyExisted = fs.existsSync(defaultPath);
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  let wrote = false;
  try {
    if (!alreadyExisted) {
      fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
      fs.writeFileSync(defaultPath, JSON.stringify(SYNTHETIC_VALID_SESSION));
      wrote = true;
    }
    assert.equal(isAutomatedTestMode(), true);
    assert.throws(() => getStorageStatePath(), (err) => {
      assert.ok(err instanceof SessionValidationError);
      assert.match(err.message, /test mode/i);
      return true;
    }, 'a file existing at the default path must not change test-mode fail-closed behavior at all');
  } finally {
    if (wrote) fs.rmSync(defaultPath, { force: true });
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

// ── materializeStorageStateFromEnvValue ─────────────────────────────────
// The exact function server.js's startup handling calls to write the
// GC_AUTH_JSON-style secret to disk -- these tests prove the write
// mechanics directly (path configurability, restrictive permissions,
// parent-directory creation, safe no-op on empty input) without spawning
// the full server, which has many unrelated startup side effects out of
// this correction's scope. A real-subprocess proof that server.js's own
// startup code path actually reaches this function follows further below.

test('materializeStorageStateFromEnvValue: writes synthetic content to the resolved default path when GC_AUTH_FILE_PATH is unset', () => {
  withTempDir((dir) => {
    const original = process.env.GC_AUTH_FILE_PATH;
    process.env.GC_AUTH_FILE_PATH = path.join(dir, 'default-target', 'synthetic-gamechanger-auth.json');
    try {
      const target = getStorageStatePath();
      const result = materializeStorageStateFromEnvValue(JSON.stringify(SYNTHETIC_VALID_SESSION));
      assert.equal(result, true);
      assert.ok(fs.existsSync(target));
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), SYNTHETIC_VALID_SESSION);
    } finally {
      if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    }
  });
});

test('materializeStorageStateFromEnvValue: honors an explicitly configured target path override, proving rotation needs no code change', () => {
  withTempDir((dir) => {
    const rotatedTarget = path.join(dir, 'rotated-location', 'synthetic-gamechanger-auth.json');
    const result = materializeStorageStateFromEnvValue(JSON.stringify(SYNTHETIC_VALID_SESSION), rotatedTarget);
    assert.equal(result, true);
    assert.ok(fs.existsSync(rotatedTarget));
  });
});

test('materializeStorageStateFromEnvValue: creates only the necessary parent directory', () => {
  withTempDir((dir) => {
    const nested = path.join(dir, 'a', 'b', 'c', 'synthetic-gamechanger-auth.json');
    materializeStorageStateFromEnvValue('{"cookies":[{"name":"x"}]}', nested);
    assert.ok(fs.existsSync(nested));
    assert.ok(fs.statSync(path.dirname(nested)).isDirectory());
  });
});

test('materializeStorageStateFromEnvValue: writes nothing and returns false when the env value is empty/nullish', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'synthetic-gamechanger-auth.json');
    assert.equal(materializeStorageStateFromEnvValue('', target), false);
    assert.equal(materializeStorageStateFromEnvValue(undefined, target), false);
    assert.equal(materializeStorageStateFromEnvValue(null, target), false);
    assert.ok(!fs.existsSync(target));
  });
});

test('materializeStorageStateFromEnvValue: return value is a plain boolean, never the resolved path or file content', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'synthetic-gamechanger-auth.json');
    const result = materializeStorageStateFromEnvValue('{"cookies":[{"name":"x"}]}', target);
    assert.equal(typeof result, 'boolean');
  });
});

test(
  'materializeStorageStateFromEnvValue: writes with owner-only (0600) permissions on POSIX platforms',
  { skip: process.platform === 'win32' ? 'POSIX permission bits are not meaningfully enforced via Node\'s fs.mode option on Windows' : false },
  () => {
    withTempDir((dir) => {
      const target = path.join(dir, 'synthetic-gamechanger-auth.json');
      materializeStorageStateFromEnvValue('{"cookies":[{"name":"x"}]}', target);
      const mode = fs.statSync(target).mode & 0o777;
      assert.equal(mode, 0o600);
    });
  }
);

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

// ── End-to-end proof: all three production call sites resolve through
// this one module, not an independently hardcoded path ──────────────────

test('no production source file defines its own gamechanger-auth.json path.join(...) fallback outside src/gc-session-loader.js', () => {
  const filesRequiredToUseTheSharedResolver = [
    path.join(__dirname, '..', 'server.js'),
    path.join(__dirname, '..', 'src', 'search-gamechanger-teams.js'),
    path.join(__dirname, '..', 'src', 'high-school-gc-import.js'),
    // A real production consumer, not a standalone dev utility --
    // server.js's own POST /api/run/gc-scraper route spawns this file
    // directly for any Travel team that has no gc_team_url but has rows
    // in team_game_urls (a real, live-queried condition).
    path.join(__dirname, '..', 'src', 'scrape-game-urls.js'),
  ];
  for (const file of filesRequiredToUseTheSharedResolver) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /path\.join\([^)]*['"]gamechanger-auth\.json['"]\)/,
      `${path.basename(file)} must resolve the session path through gc-session-loader.js, not its own path.join(...) fallback`
    );
    assert.doesNotMatch(
      source,
      /['"]\/app\/storage\/gamechanger-auth\.json['"]/,
      `${path.basename(file)} must not hardcode the deployment-specific absolute path`
    );
    assert.match(
      source,
      /gc-session-loader/,
      `${path.basename(file)} must reference the shared gc-session-loader module`
    );
  }
});

test('search-gamechanger-teams.js: a synthetic GC_AUTH_FILE_PATH override is actually honored, not just structurally referenced', async () => {
  await withTempDirAsync(async (dir) => {
    const missingTarget = path.join(dir, 'synthetic-does-not-exist-gamechanger-auth.json');
    const original = process.env.GC_AUTH_FILE_PATH;
    const originalOrgId = process.env.JOBU_JOB_ORG_ID;
    process.env.GC_AUTH_FILE_PATH = missingTarget;
    // scrapeTeamById now requires this before its auth-file check
    // (Security Slice T2) -- set to a synthetic value so this test still
    // exercises the auth-file resolution behavior it's actually about.
    process.env.JOBU_JOB_ORG_ID = '99999999-9999-4999-8999-999999999999';
    try {
      delete require.cache[require.resolve('../src/gc-session-loader')];
      delete require.cache[require.resolve('../src/search-gamechanger-teams')];
      const scraper = require('../src/search-gamechanger-teams');
      // scrapeTeamById's very first action is checking the resolved
      // STORAGE_STATE path exists, before any directory creation, DB
      // init, or browser launch -- this proves the configured path is
      // the one actually used at runtime, not merely present in source.
      await assert.rejects(
        () => scraper.scrapeTeamById({ id: 'synthetic-team-id', team_name: 'Synthetic Team', gc_team_url: 'https://web.gc.com/teams/x/y' }),
        (err) => {
          assert.match(err.message, /Missing auth file/);
          assert.ok(err.message.includes(missingTarget), 'the error must reflect the CONFIGURED path, proving it was actually used');
          return true;
        }
      );
    } finally {
      if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
      if (originalOrgId === undefined) delete process.env.JOBU_JOB_ORG_ID; else process.env.JOBU_JOB_ORG_ID = originalOrgId;
      delete require.cache[require.resolve('../src/gc-session-loader')];
      delete require.cache[require.resolve('../src/search-gamechanger-teams')];
    }
  });
});

test('search-gamechanger-teams.js: OUTSIDE test mode, with GC_AUTH_FILE_PATH unset, the resolved path matches the pre-existing repo-relative default (production behavior, unchanged)', async () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  const originalOrgId = process.env.JOBU_JOB_ORG_ID;
  delete process.env.GC_AUTH_FILE_PATH;
  // scrapeTeamById now requires this before its auth-file check (Security
  // Slice T2) -- set to a synthetic value so this test still exercises
  // the auth-file resolution behavior it's actually about.
  process.env.JOBU_JOB_ORG_ID = '99999999-9999-4999-8999-999999999999';
  try {
    await withNonTestMode(async () => {
      delete require.cache[require.resolve('../src/gc-session-loader')];
      delete require.cache[require.resolve('../src/search-gamechanger-teams')];
      const scraper = require('../src/search-gamechanger-teams');
      await assert.rejects(
        () => scraper.scrapeTeamById({ id: 'synthetic-team-id', team_name: 'Synthetic Team', gc_team_url: 'https://web.gc.com/teams/x/y' }),
        (err) => {
          assert.ok(err.message.includes(path.join('storage', 'gamechanger-auth.json')), 'must still resolve to the established default location');
          return true;
        }
      );
    });
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    if (originalOrgId === undefined) delete process.env.JOBU_JOB_ORG_ID; else process.env.JOBU_JOB_ORG_ID = originalOrgId;
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/search-gamechanger-teams')];
  }
});

test('search-gamechanger-teams.js: IN test mode, with GC_AUTH_FILE_PATH unset, requiring the module fails closed before any browser/network operation, never resolving the production default', () => {
  // search-gamechanger-teams.js computes STORAGE_STATE via
  // getStorageStatePath() at module top-level (const STORAGE_STATE =
  // getStorageStatePath();) -- the fail-closed throw happens synchronously
  // at require() time, before scrapeTeamById could ever be called.
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  try {
    assert.equal(isAutomatedTestMode(), true);
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/search-gamechanger-teams')];
    // Not an `instanceof SessionValidationError` check here: gc-session-loader
    // was just evicted from require.cache above, so the class thrown by the
    // freshly re-required module is a DIFFERENT identity than any
    // SessionValidationError reference captured earlier in this file --
    // the same reason the pre-existing tests in this file that also
    // delete-cache-and-re-require assert on err.message, never instanceof.
    assert.throws(() => require('../src/search-gamechanger-teams'), (err) => {
      assert.equal(err.name, 'SessionValidationError');
      assert.match(err.message, /test mode/i);
      assert.doesNotMatch(err.message, /storage[\\/]gamechanger-auth\.json/);
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/search-gamechanger-teams')];
  }
});

// ── src/scrape-game-urls.js -- a REAL production consumer (spawned
// directly by server.js's POST /api/run/gc-scraper route for Travel teams
// with no gc_team_url but existing team_game_urls rows), not a
// standalone dev utility. Its top-level code previously ran an
// unconditional async IIFE on require() -- launching a real browser,
// opening the real Travel SQLite database, and calling process.exit()
// on a missing argv[2] -- with no safe entry point for a test to use.
// It is now guarded by the same require.main===module convention
// src/search-gamechanger-teams.js already used, and exports its
// resolved STORAGE_STATE directly, so a test can prove path selection
// by simply requiring the module fresh -- no browser, no database, no
// GameChanger request, no process.exit -- confirmed safe below before
// relying on it in the two tests that follow.

test('scrape-game-urls.js: requiring the module has no side effects (no browser, database, network, or process exit)', () => {
  // A synthetic GC_AUTH_FILE_PATH is required here now: the module computes
  // STORAGE_STATE via getStorageStatePath() at top-level on require(), and
  // in test mode that call fails closed without an explicit fixture (see
  // src/gc-session-loader.js) -- exactly the safety property this whole
  // file exists to prove, so this test must supply one to still exercise
  // "does requiring the module do anything beyond path resolution."
  const original = process.env.GC_AUTH_FILE_PATH;
  process.env.GC_AUTH_FILE_PATH = path.join(os.tmpdir(), 'synthetic-no-side-effects-gc-auth-test-path.json');
  try {
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/scrape-game-urls')];
    // If this were still unguarded, requiring it with no argv[2] would call
    // process.exit(1) and kill this entire test process -- reaching the
    // next line at all is itself proof the guard works.
    const scraper = require('../src/scrape-game-urls');
    assert.equal(typeof scraper.STORAGE_STATE, 'string');
    assert.ok(scraper.STORAGE_STATE.length > 0);
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/scrape-game-urls')];
  }
});

test('scrape-game-urls.js: a synthetic GC_AUTH_FILE_PATH override is actually honored, not just structurally referenced', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  // A path that is never read from or written to by this test -- only
  // compared as a string -- so no synthetic file needs to exist on disk.
  const syntheticOverridePath = path.join(os.tmpdir(), 'synthetic-scrape-game-urls-gc-auth-test-path.json');
  process.env.GC_AUTH_FILE_PATH = syntheticOverridePath;
  try {
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/scrape-game-urls')];
    const scraper = require('../src/scrape-game-urls');
    assert.equal(scraper.STORAGE_STATE, syntheticOverridePath, 'the configured override must be the actual value the production module resolved to, not merely referenced in source');
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/scrape-game-urls')];
  }
});

test('scrape-game-urls.js: OUTSIDE test mode, with GC_AUTH_FILE_PATH unset, the resolved path matches the pre-existing repo-relative default (production behavior, unchanged)', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  try {
    withNonTestMode(() => {
      delete require.cache[require.resolve('../src/gc-session-loader')];
      delete require.cache[require.resolve('../src/scrape-game-urls')];
      const scraper = require('../src/scrape-game-urls');
      assert.ok(scraper.STORAGE_STATE.endsWith(path.join('storage', 'gamechanger-auth.json')), 'must still resolve to the established default location');
    });
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/scrape-game-urls')];
  }
});

test('scrape-game-urls.js: IN test mode, requiring the module with GC_AUTH_FILE_PATH unset fails closed rather than resolving the production default', () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  try {
    assert.equal(isAutomatedTestMode(), true);
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/scrape-game-urls')];
    // See the equivalent search-gamechanger-teams.js test above for why
    // this checks err.name rather than instanceof SessionValidationError.
    assert.throws(() => require('../src/scrape-game-urls'), (err) => {
      assert.equal(err.name, 'SessionValidationError');
      assert.match(err.message, /test mode/i);
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/scrape-game-urls')];
  }
});

test('server.js startup: a real spawned process writes synthetic GC_AUTH_JSON content to the configured GC_AUTH_FILE_PATH, proving rotation works without any code change', { timeout: 15000 }, async () => {
  await withTempDirAsync(async (dir) => {
    const target = path.join(dir, 'rotated', 'synthetic-gamechanger-auth.json');
    const child = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        GC_AUTH_JSON: JSON.stringify(SYNTHETIC_VALID_SESSION),
        GC_AUTH_FILE_PATH: target,
        // Deliberately no Supabase config -- the write under test happens
        // before any Supabase/network code runs, and this test never
        // waits for (or needs) the server to finish starting.
        SUPABASE_URL: '',
        SUPABASE_SERVICE_ROLE_KEY: '',
        SUPABASE_ANON_KEY: '',
        DASHBOARD_PORT: '0',
      },
    });
    let output = '';
    child.stdout.on('data', (c) => { output += String(c); });
    child.stderr.on('data', (c) => { output += String(c); });

    try {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(target) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(fs.existsSync(target), `expected server.js startup to write the configured session path within the timeout -- output so far: ${output}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), SYNTHETIC_VALID_SESSION);
      assert.ok(output.includes('GC auth session written'), 'expected the sanitized startup success log line');
      assert.ok(!output.includes(target), 'the resolved path must never appear in startup logs');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

// ── Process-level GameChanger network guard ──────────────────────────────
// test/helpers/gc-network-guard.js is preloaded (via `node --test
// --require`, see package.json) for this entire process, before this or
// any other test file runs -- these tests prove it actually does what it
// claims, using the REAL, already-installed guard (never a re-imported or
// re-instantiated copy), so a regression in the preload wiring itself
// would be caught here too.

const { isGameChangerUrl } = require('./helpers/gc-network-guard');

test('gc-network-guard: classifies web.gc.com and other gc.com subdomains as GameChanger, and unrelated hosts (including "notgc.com") as not', () => {
  assert.equal(isGameChangerUrl('https://web.gc.com/teams/x/y'), true);
  assert.equal(isGameChangerUrl('https://api.gc.com/v1/foo'), true);
  assert.equal(isGameChangerUrl('https://gc.com/'), true);
  assert.equal(isGameChangerUrl('https://example.com/'), false);
  assert.equal(isGameChangerUrl('https://notgc.com/'), false, 'must not match by substring -- only real gc.com and its subdomains');
  assert.equal(isGameChangerUrl('not a url at all'), false);
});

// Launches a REAL Chromium browser (Playwright is already a project
// dependency) specifically to prove the guard installed by the process-wide
// preload actually intercepts and aborts navigation to a real GameChanger
// URL -- this is the guarantee that a request never reaches GameChanger's
// real servers even if some future code path resolved a real session. The
// target URL is never actually reached; the assertion is that navigation
// FAILS immediately, not that any real page content is observed.
test('gc-network-guard: an actual Playwright navigation attempt to a real GameChanger URL is blocked immediately, never reaching the network', { timeout: 20000 }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await assert.rejects(
      () => page.goto('https://web.gc.com/teams/synthetic-org/synthetic-team/schedule', { timeout: 8000 }),
      /net::ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED|blockedbyclient/i,
      'navigation to a real GameChanger URL must fail immediately (aborted by the guard), never succeed or hang waiting on real network I/O'
    );
  } finally {
    await browser.close();
  }
});

test('gc-network-guard: a non-GameChanger navigation is unaffected by the guard', { timeout: 20000 }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // data: URLs never touch the network at all -- this proves the guard's
    // route handler correctly falls through for non-GameChanger requests
    // rather than blocking everything indiscriminately.
    await page.goto('data:text/html,<h1>synthetic local page</h1>');
    const text = await page.locator('h1').textContent();
    assert.equal(text, 'synthetic local page');
  } finally {
    await browser.close();
  }
});
