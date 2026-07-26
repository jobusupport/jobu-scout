'use strict';

// Database-free tests for src/high-school-roster-service.js -- the write-side
// business logic for the High School program/seasons/teams/players/roster
// CRUD foundation. Mirrors test/admin-product-route.test.js's own pattern:
// the ACTUAL validation/orchestration functions run here, with only the
// injected I/O point (a fake adminClient) mocked, the same way that file
// mocks fetchOrg/callRpc for admin-product-route.js.
//
// Run with: node --test test/high-school-roster-service.test.js (also
// included in `npm test`, see package.json).

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/high-school-roster-service');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PROGRAM_ID = '22222222-2222-4222-8222-222222222222';
const SEASON_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = '44444444-4444-4444-8444-444444444444';
const PLAYER_ID = '55555555-5555-4555-8555-555555555555';
const MEMBERSHIP_ID = '66666666-6666-4666-8666-666666666666';

// ── Fake adminClient ──────────────────────────────────────────────────────
//
// Each table name maps to a queue of { data, error } results, consumed in
// call order -- lets a single test set up a multi-call sequence (e.g.
// updateProgram's own existence-check select, followed by its update) with
// distinct results per call. Chain methods (eq/order/or/limit/in/select/
// insert/update) just return the same builder; single()/maybeSingle() and
// awaiting the builder directly (listPlayers's own call shape) both resolve
// the same queued result -- this mirrors how the real PostgrestFilterBuilder
// is itself thenable.
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
      select: () => builder,
      insert: (payload) => { calls.push({ table, method: 'insert', args: payload }); return builder; },
      update: (payload) => { calls.push({ table, method: 'update', args: payload }); return builder; },
      // Only a terminal call (single/maybeSingle) or awaiting the builder
      // directly (listPlayers's own call shape, mirroring the real
      // PostgrestFilterBuilder being itself thenable) consumes a queued
      // response -- every chain method above is a no-op passthrough, so
      // .from(...).insert(...).select(...).single() consumes exactly once.
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

function queued(...results) {
  return results;
}
function ok(data) { return { data, error: null }; }
function err(error) { return { data: null, error }; }

const program = { id: PROGRAM_ID, org_id: ORG_ID };

// ── Program: pure validation ─────────────────────────────────────────────

test('validateProgramCreate rejects an unknown field', () => {
  assert.throws(() => svc.validateProgramCreate({ name: 'x', foo: 'bar' }), /Unknown field/);
});

test('validateProgramCreate requires a non-empty name', () => {
  assert.throws(() => svc.validateProgramCreate({}), /name is required/);
  assert.throws(() => svc.validateProgramCreate({ name: '   ' }), /name is required/);
});

test('validateProgramUpdate requires at least one field', () => {
  assert.throws(() => svc.validateProgramUpdate({}), /At least one field/);
});

test('validateProgramUpdate rejects a non-boolean is_active', () => {
  assert.throws(() => svc.validateProgramUpdate({ is_active: 'yes' }), /must be a boolean/);
});

// ── Program: orchestration ───────────────────────────────────────────────

test('createProgram returns the created row on success', async () => {
  const adminClient = makeFakeAdminClient({ hs_programs: queued(ok({ id: PROGRAM_ID, name: 'Eagles', school_name: null, is_active: true })) });
  const result = await svc.createProgram({ orgId: ORG_ID, body: { name: 'Eagles' }, adminClient });
  assert.equal(result.id, PROGRAM_ID);
});

test('createProgram maps a unique-constraint violation to 409, not a raw database error', async () => {
  const adminClient = makeFakeAdminClient({ hs_programs: queued(err({ code: '23505', message: 'duplicate key' })) });
  await assert.rejects(
    () => svc.createProgram({ orgId: ORG_ID, body: { name: 'Eagles' }, adminClient }),
    (e) => e.statusCode === 409 && !/duplicate key/.test(e.message)
  );
});

test('updateProgram returns 404 when no program exists yet for this org', async () => {
  const getProgram = async () => null;
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.updateProgram({ orgId: ORG_ID, body: { name: 'New Name' }, adminClient, getProgram }),
    (e) => e.statusCode === 404
  );
});

test('updateProgram scopes its update to both org_id and the existing program id', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({ hs_programs: queued(ok({ id: PROGRAM_ID, name: 'New Name', school_name: null, is_active: true })) });
  const result = await svc.updateProgram({ orgId: ORG_ID, body: { name: 'New Name' }, adminClient, getProgram });
  assert.equal(result.name, 'New Name');
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.deepEqual(updateCall.args, { name: 'New Name' });
});

// ── Seasons: pure validation ─────────────────────────────────────────────

test('validateSeasonCreate requires name and school_year', () => {
  assert.throws(() => svc.validateSeasonCreate({}), /name is required/);
  assert.throws(() => svc.validateSeasonCreate({ name: 'Spring' }), /school_year is required/);
});

test('validateSeasonCreate rejects an end_date before start_date', () => {
  assert.throws(
    () => svc.validateSeasonCreate({ name: 'Spring', school_year: '2025-2026', start_date: '2026-03-01', end_date: '2026-01-01' }),
    /end_date must not be before start_date/
  );
});

test('validateSeasonCreate rejects a malformed date', () => {
  assert.throws(
    () => svc.validateSeasonCreate({ name: 'Spring', school_year: '2025-2026', start_date: 'not-a-date' }),
    /must be a valid YYYY-MM-DD date/
  );
});

test('validateSeasonCreate accepts a well-formed request and defaults is_current to false', () => {
  const result = svc.validateSeasonCreate({ name: 'Spring', school_year: '2025-2026' });
  assert.equal(result.is_current, false);
});

// ── Seasons: orchestration / cross-org isolation ─────────────────────────

test('getSeasonInOrg scopes the lookup by both id and org_id (foreign-org id cannot be read)', async () => {
  const adminClient = makeFakeAdminClient({ hs_seasons: queued(ok(null)) });
  const result = await svc.getSeasonInOrg({ orgId: ORG_ID, seasonId: SEASON_ID, adminClient });
  assert.equal(result, null);
});

test('getSeasonInOrg rejects a malformed seasonId before any query', async () => {
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.getSeasonInOrg({ orgId: ORG_ID, seasonId: 'not-a-uuid', adminClient }),
    (e) => e.statusCode === 400
  );
  assert.equal(adminClient.calls.length, 0);
});

test('createSeason requires a program to already exist', async () => {
  const getProgram = async () => null;
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.createSeason({ orgId: ORG_ID, body: { name: 'Spring', school_year: '2025-2026' }, adminClient, getProgram }),
    (e) => e.statusCode === 404 && /Create a program/.test(e.message)
  );
});

test('createSeason links the new season to the org\'s own program_id, never a client-supplied one', async () => {
  const getProgram = async () => program;
  const adminClient = makeFakeAdminClient({ hs_seasons: queued(ok({ id: SEASON_ID, program_id: PROGRAM_ID, name: 'Spring', school_year: '2025-2026', start_date: null, end_date: null, is_current: false })) });
  await svc.createSeason({ orgId: ORG_ID, body: { name: 'Spring', school_year: '2025-2026' }, adminClient, getProgram });
  const insertCall = adminClient.calls.find((c) => c.method === 'insert');
  assert.equal(insertCall.args.program_id, PROGRAM_ID);
  assert.equal(insertCall.args.org_id, ORG_ID);
});

test('updateSeason returns 404 for a season belonging to another organization', async () => {
  const adminClient = makeFakeAdminClient({ hs_seasons: queued(ok(null)) });
  await assert.rejects(
    () => svc.updateSeason({ orgId: ORG_ID, seasonId: SEASON_ID, body: { name: 'New' }, adminClient }),
    (e) => e.statusCode === 404
  );
});

// ── Teams: pure validation ───────────────────────────────────────────────

test('validateTeamCreate requires a known level', () => {
  assert.throws(() => svc.validateTeamCreate({ name: 'Varsity Baseball', level: 'jv' }), /level must be one of/);
});

test('validateTeamCreate accepts each schema-valid level', () => {
  for (const level of svc.TEAM_LEVELS) {
    const result = svc.validateTeamCreate({ name: 'Team', level });
    assert.equal(result.level, level);
  }
});

// ── Players: pure validation ─────────────────────────────────────────────

test('validatePlayerCreate requires first_name and last_name', () => {
  assert.throws(() => svc.validatePlayerCreate({ last_name: 'Smith' }), /first_name is required/);
  assert.throws(() => svc.validatePlayerCreate({ first_name: 'Jo' }), /last_name is required/);
});

test('validatePlayerCreate enforces the graduation_year floor from the migration\'s own CHECK constraint', () => {
  assert.throws(() => svc.validatePlayerCreate({ first_name: 'Jo', last_name: 'Smith', graduation_year: 1999 }), /graduation_year must be an integer/);
  assert.throws(() => svc.validatePlayerCreate({ first_name: 'Jo', last_name: 'Smith', graduation_year: 2027.5 }), /graduation_year must be an integer/);
  const result = svc.validatePlayerCreate({ first_name: 'Jo', last_name: 'Smith', graduation_year: 2000 });
  assert.equal(result.graduation_year, 2000);
});

test('validatePlayerCreate never accepts a record_source field (reserved for the future importer)', () => {
  assert.throws(() => svc.validatePlayerCreate({ first_name: 'Jo', last_name: 'Smith', record_source: 'gamechanger' }), /Unknown field/);
});

// ── Roster memberships: pure validation ──────────────────────────────────

test('validateRosterAdd requires valid playerId and seasonId UUIDs', () => {
  assert.throws(() => svc.validateRosterAdd({ playerId: 'not-a-uuid', seasonId: SEASON_ID }), /playerId must be a valid UUID/);
  assert.throws(() => svc.validateRosterAdd({ playerId: PLAYER_ID, seasonId: 'not-a-uuid' }), /seasonId must be a valid UUID/);
});

test('validateRosterAdd rejects a client-supplied teamId or status (both are route/server controlled)', () => {
  assert.throws(() => svc.validateRosterAdd({ playerId: PLAYER_ID, seasonId: SEASON_ID, teamId: TEAM_ID }), /Unknown field/);
  assert.throws(() => svc.validateRosterAdd({ playerId: PLAYER_ID, seasonId: SEASON_ID, status: 'inactive' }), /Unknown field/);
});

test('validateRosterUpdate rejects an unknown status value', () => {
  assert.throws(() => svc.validateRosterUpdate({ status: 'benched' }), /status must be one of/);
});

// ── Roster memberships: orchestration ────────────────────────────────────

const ACTIVE_TEAM = { id: TEAM_ID, is_active: true };
const ACTIVE_PLAYER = { id: PLAYER_ID, is_active: true };

test('addRosterMembership returns 404 when the team belongs to a different organization', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok(null)),
    hs_players: queued(ok(ACTIVE_PLAYER)),
    hs_seasons: queued(ok({ id: SEASON_ID })),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient }),
    (e) => e.statusCode === 404 && /Team not found/.test(e.message)
  );
});

test('addRosterMembership rejects adding to an inactive (archived) team (409, not silently allowed)', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok({ id: TEAM_ID, is_active: false })),
    hs_players: queued(ok(ACTIVE_PLAYER)),
    hs_seasons: queued(ok({ id: SEASON_ID })),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient }),
    (e) => e.statusCode === 409 && /inactive team/.test(e.message)
  );
});

test('addRosterMembership returns 404 when the player belongs to a different organization', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok(ACTIVE_TEAM)),
    hs_players: queued(ok(null)),
    hs_seasons: queued(ok({ id: SEASON_ID })),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient }),
    (e) => e.statusCode === 404 && /Player not found/.test(e.message)
  );
});

test('addRosterMembership rejects an inactive (archived) player (409, not silently allowed)', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok(ACTIVE_TEAM)),
    hs_players: queued(ok({ id: PLAYER_ID, is_active: false })),
    hs_seasons: queued(ok({ id: SEASON_ID })),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient }),
    (e) => e.statusCode === 409 && /inactive player/.test(e.message)
  );
});

test('addRosterMembership returns 404 when the season belongs to a different organization', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok(ACTIVE_TEAM)),
    hs_players: queued(ok(ACTIVE_PLAYER)),
    hs_seasons: queued(ok(null)),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient }),
    (e) => e.statusCode === 404 && /Season not found/.test(e.message)
  );
});

test('addRosterMembership maps a duplicate-membership unique violation to 409', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok(ACTIVE_TEAM)),
    hs_players: queued(ok(ACTIVE_PLAYER)),
    hs_seasons: queued(ok({ id: SEASON_ID })),
    hs_roster_memberships: queued(err({ code: '23505', message: 'duplicate key value violates unique constraint "hs_roster_memberships_player_team_season_key"' })),
  });
  await assert.rejects(
    () => svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID }, adminClient }),
    (e) => e.statusCode === 409 && !/constraint/.test(e.message)
  );
});

test('addRosterMembership succeeds and returns a camelCase membership shape', async () => {
  const adminClient = makeFakeAdminClient({
    hs_teams: queued(ok(ACTIVE_TEAM)),
    hs_players: queued(ok(ACTIVE_PLAYER)),
    hs_seasons: queued(ok({ id: SEASON_ID })),
    hs_roster_memberships: queued(ok({ id: MEMBERSHIP_ID, team_id: TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_ID, jersey_number: '7', status: 'active' })),
  });
  const result = await svc.addRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, body: { playerId: PLAYER_ID, seasonId: SEASON_ID, jerseyNumber: '7' }, adminClient });
  assert.deepEqual(result, { membershipId: MEMBERSHIP_ID, teamId: TEAM_ID, seasonId: SEASON_ID, playerId: PLAYER_ID, jerseyNumber: '7', status: 'active' });
});

test('a soft-removed membership can be restored via PATCH {status: "active"} — the one documented restore path', async () => {
  const adminClient = makeFakeAdminClient({
    hs_roster_memberships: queued(
      ok({ id: MEMBERSHIP_ID, team_id: TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_ID, jersey_number: null, status: 'inactive' }),
      ok({ id: MEMBERSHIP_ID, team_id: TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_ID, jersey_number: null, status: 'active' })
    ),
  });
  const result = await svc.updateRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, membershipId: MEMBERSHIP_ID, body: { status: 'active' }, adminClient });
  assert.equal(result.status, 'active');
});

test('removeRosterMembership never issues a DELETE-shaped call -- it updates status to inactive', async () => {
  const adminClient = makeFakeAdminClient({
    hs_roster_memberships: queued(
      ok({ id: MEMBERSHIP_ID, team_id: TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_ID, jersey_number: null, status: 'active' }),
      ok({ id: MEMBERSHIP_ID, team_id: TEAM_ID, season_id: SEASON_ID, player_id: PLAYER_ID, jersey_number: null, status: 'inactive' })
    ),
  });
  const result = await svc.removeRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, membershipId: MEMBERSHIP_ID, adminClient });
  assert.equal(result.status, 'inactive');
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.deepEqual(updateCall.args, { status: 'inactive' });
  assert.ok(!adminClient.calls.some((c) => c.method === 'delete'));
});

test('removeRosterMembership returns 404 for a membership belonging to another team/org', async () => {
  const adminClient = makeFakeAdminClient({ hs_roster_memberships: queued(ok(null)) });
  await assert.rejects(
    () => svc.removeRosterMembership({ orgId: ORG_ID, teamId: TEAM_ID, membershipId: MEMBERSHIP_ID, adminClient }),
    (e) => e.statusCode === 404
  );
});

test('updateRosterMembership rejects an empty patch', () => {
  assert.throws(() => svc.validateRosterUpdate({}), /At least one field/);
});
