'use strict';

// Database-free regression tests for src/org-resolution.js -- the trusted
// organization-resolution logic getRequestOrgId (server.js) delegates to.
// These execute the ACTUAL authorization code (resolveTrustedOrgId,
// buildAcceptedMembershipsQuery), not a re-implementation of it: the only
// thing mocked is the database call itself, injected via
// `lookupAcceptedMemberships`. This is the executable stop-ship regression
// coverage for the cross-tenant vulnerability found in the Phase 2 Slice 1
// security review (see docs/architecture/PHASE_2_PRODUCT_CAPABILITY_RFC.md
// §11/§22/§25's revision notes): getRequestOrgId used to trust
// user.app_metadata.org_id / user.user_metadata.org_id ahead of any
// database lookup, which let any signed-up user claim membership in an
// org they didn't belong to.
//
// Run with: node --test test/org-resolution.test.js (also included in
// `npm test`, see package.json).

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTrustedOrgId, buildAcceptedMembershipsQuery, mapErrorToResponse } = require('../src/org-resolution');

// ── Test helpers ────────────────────────────────────────────────────────────

// A `lookupAcceptedMemberships` that fails the test immediately if it's
// ever called -- used to prove a code path returns/throws WITHOUT
// performing a membership lookup at all (the support-session short-circuit,
// and the missing-user-id 401).
function lookupThatMustNotBeCalled() {
  return async () => {
    throw new Error('lookupAcceptedMemberships must not be called on this path');
  };
}

function lookupReturning(memberships) {
  return async () => memberships;
}

// Builds a req object whose body/query/params/headers throw the moment
// they're read at all -- the strongest possible proof that
// resolveTrustedOrgId "ignores" them: not just "the value doesn't matter",
// but "the property is never even accessed". Any test using this helper
// that completes without hitting the poison prover the property was never
// touched.
function makeReqWithPoisonedInputs({ orgId, userId, user = {} } = {}) {
  const req = { user: userId ? { id: userId, ...user } : (user.id ? user : null) };
  if (orgId !== undefined) req._orgId = orgId;

  for (const propName of ['body', 'query', 'params', 'headers']) {
    Object.defineProperty(req, propName, {
      enumerable: true,
      get() {
        throw new Error(`resolveTrustedOrgId must never read req.${propName}`);
      },
    });
  }
  return req;
}

async function assertRejectsWithStatus(promise, expectedStatusCode, messagePattern) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, expectedStatusCode, `expected statusCode ${expectedStatusCode}, got ${err.statusCode}`);
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

// ── 1. Support-session req._orgId is preserved, no lookup performed ───────

test('resolveTrustedOrgId — req._orgId from a validated support session is preserved without performing a membership lookup', async () => {
  const req = makeReqWithPoisonedInputs({ orgId: 'target-org-from-support-session', userId: 'admin-user-id' });
  const orgId = await resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupThatMustNotBeCalled() });
  assert.equal(orgId, 'target-org-from-support-session');
});

// ── 2 & 3 & 15. Metadata is completely ignored, even when it names a real org ──

test('resolveTrustedOrgId — user.user_metadata.org_id is completely ignored', async () => {
  const req = {
    user: {
      id: 'real-user-id',
      user_metadata: { org_id: 'forged-org-via-user-metadata' },
    },
  };
  const orgId = await resolveTrustedOrgId(req, {
    lookupAcceptedMemberships: async (userId) => {
      assert.equal(userId, 'real-user-id'); // proves the lookup key is req.user.id, not the metadata value
      return [{ org_id: 'real-membership-org' }];
    },
  });
  assert.equal(orgId, 'real-membership-org');
  assert.notEqual(orgId, 'forged-org-via-user-metadata');
});

test('resolveTrustedOrgId — user.app_metadata.org_id is completely ignored', async () => {
  const req = {
    user: {
      id: 'real-user-id',
      app_metadata: { org_id: 'forged-org-via-app-metadata' },
    },
  };
  const orgId = await resolveTrustedOrgId(req, {
    lookupAcceptedMemberships: async (userId) => {
      assert.equal(userId, 'real-user-id');
      return [{ org_id: 'real-membership-org' }];
    },
  });
  assert.equal(orgId, 'real-membership-org');
  assert.notEqual(orgId, 'forged-org-via-app-metadata');
});

test('resolveTrustedOrgId — both metadata fields forged simultaneously to a real-looking (but wrong) org id are still ignored', async () => {
  // Directly exercises "never selects an organization merely because it
  // appears in metadata" -- the forged value here is deliberately a
  // syntactically valid-looking org id (not garbage), the same shape a
  // real org_id would have, to prove the resolver isn't just rejecting
  // malformed-looking values.
  const req = {
    user: {
      id: 'real-user-id',
      app_metadata: { org_id: '11111111-1111-4111-8111-111111111111' },
      user_metadata: { org_id: '11111111-1111-4111-8111-111111111111' },
    },
  };
  const orgId = await resolveTrustedOrgId(req, {
    lookupAcceptedMemberships: lookupReturning([{ org_id: '22222222-2222-4222-8222-222222222222' }]),
  });
  assert.equal(orgId, '22222222-2222-4222-8222-222222222222');
});

// ── 4, 5, 6, 7. req.body / req.query / req.params / headers are never read ─

test('resolveTrustedOrgId — request body org_id is ignored (property never read)', async () => {
  const req = makeReqWithPoisonedInputs({ userId: 'u1' });
  const orgId = await resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([{ org_id: 'real-org' }]) });
  assert.equal(orgId, 'real-org'); // completes without triggering the "must never read req.body" poison
});

test('resolveTrustedOrgId — request query org_id is ignored (property never read)', async () => {
  const req = makeReqWithPoisonedInputs({ userId: 'u1' });
  const orgId = await resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([{ org_id: 'real-org' }]) });
  assert.equal(orgId, 'real-org');
});

test('resolveTrustedOrgId — request params org_id is ignored (property never read)', async () => {
  const req = makeReqWithPoisonedInputs({ userId: 'u1' });
  const orgId = await resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([{ org_id: 'real-org' }]) });
  assert.equal(orgId, 'real-org');
});

test('resolveTrustedOrgId — arbitrary organization headers are ignored (property never read)', async () => {
  const req = makeReqWithPoisonedInputs({ userId: 'u1' });
  // The poisoned req.headers getter throws the instant ANY code reads
  // req.headers at all, regardless of which header name it was after
  // (X-Org-Id, X-Organization, etc.) -- proving none of them are consulted.
  const orgId = await resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([{ org_id: 'real-org' }]) });
  assert.equal(orgId, 'real-org');
});

test('resolveTrustedOrgId — body/query/params/headers are still never read even on the support-session short-circuit path', async () => {
  const req = makeReqWithPoisonedInputs({ orgId: 'target-org', userId: 'admin-id' });
  const orgId = await resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupThatMustNotBeCalled() });
  assert.equal(orgId, 'target-org');
});

// ── 8. Missing req.user.id -> 401, no lookup performed ─────────────────────

test('resolveTrustedOrgId — missing req.user.id produces 401 without performing a lookup', async () => {
  const req = { user: null };
  await assertRejectsWithStatus(
    resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupThatMustNotBeCalled() }),
    401,
    /unable to determine the current user/i
  );
});

test('resolveTrustedOrgId — req.user present but with no .id also produces 401', async () => {
  const req = { user: { email: 'someone@example.com' } }; // no .id
  await assertRejectsWithStatus(
    resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupThatMustNotBeCalled() }),
    401
  );
});

// ── 9, 10, 11. Zero / one / many memberships ────────────────────────────────

test('resolveTrustedOrgId — zero accepted memberships produces 403', async () => {
  const req = { user: { id: 'u1' } };
  await assertRejectsWithStatus(
    resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([]) }),
    403,
    /no organization membership/i
  );
});

test('resolveTrustedOrgId — exactly one accepted membership returns that org_id', async () => {
  const req = { user: { id: 'u1' } };
  const orgId = await resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([{ org_id: 'only-org' }]) });
  assert.equal(orgId, 'only-org');
});

test('resolveTrustedOrgId — two or more accepted memberships produce 403 (ambiguous, not guessed)', async () => {
  const req = { user: { id: 'u1' } };
  await assertRejectsWithStatus(
    resolveTrustedOrgId(req, {
      lookupAcceptedMemberships: lookupReturning([{ org_id: 'org-a' }, { org_id: 'org-b' }]),
    }),
    403,
    /more than one organization/i
  );
});

// ── 12. Database failure -> generic 500, no leaked detail ──────────────────

test('resolveTrustedOrgId — a database lookup failure produces a generic 500 and does not expose the database error text', async () => {
  const req = { user: { id: 'u1' } };
  const sensitiveDbError = new Error(
    'relation "org_members" does not exist: SELECT org_id FROM org_members WHERE user_id = $1 (connection postgres://admin:s3cr3t@db.internal:5432)'
  );
  await assert.rejects(
    resolveTrustedOrgId(req, {
      lookupAcceptedMemberships: async () => { throw sensitiveDbError; },
    }),
    (err) => {
      assert.equal(err.statusCode, 500);
      assert.doesNotMatch(err.message, /org_members|postgres|s3cr3t|relation|SELECT/i);
      assert.equal(err.message, 'Unable to verify organization membership right now. Please try again.');
      return true;
    }
  );
});

// ── 13. Malformed membership results fail closed ───────────────────────────

test('resolveTrustedOrgId — malformed membership results fail closed (not an array)', async () => {
  const req = { user: { id: 'u1' } };
  for (const malformed of [null, undefined, {}, 'not-an-array', 42]) {
    await assertRejectsWithStatus(
      resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning(malformed) }),
      500
    );
  }
});

test('resolveTrustedOrgId — malformed membership results fail closed (bad row shapes)', async () => {
  const req = { user: { id: 'u1' } };
  const malformedArrays = [
    [null],
    [{}],                          // missing org_id
    [{ org_id: 12345 }],           // wrong type
    [{ org_id: '' }],              // empty string
    [{ org_id: 'good-org' }, null], // one good row, one bad -- still fails closed, not "use the good one"
  ];
  for (const malformed of malformedArrays) {
    await assertRejectsWithStatus(
      resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning(malformed) }),
      500
    );
  }
});

test('resolveTrustedOrgId — malformed-result 500 also does not leak the malformed payload', async () => {
  const req = { user: { id: 'u1' } };
  await assert.rejects(
    resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([{ org_id: null, secret: 'internal-debug-value' }]) }),
    (err) => {
      assert.equal(err.statusCode, 500);
      assert.doesNotMatch(err.message, /internal-debug-value/);
      return true;
    }
  );
});

// ── 14. The real production query filters on accepted_at IS NOT NULL ───────

function createQuerySpy() {
  const calls = [];
  const builder = {
    from(table) { calls.push(['from', table]); return builder; },
    select(cols) { calls.push(['select', cols]); return builder; },
    eq(col, val) { calls.push(['eq', col, val]); return builder; },
    not(col, op, val) { calls.push(['not', col, op, val]); return builder; },
  };
  return { builder, calls };
}

test('buildAcceptedMembershipsQuery — queries org_members filtered by user_id and accepted_at IS NOT NULL', () => {
  const { builder, calls } = createQuerySpy();
  const result = buildAcceptedMembershipsQuery(builder, 'user-123');

  assert.equal(result, builder); // chainable Supabase-client shape, same object throughout
  assert.deepEqual(calls, [
    ['from', 'org_members'],
    ['select', 'org_id'],
    ['eq', 'user_id', 'user-123'],
    ['not', 'accepted_at', 'is', null],
  ]);
});

test('buildAcceptedMembershipsQuery — the user id is passed through exactly, never a metadata value', () => {
  const { builder, calls } = createQuerySpy();
  buildAcceptedMembershipsQuery(builder, 'exact-caller-user-id');
  const eqCall = calls.find((c) => c[0] === 'eq');
  assert.deepEqual(eqCall, ['eq', 'user_id', 'exact-caller-user-id']);
});

// ── mapErrorToResponse: the corrected caller error-handling contract ──────
// Regression coverage for the second batch of corrections requested after
// PR #2's first push: every server.js route/middleware that calls
// getRequestOrgId now maps errors through this one shared function instead
// of each re-implementing (and risking getting wrong) the same check.

test('mapErrorToResponse — a typed error (statusCode set) forwards its own safe message unchanged', () => {
  const err = new Error('No organization membership found for this account.');
  err.statusCode = 403;
  assert.deepEqual(mapErrorToResponse(err), {
    statusCode: 403,
    message: 'No organization membership found for this account.',
  });
});

test('mapErrorToResponse — every statusCode resolveTrustedOrgId can throw is forwarded as-is', () => {
  for (const statusCode of [401, 403, 500]) {
    const err = new Error(`typed message for ${statusCode}`);
    err.statusCode = statusCode;
    assert.deepEqual(mapErrorToResponse(err), { statusCode, message: `typed message for ${statusCode}` });
  }
});

test('mapErrorToResponse — an untyped error (no statusCode) becomes a generic 500, message discarded', () => {
  const rawDbError = new Error(
    'relation "org_members" does not exist: SELECT org_id FROM org_members (connection postgres://admin:s3cr3t@db.internal:5432)'
  );
  // deliberately no .statusCode -- simulates a raw Supabase/Postgres error
  const result = mapErrorToResponse(rawDbError);
  assert.equal(result.statusCode, 500);
  assert.equal(result.message, 'Something went wrong. Please try again.');
  assert.doesNotMatch(result.message, /org_members|postgres|s3cr3t/i);
});

test('mapErrorToResponse — statusCode 0 and other falsy-but-set values are still treated as untyped (defensive)', () => {
  const err = new Error('edge case');
  err.statusCode = 0; // falsy -- must not be mistaken for "not set"
  const result = mapErrorToResponse(err);
  assert.equal(result.statusCode, 500); // falls back safely rather than responding with statusCode 0
});

test('mapErrorToResponse — a plain object without an Error prototype is still handled safely', () => {
  const result = mapErrorToResponse({ message: 'not a real Error instance' });
  assert.equal(result.statusCode, 500);
  assert.equal(result.message, 'Something went wrong. Please try again.');
});

test('mapErrorToResponse — null/undefined input is handled safely (never throws)', () => {
  assert.deepEqual(mapErrorToResponse(null), { statusCode: 500, message: 'Something went wrong. Please try again.' });
  assert.deepEqual(mapErrorToResponse(undefined), { statusCode: 500, message: 'Something went wrong. Please try again.' });
});

// ── End-to-end: resolveTrustedOrgId's thrown errors map correctly ─────────
// Proves the two functions compose the way server.js's sendResolverError
// actually uses them, not just that each works in isolation.

test('resolveTrustedOrgId + mapErrorToResponse — missing user maps to 401 with the safe message', async () => {
  const req = { user: null };
  await assert.rejects(resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupThatMustNotBeCalled() }), (err) => {
    const mapped = mapErrorToResponse(err);
    assert.equal(mapped.statusCode, 401);
    assert.match(mapped.message, /unable to determine the current user/i);
    return true;
  });
});

test('resolveTrustedOrgId + mapErrorToResponse — zero memberships maps to 403 with the safe message', async () => {
  const req = { user: { id: 'u1' } };
  await assert.rejects(resolveTrustedOrgId(req, { lookupAcceptedMemberships: lookupReturning([]) }), (err) => {
    const mapped = mapErrorToResponse(err);
    assert.equal(mapped.statusCode, 403);
    assert.match(mapped.message, /no organization membership/i);
    return true;
  });
});

test('resolveTrustedOrgId + mapErrorToResponse — a raw database failure maps to a generic 500, never the raw text', async () => {
  const req = { user: { id: 'u1' } };
  const sensitiveDbError = new Error('FATAL: password authentication failed for user "admin"');
  await assert.rejects(
    resolveTrustedOrgId(req, { lookupAcceptedMemberships: async () => { throw sensitiveDbError; } }),
    (err) => {
      // resolveTrustedOrgId itself already re-throws a typed 500 here (not
      // the raw dbErr) -- confirm mapErrorToResponse forwards THAT safe
      // message, and that the original raw text is nowhere in the result.
      const mapped = mapErrorToResponse(err);
      assert.equal(mapped.statusCode, 500);
      assert.doesNotMatch(mapped.message, /password|authentication failed|admin/i);
      return true;
    }
  );
});
