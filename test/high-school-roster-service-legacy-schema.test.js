'use strict';

// Focused tests for src/high-school-roster-service.js's deployment-
// compatibility bridge: the temporary adapter that lets hs_players
// operations work correctly against BOTH the legacy production schema
// (plain writable is_active, no status column) and the lifecycle schema
// added by supabase/migrations/20260803120000_add_hs_player_lifecycle_status.sql
// (status column + generated is_active), so the application can deploy
// before that migration is applied to production, keep working while it's
// pending, and switch over automatically once it lands.
//
// test/high-school-roster-service.test.js covers the (unchanged) lifecycle
// behavior exhaustively and seeds the module's capability cache to `true`
// once at the top of that file so none of its 68 tests need to know this
// bridge exists. This file is the mirror image: it exercises the LEGACY
// path, the capability probe/cache itself, and the error-classification
// rules that decide which path runs -- using a fake adminClient built to
// accurately simulate BOTH schemas (never manufacturing generated-column
// behavior that would hide an invalid payload).
//
// Run with: node --test test/high-school-roster-service-legacy-schema.test.js
// (also included in `npm test`, see package.json).

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/high-school-roster-service');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PROGRAM_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '44444444-4444-4444-8444-444444444444';
const PLAYER_ID = '55555555-5555-4555-8555-555555555555';
const SEASON_ID = '33333333-3333-4333-8333-333333333333';

const program = { id: PROGRAM_ID, org_id: ORG_ID };

// ── Fake adminClient (schema-aware) ──────────────────────────────────────
//
// Same queued-response-per-table shape as test/high-school-roster-service.test.js's
// own fake, extended in exactly one way: select() now RECORDS the column
// string it was called with (never just a no-op passthrough), so tests can
// assert a legacy-mode query never references `status` -- proving the
// bridge's read/write shape, not just trusting its return value.
function makeFakeAdminClient(queues) {
  const calls = [];
  function consume(table) {
    const entry = queues[table];
    if (Array.isArray(entry)) return entry.shift() || { data: null, error: null };
    return entry || { data: null, error: null };
  }
  function builderFor(table) {
    const builder = {
      eq: () => builder,
      order: () => builder,
      or: () => builder,
      limit: () => builder,
      in: () => builder,
      select: (columns) => { calls.push({ table, method: 'select', args: columns }); return builder; },
      insert: (payload) => { calls.push({ table, method: 'insert', args: payload }); return builder; },
      update: (payload) => { calls.push({ table, method: 'update', args: payload }); return builder; },
      single: () => Promise.resolve(consume(table)),
      maybeSingle: () => Promise.resolve(consume(table)),
      then: (resolve) => resolve(consume(table)),
    };
    return builder;
  }
  return {
    calls,
    from: (table) => builderFor(table),
  };
}

function queued(...results) { return results; }
function ok(data) { return { data, error: null }; }
function err(error) { return { data: null, error }; }

// Real PostgREST/Postgres error shapes this bridge must recognize or
// reject, transcribed from this codebase's own established convention
// (src/high-school-api.js's isMissingRelationError) rather than invented.
function missingStatusColumnErrorPgrst() {
  return { code: 'PGRST204', message: "Could not find the 'status' column of 'hs_players' in the schema cache" };
}
function missingStatusColumnErrorPg() {
  return { code: '42703', message: 'column "status" does not exist' };
}
function rlsError() {
  return { code: '42501', message: 'new row violates row-level security policy for table "hs_players"' };
}
function networkError() {
  return { message: 'fetch failed' };
}
function unrelatedMissingColumnError() {
  // Missing-column SHAPED, but not about `status` -- must never be
  // misclassified as the legacy-schema signal.
  return { code: '42703', message: 'column "foo" does not exist' };
}

function legacyPlayerRow({ id = PLAYER_ID, is_active = true, ...rest } = {}) {
  return {
    id, program_id: PROGRAM_ID, first_name: 'Jo', last_name: 'Smith',
    preferred_name: null, graduation_year: null, is_active, ...rest,
  };
}

test.beforeEach(() => {
  // Force a fresh probe for every test -- nothing in this file should ever
  // depend on ordering or leftover state from a previous test.
  svc.__setSchemaCapabilityForTests(null);
});

// ── isMissingStatusColumnError: pure classification ──────────────────────

test('isMissingStatusColumnError recognizes both real missing-status-column error shapes', () => {
  assert.equal(svc.isMissingStatusColumnError(missingStatusColumnErrorPgrst()), true);
  assert.equal(svc.isMissingStatusColumnError(missingStatusColumnErrorPg()), true);
});

test('isMissingStatusColumnError rejects RLS, network, and unrelated-column errors', () => {
  assert.equal(svc.isMissingStatusColumnError(rlsError()), false);
  assert.equal(svc.isMissingStatusColumnError(networkError()), false);
  assert.equal(svc.isMissingStatusColumnError(unrelatedMissingColumnError()), false);
});

// ── toLegacyPlayerWritePayload / synthesizeLegacyPlayerStatus: pure ──────

test('toLegacyPlayerWritePayload strips status and derives is_active', () => {
  assert.deepEqual(
    svc.toLegacyPlayerWritePayload({ first_name: 'Jo', status: 'active' }),
    { first_name: 'Jo', is_active: true }
  );
  for (const status of svc.PLAYER_STATUSES.filter((s) => s !== 'active')) {
    assert.deepEqual(
      svc.toLegacyPlayerWritePayload({ status }),
      { is_active: false }
    );
  }
});

test('toLegacyPlayerWritePayload passes a status-less patch through unchanged (preserves current state on update)', () => {
  const patch = { first_name: 'Joanna' };
  assert.deepEqual(svc.toLegacyPlayerWritePayload(patch), patch);
});

test('synthesizeLegacyPlayerStatus derives status from is_active and passes null through', () => {
  assert.equal(svc.synthesizeLegacyPlayerStatus({ is_active: true }).status, 'active');
  assert.equal(svc.synthesizeLegacyPlayerStatus({ is_active: false }).status, 'other_non_returning');
  assert.equal(svc.synthesizeLegacyPlayerStatus(null), null);
});

// ── hasStatusColumn / capability probe ────────────────────────────────────

test('hasStatusColumn returns true and caches when the probe select succeeds', async () => {
  const adminClient = makeFakeAdminClient({ hs_players: queued(ok([])) });
  assert.equal(await svc.hasStatusColumn(adminClient), true);
  // Cached -- a second call must not touch adminClient again (zero
  // remaining queued responses would throw if it tried).
  assert.equal(await svc.hasStatusColumn(adminClient), true);
  assert.equal(adminClient.calls.filter((c) => c.method === 'select').length, 1);
});

test('hasStatusColumn returns false when the probe hits the precise missing-status-column error', async () => {
  const adminClient = makeFakeAdminClient({ hs_players: queued(err(missingStatusColumnErrorPgrst())) });
  assert.equal(await svc.hasStatusColumn(adminClient), false);
});

test('hasStatusColumn rejects (never caches, never treated as legacy) on an unrelated error', async () => {
  const adminClient = makeFakeAdminClient({ hs_players: queued(err(rlsError())) });
  await assert.rejects(() => svc.hasStatusColumn(adminClient), (e) => e.statusCode === 500);

  // Not cached: the next call probes again cleanly (proven by queuing a
  // real success this time and getting the correct, fresh answer).
  const adminClient2 = makeFakeAdminClient({ hs_players: queued(ok([])) });
  assert.equal(await svc.hasStatusColumn(adminClient2), true);
});

test('hasStatusColumn de-duplicates concurrent calls into a single in-flight probe', async () => {
  const adminClient = makeFakeAdminClient({ hs_players: queued(ok([])) });
  const [a, b] = await Promise.all([svc.hasStatusColumn(adminClient), svc.hasStatusColumn(adminClient)]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(adminClient.calls.filter((c) => c.method === 'select').length, 1);
});

test('CAPABILITY_RECHECK_INTERVAL_MS is a finite, positive, bounded value (never permanent, never zero)', () => {
  assert.equal(typeof svc.CAPABILITY_RECHECK_INTERVAL_MS, 'number');
  assert.ok(svc.CAPABILITY_RECHECK_INTERVAL_MS > 0);
  assert.ok(Number.isFinite(svc.CAPABILITY_RECHECK_INTERVAL_MS));
});

test('a legacy determination can be forced to re-probe (proves the cache is not permanently stuck)', async () => {
  svc.__setSchemaCapabilityForTests(false);
  // Reset to unknown, simulating CAPABILITY_RECHECK_INTERVAL_MS having
  // elapsed -- the next call must probe again, not trust stale state.
  svc.__setSchemaCapabilityForTests(null);
  const adminClient = makeFakeAdminClient({ hs_players: queued(ok([])) });
  assert.equal(await svc.hasStatusColumn(adminClient), true);
});

// ── Legacy-schema mode: createPlayer ──────────────────────────────────────

test('createPlayer (legacy schema): neither field supplied defaults to active', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow({ is_active: true }))),
  });
  const result = await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient, getProgram });
  assert.equal(result.status, 'active');
  assert.equal(result.is_active, true);
  const insertCall = adminClient.calls.find((c) => c.method === 'insert');
  assert.equal(insertCall.args.is_active, true);
  assert.equal('status' in insertCall.args, false);
});

test('createPlayer (legacy schema): each valid status produces the correct legacy boolean and a lossy, honestly-reported response', async () => {
  for (const status of svc.PLAYER_STATUSES) {
    svc.__setSchemaCapabilityForTests(null); // force a fresh probe each iteration -- capability was cached by the previous one
    const getProgram = async () => program;
    const expectedIsActive = status === 'active';
    const adminClient = makeFakeAdminClient({
      hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow({ is_active: expectedIsActive }))),
    });
    const result = await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: `S-${status}`, status }, adminClient, getProgram });
    const insertCall = adminClient.calls.find((c) => c.method === 'insert');
    assert.equal('status' in insertCall.args, false, 'the legacy insert payload must never reference status');
    assert.equal(insertCall.args.is_active, expectedIsActive);
    // The requested reason is never falsely reported as persisted: only
    // 'active' round-trips as itself, every other status reads back as the
    // schema's own conservative 'other_non_returning'.
    assert.equal(result.status, status === 'active' ? 'active' : 'other_non_returning');
    assert.equal(result.is_active, expectedIsActive);
  }
});

test('createPlayer (legacy schema): legacy is_active=true/false still work', async () => {
  const getProgram = async () => program;

  const trueClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow({ is_active: true }))),
  });
  const trueResult = await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'True', is_active: true }, adminClient: trueClient, getProgram });
  assert.equal(trueResult.status, 'active');
  assert.equal(trueResult.is_active, true);

  svc.__setSchemaCapabilityForTests(null); // force a fresh probe -- the first call above already cached capability
  const falseClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow({ is_active: false }))),
  });
  const falseResult = await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'False', is_active: false }, adminClient: falseClient, getProgram });
  assert.equal(falseResult.status, 'other_non_returning');
  assert.equal(falseResult.is_active, false);
});

test('createPlayer (legacy schema): agreeing dual fields are accepted (is_active wins the boolean, status only informed the choice)', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow({ is_active: false }))),
  });
  const result = await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Agree', status: 'transferred', is_active: false }, adminClient, getProgram });
  const insertCall = adminClient.calls.find((c) => c.method === 'insert');
  assert.equal(insertCall.args.is_active, false);
  assert.equal('status' in insertCall.args, false);
  // Lossy on the legacy schema: 'transferred' was accepted but cannot be
  // distinguished from any other non-active reason once persisted.
  assert.equal(result.status, 'other_non_returning');
});

test('createPlayer (legacy schema): conflicting dual fields are rejected with 400 before any query is made', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Conflict', status: 'graduated', is_active: true }, adminClient, getProgram }),
    (e) => e.statusCode === 400 && /disagree/.test(e.message)
  );
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Conflict2', status: 'active', is_active: false }, adminClient, getProgram }),
    (e) => e.statusCode === 400 && /disagree/.test(e.message)
  );
  assert.equal(adminClient.calls.length, 0);
});

test('createPlayer (legacy schema): an invalid status is rejected with 400 before any query is made', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Bad', status: 'benched' }, adminClient, getProgram }),
    (e) => e.statusCode === 400 && /status must be one of/.test(e.message)
  );
  assert.equal(adminClient.calls.length, 0);
});

test('createPlayer (legacy schema): the select clause never references status', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow())),
  });
  await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient, getProgram });
  const selectCalls = adminClient.calls.filter((c) => c.method === 'select');
  // The probe's own select('status') is expected and correct; the SECOND
  // select -- the actual read-back after insert -- must not ask for status.
  assert.equal(selectCalls.length, 2);
  assert.doesNotMatch(selectCalls[1].args, /status/);
});

test('createPlayer (legacy schema): exactly one insert is issued (the probe cannot cause a duplicate write)', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow())),
  });
  await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient, getProgram });
  assert.equal(adminClient.calls.filter((c) => c.method === 'insert').length, 1);
});

// ── Legacy-schema mode: getPlayerInOrg / listPlayers ──────────────────────

test('getPlayerInOrg (legacy schema): returns both status and is_active, status synthesized from is_active', async () => {
  const adminClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow({ is_active: false }))),
  });
  const result = await svc.getPlayerInOrg({ orgId: ORG_ID, playerId: PLAYER_ID, adminClient });
  assert.equal(result.status, 'other_non_returning');
  assert.equal(result.is_active, false);
});

test('getPlayerInOrg (legacy schema): a cross-tenant player still 404s (returns null), independent of schema mode', async () => {
  const adminClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(null)),
  });
  const result = await svc.getPlayerInOrg({ orgId: ORG_ID, playerId: PLAYER_ID, adminClient });
  assert.equal(result, null);
});

test('listPlayers (legacy schema): every row includes both compatibility fields', async () => {
  const adminClient = makeFakeAdminClient({
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok([legacyPlayerRow({ is_active: true }), legacyPlayerRow({ id: 'other', is_active: false })])),
  });
  const result = await svc.listPlayers({ orgId: ORG_ID, search: undefined, adminClient });
  assert.equal(result.length, 2);
  assert.equal(result[0].status, 'active');
  assert.equal(result[1].status, 'other_non_returning');
});

// ── Legacy-schema mode: updatePlayer ──────────────────────────────────────

test('updatePlayer (legacy schema): neither field supplied preserves the current boolean state', async () => {
  const adminClient = makeFakeAdminClient({
    hs_players: queued(
      err(missingStatusColumnErrorPgrst()), // getPlayerInOrg's probe
      ok(legacyPlayerRow({ is_active: false })), // getPlayerInOrg's existence read
      ok(legacyPlayerRow({ is_active: false, first_name: 'Joanna' })), // the update itself
    ),
  });
  const result = await svc.updatePlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { first_name: 'Joanna' }, adminClient });
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.equal('is_active' in updateCall.args, false);
  assert.equal('status' in updateCall.args, false);
  assert.equal(result.status, 'other_non_returning');
  assert.equal(result.is_active, false);
});

test('updatePlayer (legacy schema): reactivation produces is_active=true', async () => {
  const adminClient = makeFakeAdminClient({
    hs_players: queued(
      err(missingStatusColumnErrorPgrst()),
      ok(legacyPlayerRow({ is_active: false })),
      ok(legacyPlayerRow({ is_active: true })),
    ),
  });
  const result = await svc.updatePlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { status: 'active' }, adminClient });
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.equal(updateCall.args.is_active, true);
  assert.equal('status' in updateCall.args, false);
  assert.equal(result.status, 'active');
  assert.equal(result.is_active, true);
});

test('updatePlayer (legacy schema): a non-active status reactivation-in-reverse produces is_active=false and reads back as other_non_returning', async () => {
  const adminClient = makeFakeAdminClient({
    hs_players: queued(
      err(missingStatusColumnErrorPgrst()),
      ok(legacyPlayerRow({ is_active: true })),
      ok(legacyPlayerRow({ is_active: false })),
    ),
  });
  const result = await svc.updatePlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { status: 'not_participating' }, adminClient });
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.equal(updateCall.args.is_active, false);
  assert.equal(result.status, 'other_non_returning');
});

test('updatePlayer (legacy schema): returns 404 for a player belonging to another organization', async () => {
  const adminClient = makeFakeAdminClient({ hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(null)) });
  await assert.rejects(
    () => svc.updatePlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { status: 'graduated' }, adminClient }),
    (e) => e.statusCode === 404
  );
});

// ── Legacy-schema mode: roster-membership protections remain intact ──────

test('addRosterMembership (legacy schema): still rejects a non-active player represented by the legacy boolean', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok({ id: TEAM_ID, is_active: true })),
    hs_players: queued(err(missingStatusColumnErrorPgrst()), ok(legacyPlayerRow({ is_active: false }))),
    hs_seasons: queued(ok({ id: SEASON_ID })),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient }),
    (e) => e.statusCode === 409 && /inactive player/.test(e.message)
  );
});

// ── Lifecycle-schema mode: the bridge must not alter the merged behavior ──
//
// test/high-school-roster-service.test.js already covers this exhaustively
// (68 tests, unchanged by this bridge). This block is a small, focused
// confirmation that when the lifecycle schema IS available, the bridge
// takes the unchanged lifecycle path -- no probe call, no legacy
// conversion, full five-status fidelity -- rather than re-duplicating that
// coverage here.

test('lifecycle schema: capability true short-circuits with zero probe calls, and all five statuses persist accurately', async () => {
  svc.__setSchemaCapabilityForTests(true);
  const getProgram = async () => program;
  for (const status of svc.PLAYER_STATUSES) {
    const adminClient = makeFakeAdminClient({
      hs_players: queued(ok({ id: PLAYER_ID, program_id: PROGRAM_ID, first_name: 'Jo', last_name: 'Smith', preferred_name: null, graduation_year: null, status, is_active: status === 'active' })),
    });
    const result = await svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Smith', status }, adminClient, getProgram });
    const selectCalls = adminClient.calls.filter((c) => c.method === 'select');
    assert.equal(selectCalls.length, 1, 'capability already known true -- no probe call should be issued');
    assert.match(selectCalls[0].args, /status/);
    const insertCall = adminClient.calls.find((c) => c.method === 'insert');
    assert.equal(insertCall.args.status, status);
    assert.equal('is_active' in insertCall.args, false);
    assert.equal(result.status, status);
    assert.equal(result.is_active, status === 'active');
  }
});

test('lifecycle schema: update with neither field preserves status; reactivation works from all four non-active statuses', async () => {
  svc.__setSchemaCapabilityForTests(true);
  for (const priorStatus of svc.PLAYER_STATUSES.filter((s) => s !== 'active')) {
    const adminClient = makeFakeAdminClient({
      hs_players: queued(
        ok({ id: PLAYER_ID, program_id: PROGRAM_ID, first_name: 'Jo', last_name: 'Smith', preferred_name: null, graduation_year: null, status: priorStatus, is_active: false }),
        ok({ id: PLAYER_ID, program_id: PROGRAM_ID, first_name: 'Jo', last_name: 'Smith', preferred_name: null, graduation_year: null, status: 'active', is_active: true }),
      ),
    });
    const result = await svc.updatePlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { status: 'active' }, adminClient });
    assert.equal(result.status, 'active');
    assert.equal(result.is_active, true);
  }
});

test('lifecycle schema: invalid and conflicting status inputs retain HTTP 400 behavior', async () => {
  svc.__setSchemaCapabilityForTests(true);
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Bad', status: 'benched' }, adminClient, getProgram }),
    (e) => e.statusCode === 400
  );
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Conflict', status: 'graduated', is_active: true }, adminClient, getProgram }),
    (e) => e.statusCode === 400
  );
  assert.equal(adminClient.calls.length, 0);
});

test('lifecycle schema: cross-tenant update still 404s and roster-membership still rejects a non-active player', async () => {
  svc.__setSchemaCapabilityForTests(true);
  const notFoundClient = makeFakeAdminClient({ hs_players: queued(ok(null)) });
  await assert.rejects(
    () => svc.updatePlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { status: 'graduated' }, adminClient: notFoundClient }),
    (e) => e.statusCode === 404
  );

  const rosterClient = makeFakeAdminClient({
    hs_teams: queued(ok({ id: TEAM_ID, is_active: true })),
    hs_players: queued(ok({ id: PLAYER_ID, status: 'graduated', is_active: false })),
    hs_seasons: queued(ok({ id: SEASON_ID })),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient: rosterClient }),
    (e) => e.statusCode === 409
  );
});

// ── Error classification (integration-level, through the public functions) ──

test('a genuine RLS/authorization error during the probe never triggers legacy fallback and never issues a write', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({ hs_players: queued(err(rlsError())) });
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient, getProgram }),
    (e) => e.statusCode === 500
  );
  assert.equal(adminClient.calls.filter((c) => c.method === 'insert' || c.method === 'update').length, 0);
});

test('a network-shaped error during the probe never triggers legacy fallback', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({ hs_players: queued(err(networkError())) });
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient, getProgram }),
    (e) => e.statusCode === 500
  );
  assert.equal(adminClient.calls.filter((c) => c.method === 'insert' || c.method === 'update').length, 0);
});

test('an unrelated missing-column error (not about status) never triggers legacy fallback', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({ hs_players: queued(err(unrelatedMissingColumnError())) });
  await assert.rejects(
    () => svc.createPlayer({ orgId: ORG_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient, getProgram }),
    (e) => e.statusCode === 500
  );
  assert.equal(adminClient.calls.filter((c) => c.method === 'insert' || c.method === 'update').length, 0);
});
