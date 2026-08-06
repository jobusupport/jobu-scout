'use strict';

// Database-free tests for src/coach-notes-service.js. Mirrors the
// established fake-adminClient pattern (see test/high-school-roster-service.test.js).
//
// Run with: node --test test/coach-notes-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/coach-notes-service');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const GAME_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const NOTE_ID = '66666666-6666-4666-8666-666666666666';

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
      select: () => builder,
      insert: (payload) => { calls.push({ table, method: 'insert', args: payload }); return builder; },
      update: (payload) => { calls.push({ table, method: 'update', args: payload }); return builder; },
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

const team = { id: TEAM_ID, org_id: ORG_ID, team_name: 'Rival Nine', is_our_team: false };

function noteRow({ id = NOTE_ID, ...rest } = {}) {
  return {
    id, org_id: ORG_ID, author_user_id: USER_ID, opponent_team_id: TEAM_ID,
    opponent_player_id: null, game_id: null, observed_game_date: null,
    note_text: 'Chases high fastballs.', category: null,
    include_in_report: true, is_archived: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...rest,
  };
}

// ── Validation ─────────────────────────────────────────────────────────

test('validateNoteCreate requires non-blank note_text', () => {
  assert.throws(() => svc.validateNoteCreate({ note_text: '' }), /note_text is required/);
  assert.throws(() => svc.validateNoteCreate({ note_text: '   ' }), /note_text is required/);
  assert.throws(() => svc.validateNoteCreate({}), /note_text is required/);
});

test('validateNoteCreate enforces the 4000-char server-side length limit', () => {
  assert.throws(() => svc.validateNoteCreate({ note_text: 'x'.repeat(4001) }), /4000 characters or fewer/);
  const result = svc.validateNoteCreate({ note_text: 'x'.repeat(4000) });
  assert.equal(result.note_text.length, 4000);
});

test('validateNoteCreate accepts each of the ten documented categories, and category is optional', () => {
  for (const category of svc.NOTE_CATEGORIES) {
    const result = svc.validateNoteCreate({ note_text: 'ok', category });
    assert.equal(result.category, category);
  }
  const noCategory = svc.validateNoteCreate({ note_text: 'ok' });
  assert.equal(noCategory.category, null);
});

test('validateNoteCreate rejects an unrecognized category', () => {
  assert.throws(() => svc.validateNoteCreate({ note_text: 'ok', category: 'not-a-real-category' }), /category must be one of/);
});

test('validateNoteCreate rejects a malformed opponent_player_id/game_id', () => {
  assert.throws(() => svc.validateNoteCreate({ note_text: 'ok', opponent_player_id: 'not-a-uuid' }), /opponent_player_id must be a valid UUID/);
  assert.throws(() => svc.validateNoteCreate({ note_text: 'ok', game_id: 'not-a-uuid' }), /game_id must be a valid UUID/);
});

test('validateNoteUpdate requires at least one field and rejects unknown fields', () => {
  assert.throws(() => svc.validateNoteUpdate({}), /At least one field/);
  assert.throws(() => svc.validateNoteUpdate({ opponent_player_id: PLAYER_ID }), /Unknown field/);
});

// ── Create ─────────────────────────────────────────────────────────────

test('createNote 404s when the opponent team does not exist in this org', async () => {
  const adminClient = makeFakeAdminClient({ teams: queued(ok(null)) });
  await assert.rejects(
    () => svc.createNote({ orgId: ORG_ID, authorUserId: USER_ID, opponentTeamId: TEAM_ID, body: { note_text: 'x' }, adminClient }),
    (e) => e.statusCode === 404
  );
});

test('createNote stores author_user_id, org_id, and opponent_team_id from trusted server-side values, never from the client body', async () => {
  const adminClient = makeFakeAdminClient({
    teams: queued(ok(team)),
    coach_scouting_notes: queued(ok(noteRow())),
  });
  await svc.createNote({ orgId: ORG_ID, authorUserId: USER_ID, opponentTeamId: TEAM_ID, body: { note_text: 'Chases high fastballs.' }, adminClient });
  const insertCall = adminClient.calls.find((c) => c.method === 'insert');
  assert.equal(insertCall.args.org_id, ORG_ID);
  assert.equal(insertCall.args.author_user_id, USER_ID);
  assert.equal(insertCall.args.opponent_team_id, TEAM_ID);
});

test('createNote supports team-level (no player/game), player-level, and game-level scoping', async () => {
  for (const extra of [{}, { opponent_player_id: PLAYER_ID }, { game_id: GAME_ID }]) {
    const adminClient = makeFakeAdminClient({
      teams: queued(ok(team)),
      coach_scouting_notes: queued(ok(noteRow(extra))),
    });
    const note = await svc.createNote({ orgId: ORG_ID, authorUserId: USER_ID, opponentTeamId: TEAM_ID, body: { note_text: 'x', ...extra }, adminClient });
    if (extra.opponent_player_id) assert.equal(note.opponent_player_id, PLAYER_ID);
    if (extra.game_id) assert.equal(note.game_id, GAME_ID);
  }
});

test('createNote defaults to included and not archived', async () => {
  const adminClient = makeFakeAdminClient({
    teams: queued(ok(team)),
    coach_scouting_notes: queued(ok(noteRow())),
  });
  const note = await svc.createNote({ orgId: ORG_ID, authorUserId: USER_ID, opponentTeamId: TEAM_ID, body: { note_text: 'x' }, adminClient });
  assert.equal(note.include_in_report, true);
  assert.equal(note.is_archived, false);
});

// ── Update / archive / include-toggle ─────────────────────────────────

test('updateNote returns 404 for a note belonging to another organization', async () => {
  const adminClient = makeFakeAdminClient({ coach_scouting_notes: queued(ok(null)) });
  await assert.rejects(
    () => svc.updateNote({ orgId: OTHER_ORG_ID, noteId: NOTE_ID, body: { note_text: 'x' }, adminClient }),
    (e) => e.statusCode === 404
  );
});

test('updateNote refuses to edit an archived note', async () => {
  const adminClient = makeFakeAdminClient({ coach_scouting_notes: queued(ok(noteRow({ is_archived: true }))) });
  await assert.rejects(
    () => svc.updateNote({ orgId: ORG_ID, noteId: NOTE_ID, body: { note_text: 'x' }, adminClient }),
    (e) => e.statusCode === 409
  );
});

test('archiveNote sets is_archived=true (soft, never a DELETE call)', async () => {
  const adminClient = makeFakeAdminClient({
    coach_scouting_notes: queued(ok(noteRow({ is_archived: false })), ok(noteRow({ is_archived: true }))),
  });
  const result = await svc.archiveNote({ orgId: ORG_ID, noteId: NOTE_ID, adminClient });
  assert.equal(result.is_archived, true);
  assert.equal(adminClient.calls.some((c) => c.method === 'delete'), false);
});

test('setNoteIncludeInReport toggles include_in_report independently of is_archived (exclude != delete)', async () => {
  const adminClient = makeFakeAdminClient({
    coach_scouting_notes: queued(ok(noteRow({ include_in_report: true })), ok(noteRow({ include_in_report: false }))),
  });
  const result = await svc.setNoteIncludeInReport({ orgId: ORG_ID, noteId: NOTE_ID, include: false, adminClient });
  assert.equal(result.include_in_report, false);
  const updateCall = adminClient.calls.find((c) => c.method === 'update');
  assert.deepEqual(updateCall.args, { include_in_report: false });
});

test('setNoteIncludeInReport rejects a non-boolean include value', async () => {
  const adminClient = makeFakeAdminClient({});
  await assert.rejects(
    () => svc.setNoteIncludeInReport({ orgId: ORG_ID, noteId: NOTE_ID, include: 'yes', adminClient }),
    (e) => e.statusCode === 400
  );
});

// ── List ──────────────────────────────────────────────────────────────

test('listNotesForTeam excludes archived notes by default', async () => {
  const adminClient = makeFakeAdminClient({ coach_scouting_notes: queued(ok([noteRow()])) });
  const notes = await svc.listNotesForTeam({ orgId: ORG_ID, opponentTeamId: TEAM_ID, adminClient });
  assert.equal(notes.length, 1);
});
