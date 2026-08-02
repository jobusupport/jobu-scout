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
  SessionValidationError,
} = require('../src/gc-session-loader');

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
    process.env.GC_AUTH_FILE_PATH = missingTarget;
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
      delete require.cache[require.resolve('../src/gc-session-loader')];
      delete require.cache[require.resolve('../src/search-gamechanger-teams')];
    }
  });
});

test('search-gamechanger-teams.js: with GC_AUTH_FILE_PATH unset, the resolved path matches the pre-existing repo-relative default (backward compatible)', async () => {
  const original = process.env.GC_AUTH_FILE_PATH;
  delete process.env.GC_AUTH_FILE_PATH;
  try {
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
  } finally {
    if (original === undefined) delete process.env.GC_AUTH_FILE_PATH; else process.env.GC_AUTH_FILE_PATH = original;
    delete require.cache[require.resolve('../src/gc-session-loader')];
    delete require.cache[require.resolve('../src/search-gamechanger-teams')];
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
