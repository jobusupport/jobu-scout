'use strict';

// Database-free tests for src/opponent-roster-service.js. Mirrors
// test/high-school-roster-service.test.js's established pattern: the
// ACTUAL validation/orchestration functions run here, with only the
// injected I/O point (a fake adminClient) mocked.
//
// Run with: node --test test/opponent-roster-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/opponent-roster-service');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER2_ID = '44444444-4444-4444-8444-444444444444';
const MEMBERSHIP_ID = '55555555-5555-4555-8555-555555555555';

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
      is: () => builder,
      select: () => builder,
      insert: (payload) => { calls.push({ table, method: 'insert', args: payload }); return builder; },
      update: (payload) => { calls.push({ table, method: 'update', args: payload }); return builder; },
      delete: () => { calls.push({ table, method: 'delete', args: null }); return builder; },
      single: () => Promise.resolve(consume(table)),
      maybeSingle: () => Promise.resolve(consume(table)),
      then: (resolve) => resolve(consume(table)),
    };
    return builder;
  }
  return { calls, from: (table) => builderFor(table) };
}

function queued(...results) { return results; }
function ok(data) { return { data, error: null }; }
function err(error) { return { data: null, error }; }

const team = { id: TEAM_ID, org_id: ORG_ID, team_name: 'Rival Nine', is_our_team: false };

function playerRow({ id = PLAYER_ID, status = 'active', confirmed_fields = [], ...rest } = {}) {
  return {
    id, team_id: TEAM_ID, first_name: 'Jo', last_name: 'Smith',
    positions: [], bats: null, throws: null, class_or_grad_year: null,
    status, record_source: 'manual', confirmed_fields, gc_match_status: null,
    last_observed_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...rest,
  };
}

// ── Validation: identity/jersey separation ───────────────────────────────

test('validateOpponentPlayerCreate rejects a jersey_number field as unknown (proves jersey is never accepted here)', () => {
  assert.throws(() => svc.validateOpponentPlayerCreate({ first_name: 'Jo', last_name: 'Smith', jersey_number: '7' }), /Unknown field/);
});

test('validateOpponentPlayerCreate requires first_name and last_name', () => {
  assert.throws(() => svc.validateOpponentPlayerCreate({ last_name: 'Smith' }), /first_name is required/);
  assert.throws(() => svc.validateOpponentPlayerCreate({ first_name: 'Jo' }), /last_name is required/);
});

test('validateOpponentPlayerCreate defaults status to active and accepts each of the five statuses', () => {
  const defaulted = svc.validateOpponentPlayerCreate({ first_name: 'Jo', last_name: 'Smith' });
  assert.equal(defaulted.status, 'active');
  for (const status of svc.OPPONENT_PLAYER_STATUSES) {
    const result = svc.validateOpponentPlayerCreate({ first_name: 'Jo', last_name: 'Smith', status });
    assert.equal(result.status, status);
  }
});

test('validateOpponentPlayerCreate rejects an invalid status, bats, or throws value', () => {
  assert.throws(() => svc.validateOpponentPlayerCreate({ first_name: 'Jo', last_name: 'Smith', status: 'cut' }), /status must be one of/);
  assert.throws(() => svc.validateOpponentPlayerCreate({ first_name: 'Jo', last_name: 'Smith', bats: 'X' }), /bats must be one of/);
  assert.throws(() => svc.validateOpponentPlayerCreate({ first_name: 'Jo', last_name: 'Smith', throws: 'X' }), /throws must be one of/);
});

// ── Orchestration: create/update/list ────────────────────────────────────

test('createOpponentPlayer 404s when the team does not exist in this org', async () => {
  const adminClient = makeFakeAdminClient({ teams: queued(ok(null)) });
  await assert.rejects(
    () => svc.createOpponentPlayer({ orgId: ORG_ID, teamId: TEAM_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient }),
    (e) => e.statusCode === 404
  );
});

test('createOpponentPlayer never writes jersey_number, and starts with empty confirmed_fields', async () => {
  const adminClient = makeFakeAdminClient({
    teams: queued(ok(team)),
    opponent_players: queued(ok(playerRow())),
  });
  await svc.createOpponentPlayer({ orgId: ORG_ID, teamId: TEAM_ID, body: { first_name: 'Jo', last_name: 'Smith' }, adminClient });
  const insertCall = adminClient.calls.find((c) => c.table === 'opponent_players' && c.method === 'insert');
  assert.equal('jersey_number' in insertCall.args, false);
  assert.equal(insertCall.args.record_source, 'manual');
});

test('updateOpponentPlayer (coach edit) writes the patch AND adds each touched field to confirmed_fields', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(
      ok(playerRow({ confirmed_fields: [] })), // getOpponentPlayerInOrg
      ok(playerRow({ first_name: 'Joseph', confirmed_fields: ['first_name'] })),
    ),
  });
  const result = await svc.updateOpponentPlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { first_name: 'Joseph' }, adminClient });
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.deepEqual(updateCall.args.confirmed_fields, ['first_name']);
  assert.equal(result.first_name, 'Joseph');
});

test('updateOpponentPlayer accumulates confirmed_fields across multiple edits without losing prior confirmations', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(
      ok(playerRow({ confirmed_fields: ['first_name'] })),
      ok(playerRow({ confirmed_fields: ['first_name', 'last_name'] })),
    ),
  });
  await svc.updateOpponentPlayer({ orgId: ORG_ID, playerId: PLAYER_ID, body: { last_name: 'Jones' }, adminClient });
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.deepEqual(updateCall.args.confirmed_fields.sort(), ['first_name', 'last_name']);
});

test('updateOpponentPlayer returns 404 for a player belonging to another organization', async () => {
  const adminClient = makeFakeAdminClient({ opponent_players: queued(ok(null)) });
  await assert.rejects(
    () => svc.updateOpponentPlayer({ orgId: OTHER_ORG_ID, playerId: PLAYER_ID, body: { first_name: 'X' }, adminClient }),
    (e) => e.statusCode === 404
  );
});

// ── Import-facing writes: confirmed-field protection + conflict recording ─

test('applyImportedOpponentPlayerData never overwrites a confirmed field, and records a conflict when the imported value differs', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(
      ok(playerRow({ first_name: 'Jo', confirmed_fields: ['first_name'] })), // getOpponentPlayerInOrg
      ok(playerRow({ first_name: 'Jo', confirmed_fields: ['first_name'] })), // the update (first_name untouched)
    ),
    opponent_roster_import_conflicts: queued(ok([{ id: 'c1', field_name: 'first_name', coach_confirmed_value: 'Jo', imported_value: 'Joseph', source: 'gamechanger', detected_at: '2026-01-01T00:00:00Z' }])),
  });
  const { data, conflicts } = await svc.applyImportedOpponentPlayerData({
    orgId: ORG_ID, playerId: PLAYER_ID, importedFields: { first_name: 'Joseph' }, source: 'gamechanger', adminClient,
  });
  const updateCall = adminClient.calls.find((c) => c.table === 'opponent_players' && c.method === 'update');
  assert.equal('first_name' in updateCall.args, false, 'a confirmed field must never appear in the import update payload');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field_name, 'first_name');
  const conflictInsertCall = adminClient.calls.find((c) => c.table === 'opponent_roster_import_conflicts');
  assert.equal(conflictInsertCall.args[0].coach_confirmed_value, 'Jo');
  assert.equal(conflictInsertCall.args[0].imported_value, 'Joseph');
});

test('applyImportedOpponentPlayerData writes an UNconfirmed field normally and records no conflict', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(
      ok(playerRow({ positions: [], confirmed_fields: [] })),
      ok(playerRow({ positions: ['SS'], confirmed_fields: [] })),
    ),
  });
  const { conflicts } = await svc.applyImportedOpponentPlayerData({
    orgId: ORG_ID, playerId: PLAYER_ID, importedFields: { positions: ['SS'] }, source: 'gamechanger', adminClient,
  });
  const updateCall = adminClient.calls.find((c) => c.table === 'opponent_players' && c.method === 'update');
  assert.deepEqual(updateCall.args.positions, ['SS']);
  assert.equal(conflicts.length, 0);
});

test('applyImportedOpponentPlayerData records no conflict when the imported value agrees with the confirmed value', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(
      ok(playerRow({ first_name: 'Jo', confirmed_fields: ['first_name'] })),
      ok(playerRow({ first_name: 'Jo', confirmed_fields: ['first_name'] })),
    ),
  });
  const { conflicts } = await svc.applyImportedOpponentPlayerData({
    orgId: ORG_ID, playerId: PLAYER_ID, importedFields: { first_name: 'Jo' }, source: 'gamechanger', adminClient,
  });
  assert.equal(conflicts.length, 0);
  assert.equal(adminClient.calls.some((c) => c.table === 'opponent_roster_import_conflicts'), false);
});

// ── Merge duplicate players ───────────────────────────────────────────────

test('mergeOpponentPlayers rejects merging a player into itself', async () => {
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.mergeOpponentPlayers({ orgId: ORG_ID, keepPlayerId: PLAYER_ID, mergePlayerId: PLAYER_ID, adminClient }),
    (e) => e.statusCode === 400
  );
});

test('mergeOpponentPlayers reassigns memberships and notes, unions confirmed_fields, then deletes the duplicate', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(
      ok(playerRow({ id: PLAYER_ID, confirmed_fields: ['first_name'] })),   // keepPlayer lookup
      ok(playerRow({ id: PLAYER2_ID, confirmed_fields: ['last_name'] })),   // mergePlayer lookup
      ok(null), // confirmed_fields union update (bare await, no .single())
      ok(null), // delete (bare await, no .single())
      ok(playerRow({ id: PLAYER_ID, confirmed_fields: ['first_name', 'last_name'] })), // final re-fetch
    ),
    opponent_roster_memberships: { data: [], error: null },
    coach_scouting_notes: { data: [], error: null },
  });
  const result = await svc.mergeOpponentPlayers({ orgId: ORG_ID, keepPlayerId: PLAYER_ID, mergePlayerId: PLAYER2_ID, adminClient });
  assert.equal(result.id, PLAYER_ID);
  const membershipReassign = adminClient.calls.find((c) => c.table === 'opponent_roster_memberships' && c.method === 'update');
  assert.equal(membershipReassign.args.opponent_player_id, PLAYER_ID);
  const noteReassign = adminClient.calls.find((c) => c.table === 'coach_scouting_notes' && c.method === 'update');
  assert.equal(noteReassign.args.opponent_player_id, PLAYER_ID);
  const deleteCall = adminClient.calls.find((c) => c.table === 'opponent_players' && c.method === 'delete');
  assert.ok(deleteCall, 'the duplicate player must be deleted after reassignment');
});

// ── Roster memberships: jersey changes, tenant predicates ────────────────

test('addOpponentRosterMembership 404s when the player or team does not exist in this org', async () => {
  const adminClient = makeFakeAdminClient({ opponent_players: queued(ok(null)), teams: queued(ok(team)) });
  await assert.rejects(
    () => svc.addOpponentRosterMembership({ orgId: ORG_ID, playerId: PLAYER_ID, teamId: TEAM_ID, body: { jersey_number: '7' }, adminClient }),
    (e) => e.statusCode === 404
  );
});

test('addOpponentRosterMembership stores jersey_number on the membership, not the player', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(ok(playerRow())),
    teams: queued(ok(team)),
    opponent_roster_memberships: queued(ok({ id: MEMBERSHIP_ID, opponent_player_id: PLAYER_ID, team_id: TEAM_ID, jersey_number: '7', season_label: null, status: 'active', record_source: 'manual', first_observed_at: '2026-01-01', last_observed_at: '2026-01-01', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })),
  });
  const membership = await svc.addOpponentRosterMembership({ orgId: ORG_ID, playerId: PLAYER_ID, teamId: TEAM_ID, body: { jersey_number: '7' }, adminClient });
  assert.equal(membership.jersey_number, '7');
  const insertCall = adminClient.calls.find((c) => c.table === 'opponent_roster_memberships' && c.method === 'insert');
  assert.equal(insertCall.args.jersey_number, '7');
});

test('updateOpponentRosterMembership can change jersey_number without creating a new player (a jersey change is never treated as a new identity)', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_roster_memberships: queued(
      ok({ id: MEMBERSHIP_ID, opponent_player_id: PLAYER_ID, team_id: TEAM_ID, jersey_number: '7', season_label: null, status: 'active' }),
      ok({ id: MEMBERSHIP_ID, opponent_player_id: PLAYER_ID, team_id: TEAM_ID, jersey_number: '23', season_label: null, status: 'active' }),
    ),
  });
  const result = await svc.updateOpponentRosterMembership({ orgId: ORG_ID, membershipId: MEMBERSHIP_ID, body: { jersey_number: '23' }, adminClient });
  assert.equal(result.jersey_number, '23');
  assert.equal(result.opponent_player_id, PLAYER_ID, 'same player identity, jersey changed underneath it');
});

test('removeOpponentRosterMembership soft-deletes (status=inactive), never a DELETE call', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_roster_memberships: queued(
      ok({ id: MEMBERSHIP_ID, status: 'active' }),
      ok({ id: MEMBERSHIP_ID, status: 'inactive' }),
    ),
  });
  const result = await svc.removeOpponentRosterMembership({ orgId: ORG_ID, membershipId: MEMBERSHIP_ID, adminClient });
  assert.equal(result.status, 'inactive');
  assert.equal(adminClient.calls.some((c) => c.table === 'opponent_roster_memberships' && c.method === 'delete'), false);
});

test('removeOpponentRosterMembership returns 404 for a membership belonging to another org', async () => {
  const adminClient = makeFakeAdminClient({ opponent_roster_memberships: queued(ok(null)) });
  await assert.rejects(
    () => svc.removeOpponentRosterMembership({ orgId: OTHER_ORG_ID, membershipId: MEMBERSHIP_ID, adminClient }),
    (e) => e.statusCode === 404
  );
});

// ── Combined roster view (identity + current jersey) ─────────────────────

test('listOpponentRosterForTeam attaches each player\'s most recent ACTIVE membership as .membership, ignoring inactive ones', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(ok([playerRow({ id: PLAYER_ID })])),
    opponent_roster_memberships: queued(ok([
      { id: 'm1', opponent_player_id: PLAYER_ID, team_id: TEAM_ID, jersey_number: '7', season_label: '2025', status: 'inactive', last_observed_at: '2025-01-01' },
      { id: 'm2', opponent_player_id: PLAYER_ID, team_id: TEAM_ID, jersey_number: '23', season_label: '2026', status: 'active', last_observed_at: '2026-01-01' },
    ])),
  });
  const roster = await svc.listOpponentRosterForTeam({ orgId: ORG_ID, teamId: TEAM_ID, adminClient });
  assert.equal(roster.length, 1);
  assert.equal(roster[0].membership.jersey_number, '23');
});

test('listOpponentRosterForTeam includes a player with no membership yet as membership: null', async () => {
  const adminClient = makeFakeAdminClient({
    opponent_players: queued(ok([playerRow({ id: PLAYER_ID })])),
    opponent_roster_memberships: queued(ok([])),
  });
  const roster = await svc.listOpponentRosterForTeam({ orgId: ORG_ID, teamId: TEAM_ID, adminClient });
  assert.equal(roster[0].membership, null);
});

// ── Import conflict resolution ────────────────────────────────────────────

test('resolveImportConflict requires a valid resolution value', () => {
  assert.throws(() => svc.validateResolution({}), /resolution is required/);
  assert.throws(() => svc.validateResolution({ resolution: 'maybe' }), /resolution must be one of/);
});

test('resolveImportConflict marks the conflict resolved with a timestamp', async () => {
  const CONFLICT_ID = '66666666-6666-4666-8666-666666666666';
  const adminClient = makeFakeAdminClient({
    opponent_roster_import_conflicts: queued(ok({ id: CONFLICT_ID, field_name: 'first_name', resolved_at: '2026-02-01T00:00:00Z', resolution: 'kept_coach_value' })),
  });
  const result = await svc.resolveImportConflict({ orgId: ORG_ID, conflictId: CONFLICT_ID, body: { resolution: 'kept_coach_value' }, adminClient });
  assert.equal(result.resolution, 'kept_coach_value');
  assert.ok(result.resolved_at);
});
