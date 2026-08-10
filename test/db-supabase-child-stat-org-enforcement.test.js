'use strict';

// Security Slice T3K: genuine behavioral tests proving batting_lines,
// pitching_lines, play_events, player_advanced_stats, and
// pitcher_advanced_stats writes in src/db-supabase.js always carry the
// correct, authoritative-parent-derived org_id -- the runtime
// tableHasOrgId() capability probe that used to gate whether org_id was
// included at all has been removed from these five write paths (see
// each function's own T3K comment), since the live schema no longer has
// a state where these columns are missing, and the accompanying
// migration (supabase/migrations/20260810141738_enforce_org_id_not_null_
// on_child_stat_tables.sql) makes org_id NOT NULL at the database level.
//
// The REAL src/db-supabase.js module is exercised (not reimplemented) --
// only the @supabase/supabase-js client it constructs is replaced, via
// require.cache injection, the same technique
// test/db-supabase-tenant-isolation.test.js already uses. This fake
// models teams/games/batting_lines/pitching_lines/play_events/
// player_advanced_stats/pitcher_advanced_stats with just enough query
// surface (.select/.eq/.limit/.maybeSingle/.single/.insert/.upsert/
// .update/.delete) for the exercised functions, and models NO row-level
// security -- every query is answered in full, exactly like a real
// service-role connection, so a passing test proves isolation comes from
// db-supabase.js's own org_id derivation, never a database policy a
// service-role client bypasses anyway.
//
// Run with: node --test test/db-supabase-child-stat-org-enforcement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const SUPABASE_JS_PATH = require.resolve('@supabase/supabase-js');
const DB_SUPABASE_PATH = require.resolve('../src/db-supabase');

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}
let bigintCounter = 0;
function nextBigintId() {
  bigintCounter += 1;
  return bigintCounter;
}

class FakeQuery {
  constructor(rows, useBigintId, tableName, state) {
    this.rows = rows;
    this.useBigintId = useBigintId;
    this.tableName = tableName;
    this.state = state;
    this.filters = [];
    this.op = 'select';
    this.payload = null;
    this.singleMode = false;
    this.maybeSingleMode = false;
    this.onConflictCols = [];
    this._selectCols = null;
  }
  select(cols) { this._selectCols = cols; return this; }
  eq(col, val) { this.filters.push({ col, val }); return this; }
  in(col, vals) { this.filters.push({ col, val: vals, type: 'in' }); return this; }
  order() { return this; }
  limit(n) { this._limit = n; return this; }
  insert(rowOrRows) { this.op = 'insert'; this.payload = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]; return this; }
  upsert(row, opts = {}) {
    this.op = 'upsert';
    this.payload = row;
    this.onConflictCols = String(opts.onConflict || '').split(',').filter(Boolean);
    return this;
  }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  single() { this.singleMode = true; return this; }
  maybeSingle() { this.maybeSingleMode = true; return this; }
  _matches(row) {
    return this.filters.every((f) => {
      if (f.type === 'in') return f.val.includes(row[f.col]);
      return row[f.col] === f.val;
    });
  }
  then(resolve, reject) {
    return Promise.resolve(this._exec()).then(resolve, reject);
  }
  _exec() {
    // Simulates tableHasOrgId()'s exact live probe -- a `.select('org_id',
    // {count,head}).limit(1)` -- returning Postgres's real "column does
    // not exist" error shape, for tests proving a write path no longer
    // depends on this probe at all (see the T3K "never depends on the
    // capability probe" tests below).
    if (
      this.op === 'select' &&
      this._selectCols === 'org_id' &&
      this.state &&
      this.state._simulateMissingOrgIdColumn &&
      this.state._simulateMissingOrgIdColumn.has(this.tableName)
    ) {
      // Matches src/db-supabase.js#isMissingColumnError's exact check
      // (`message.includes('column org_id') && message.includes('does
      // not exist')`) -- the real shape a live Postgrest "unknown
      // column" error takes for this probe.
      return { data: null, error: { message: `column org_id does not exist on table ${this.tableName}` } };
    }
    if (this.op === 'insert') {
      const inserted = this.payload.map((p) => ({
        id: this.useBigintId ? nextBigintId() : nextId(),
        ...p,
      }));
      this.rows.push(...inserted);
      if (this.singleMode) return { data: inserted[0], error: null };
      return { data: inserted, error: null };
    }
    if (this.op === 'upsert') {
      const match = this.onConflictCols.length
        ? this.rows.find((r) => this.onConflictCols.every((c) => r[c] === this.payload[c]))
        : undefined;
      if (match) {
        Object.assign(match, this.payload);
      } else {
        this.rows.push({ id: this.useBigintId ? nextBigintId() : nextId(), ...this.payload });
      }
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      const matches = this.rows.filter((r) => this._matches(r));
      for (const row of matches) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    if (this.op === 'delete') {
      const remaining = this.rows.filter((r) => !this._matches(r));
      this.rows.length = 0;
      this.rows.push(...remaining);
      return { data: null, error: null };
    }
    let rows = this.rows.filter((r) => this._matches(r));
    if (typeof this._limit === 'number') rows = rows.slice(0, this._limit);
    if (this.maybeSingleMode) return { data: rows[0] || null, error: null };
    if (this.singleMode) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }
}

const CHILD_STAT_TABLES = {
  batting_lines: true,
  pitching_lines: true,
  play_events: true,
  player_advanced_stats: true,
  pitcher_advanced_stats: true,
};

function createFakeClient(state) {
  return {
    from(table) {
      if (table === 'teams') return new FakeQuery(state.teams, false, table, state);
      if (table === 'games') return new FakeQuery(state.games, false, table, state);
      if (CHILD_STAT_TABLES[table]) return new FakeQuery(state[table], true, table, state);
      throw new Error(`fake client: unexpected table "${table}"`);
    },
  };
}

// Requires the REAL src/db-supabase.js fresh, with its internal
// @supabase/supabase-js client swapped for the fake above.
function withFreshDbSupabase(fn) {
  const state = {
    teams: [],
    games: [],
    batting_lines: [],
    pitching_lines: [],
    play_events: [],
    player_advanced_stats: [],
    pitcher_advanced_stats: [],
  };
  const fakeClient = createFakeClient(state);

  const originalSupabaseJsEntry = require.cache[SUPABASE_JS_PATH];
  require.cache[SUPABASE_JS_PATH] = {
    id: SUPABASE_JS_PATH,
    filename: SUPABASE_JS_PATH,
    loaded: true,
    exports: { createClient: () => fakeClient },
  };

  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key-for-tests';

  delete require.cache[DB_SUPABASE_PATH];
  const dbSupabase = require('../src/db-supabase');
  dbSupabase.init();

  return Promise.resolve()
    .then(() => fn(dbSupabase, state))
    .finally(() => {
      if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
      if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
      if (originalSupabaseJsEntry) require.cache[SUPABASE_JS_PATH] = originalSupabaseJsEntry;
      else delete require.cache[SUPABASE_JS_PATH];
      delete require.cache[DB_SUPABASE_PATH];
    });
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEAM_UNKNOWN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const GAME_A = 'game-owned-by-org-a';
const GAME_B = 'game-owned-by-org-b';
const GAME_UNKNOWN = 'game-does-not-exist';
const GAME_NO_ORG = 'game-with-unresolved-org';

function seedTeams(state) {
  state.teams.push(
    { id: TEAM_A, org_id: ORG_A },
    { id: TEAM_B, org_id: ORG_B },
  );
}

// Seeds real-looking games rows: GAME_A owned by ORG_A, GAME_B owned by
// ORG_B (used to prove a team from one organization cannot be combined
// with a real game from another), plus GAME_NO_ORG (exists, but its own
// org_id is unresolved/null -- the schema's org_id is nullable pre-T3K-
// migration, so this is a state the application boundary itself must
// still refuse rather than assume).
function seedGames(state) {
  state.games.push(
    { id: GAME_A, org_id: ORG_A },
    { id: GAME_B, org_id: ORG_B },
    { id: GAME_NO_ORG, org_id: null },
  );
}

function battingLine(overrides = {}) {
  return { teamId: TEAM_A, playerName: 'Synthetic Player', isOurTeam: true, ab: 3, h: 1, ...overrides };
}

// ── Empty-batch behavior (unchanged by the bulk-homogeneity validation) ─────

test('insertBattingLines/insertPitchingLines/insertPlayEvents: an empty array is a no-op, never queries teams or writes anything', () => {
  return withFreshDbSupabase(async (db, state) => {
    await db.insertBattingLines([], 'game-1');
    await db.insertPitchingLines([], 'game-1');
    await db.insertPlayEvents([], 'game-1');
    assert.equal(state.batting_lines.length, 0);
    assert.equal(state.pitching_lines.length, 0);
    assert.equal(state.play_events.length, 0);
  });
});

// ── insertBattingLines ───────────────────────────────────────────────────────

test('insertBattingLines: every inserted row carries the actual game\'s authoritative org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await db.insertBattingLines([battingLine()], GAME_A);
    assert.equal(state.batting_lines.length, 1);
    assert.equal(state.batting_lines[0].org_id, ORG_A);
    assert.equal(state.batting_lines[0].game_id, GAME_A);
  });
});

test('insertBattingLines: cannot silently omit org_id -- every row has a non-null org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await db.insertBattingLines([battingLine(), battingLine({ playerName: 'Second Player' })], GAME_A);
    assert.equal(state.batting_lines.length, 2);
    for (const row of state.batting_lines) assert.ok(row.org_id, 'every batting_lines row must carry org_id');
  });
});

test('insertBattingLines: a nonexistent game fails closed -- no row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    await assert.rejects(
      () => db.insertBattingLines([battingLine({ teamId: TEAM_A })], GAME_UNKNOWN),
      /game.*not found/i,
    );
    assert.equal(state.batting_lines.length, 0);
  });
});

test('insertBattingLines: a game that exists but has no resolvable org_id fails closed -- no row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await assert.rejects(
      () => db.insertBattingLines([battingLine({ teamId: TEAM_A })], GAME_NO_ORG),
      /does not have org_id/i,
    );
    assert.equal(state.batting_lines.length, 0);
  });
});

test('insertBattingLines: missing parent team fails closed -- no row is written (game itself is valid)', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedGames(state);
    await assert.rejects(
      () => db.insertBattingLines([battingLine({ teamId: TEAM_UNKNOWN })], GAME_A),
      /team.*not found/i,
    );
    assert.equal(state.batting_lines.length, 0);
  });
});

test('insertBattingLines: THE GAME/TEAM MISMATCH REGRESSION -- a team belonging to Organization A combined with a REAL game belonging to Organization B is rejected before any row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    // TEAM_A (org A) + GAME_B (a real, existing game -- but owned by org B).
    // Both individually resolve fine (their own foreign keys are satisfied);
    // the batch must still be refused because they don't belong together.
    await assert.rejects(
      () => db.insertBattingLines([battingLine({ teamId: TEAM_A })], GAME_B),
      /disagrees with a team|mismatched game\/team/i,
    );
    assert.equal(state.batting_lines.length, 0, 'a team/game organization mismatch must never produce a written row');
  });
});

test('insertBattingLines: a caller-supplied org_id on a LATER row that conflicts with the authoritative game org is REJECTED -- the whole batch fails closed, never silently coalesced to a single org', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    const lines = [
      battingLine({ teamId: TEAM_A }),
      battingLine({ teamId: TEAM_A, playerName: 'Second Player', orgId: ORG_B }),
    ];
    await assert.rejects(
      () => db.insertBattingLines(lines, GAME_A),
      /conflicts with the game's authoritative organization/i,
    );
    assert.equal(state.batting_lines.length, 0, 'no row may be written when any row\'s hint conflicts with the authoritative org');
  });
});

test('insertBattingLines: THE MIXED-ORGANIZATION-TEAMS REGRESSION -- a batch containing a row tied to org A\'s team and another tied to org B\'s team is rejected BEFORE any row is written, and cannot result in both rows landing under either org', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    const lines = [
      battingLine({ teamId: TEAM_A, playerName: 'Org A Player' }),
      battingLine({ teamId: TEAM_B, playerName: 'Org B Player' }),
    ];
    await assert.rejects(
      () => db.insertBattingLines(lines, GAME_A),
      /disagrees with a team|mismatched game\/team/i,
    );
    assert.equal(state.batting_lines.length, 0, 'a mixed-organization batch must not partially or fully write under either organization');
  });
});

test('insertBattingLines: a batch spanning two DIFFERENT teams that both belong to the SAME organization as the game is accepted and every row gets that organization\'s org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    const TEAM_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-a2a2a2a2a2a2';
    state.teams.push({ id: TEAM_A2, org_id: ORG_A });
    const lines = [
      battingLine({ teamId: TEAM_A, playerName: 'Player On Team A' }),
      battingLine({ teamId: TEAM_A2, playerName: 'Player On Team A2' }),
    ];
    await db.insertBattingLines(lines, GAME_A);
    assert.equal(state.batting_lines.length, 2);
    for (const row of state.batting_lines) assert.equal(row.org_id, ORG_A, 'two different teams under the same org as the game must both resolve to that org, not be rejected as mismatched');
  });
});

test('insertBattingLines: any single row with an unresolvable team fails the whole batch closed, even when the game and other rows resolve fine', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    const lines = [
      battingLine({ teamId: TEAM_A, playerName: 'Resolvable Player' }),
      battingLine({ teamId: TEAM_UNKNOWN, playerName: 'Unresolvable Player' }),
    ];
    await assert.rejects(
      () => db.insertBattingLines(lines, GAME_A),
      /team.*not found/i,
    );
    assert.equal(state.batting_lines.length, 0);
  });
});

// ── insertPitchingLines ──────────────────────────────────────────────────────

test('insertPitchingLines: every inserted row carries the actual game\'s authoritative org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await db.insertPitchingLines([{ teamId: TEAM_B, playerName: 'Pitcher One', isOurTeam: false }], GAME_B);
    assert.equal(state.pitching_lines.length, 1);
    assert.equal(state.pitching_lines[0].org_id, ORG_B);
  });
});

test('insertPitchingLines: missing parent team fails closed -- no row is written (game itself is valid)', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedGames(state);
    await assert.rejects(
      () => db.insertPitchingLines([{ teamId: TEAM_UNKNOWN, playerName: 'Ghost' }], GAME_A),
      /team.*not found/i,
    );
    assert.equal(state.pitching_lines.length, 0);
  });
});

test('insertPitchingLines: a nonexistent game fails closed -- no row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    await assert.rejects(
      () => db.insertPitchingLines([{ teamId: TEAM_A, playerName: 'Ghost Pitcher' }], GAME_UNKNOWN),
      /game.*not found/i,
    );
    assert.equal(state.pitching_lines.length, 0);
  });
});

test('insertPitchingLines: THE GAME/TEAM MISMATCH REGRESSION -- a team belonging to Organization A combined with a REAL game belonging to Organization B is rejected before any row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await assert.rejects(
      () => db.insertPitchingLines([{ teamId: TEAM_A, playerName: 'Cross-Tenant Pitcher' }], GAME_B),
      /disagrees with a team|mismatched game\/team/i,
    );
    assert.equal(state.pitching_lines.length, 0);
  });
});

test('insertPitchingLines: a mixed-organization batch (one row per org A/org B team) is rejected before any row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await assert.rejects(
      () => db.insertPitchingLines([
        { teamId: TEAM_A, playerName: 'Org A Pitcher' },
        { teamId: TEAM_B, playerName: 'Org B Pitcher' },
      ], GAME_A),
      /disagrees with a team|mismatched game\/team/i,
    );
    assert.equal(state.pitching_lines.length, 0);
  });
});

// ── insertPlayEvents ──────────────────────────────────────────────────────────

test('insertPlayEvents: every inserted row carries the actual game\'s authoritative org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await db.insertPlayEvents([{ teamId: TEAM_A, sequenceNum: 1, description: 'Groundout' }], GAME_A);
    assert.equal(state.play_events.length, 1);
    assert.equal(state.play_events[0].org_id, ORG_A);
  });
});

test('insertPlayEvents: missing parent team fails closed -- no row is written (game itself is valid)', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedGames(state);
    await assert.rejects(
      () => db.insertPlayEvents([{ teamId: TEAM_UNKNOWN, sequenceNum: 1 }], GAME_A),
      /team.*not found/i,
    );
    assert.equal(state.play_events.length, 0);
  });
});

test('insertPlayEvents: a nonexistent game fails closed -- no row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    await assert.rejects(
      () => db.insertPlayEvents([{ teamId: TEAM_A, sequenceNum: 1 }], GAME_UNKNOWN),
      /game.*not found/i,
    );
    assert.equal(state.play_events.length, 0);
  });
});

test('insertPlayEvents: THE GAME/TEAM MISMATCH REGRESSION -- a team belonging to Organization A combined with a REAL game belonging to Organization B is rejected before any row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await assert.rejects(
      () => db.insertPlayEvents([{ teamId: TEAM_A, sequenceNum: 1 }], GAME_B),
      /disagrees with a team|mismatched game\/team/i,
    );
    assert.equal(state.play_events.length, 0);
  });
});

test('insertPlayEvents: a mixed-organization batch (one row per org A/org B team) is rejected before any row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    await assert.rejects(
      () => db.insertPlayEvents([
        { teamId: TEAM_A, sequenceNum: 1 },
        { teamId: TEAM_B, sequenceNum: 2 },
      ], GAME_A),
      /disagrees with a team|mismatched game\/team/i,
    );
    assert.equal(state.play_events.length, 0);
  });
});

// ── upsertPlayerAdvancedStats / upsertPitcherAdvancedStats ──────────────────
// Unlike insertBattingLines/insertPitchingLines/insertPlayEvents, these two
// functions take a single teamId scalar argument (never an array of rows
// tied to potentially different teams) and never accept a caller-supplied
// orgId at all -- there is no batch, and therefore no mixed-tenant-batch
// shape possible at this boundary by construction. org_id is always
// resolved fresh via getOrgIdForTeam(teamId), which already fails closed on
// an unresolvable team. The tests below (missing-parent-fails-closed,
// org_id-carried, cross-org-no-collision) already fully cover this
// boundary's tenant-safety; no additional bulk-validation code was added
// here because there is nothing for it to validate.

test('upsertPlayerAdvancedStats/upsertPitcherAdvancedStats: signatures confirm there is no batch to validate -- teamId is a single scalar, not an array, and neither function accepts a caller-supplied orgId', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db-supabase.js'), 'utf8');
  assert.match(source, /async function upsertPlayerAdvancedStats\(teamId, playerName, isOurTeam, stats\)/);
  assert.match(source, /async function upsertPitcherAdvancedStats\(teamId, playerName, isOurTeam, stats\)/);
});

test('upsertPlayerAdvancedStats: the upserted row carries the parent team\'s org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    await db.upsertPlayerAdvancedStats(TEAM_A, 'Synthetic Batter', true, { games: 5, GB: 2 });
    assert.equal(state.player_advanced_stats.length, 1);
    assert.equal(state.player_advanced_stats[0].org_id, ORG_A);
  });
});

test('upsertPlayerAdvancedStats: missing parent team fails closed -- no row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    await assert.rejects(
      () => db.upsertPlayerAdvancedStats(TEAM_UNKNOWN, 'Ghost', true, {}),
      /not found/i,
    );
    assert.equal(state.player_advanced_stats.length, 0);
  });
});

test('upsertPlayerAdvancedStats: re-upserting the SAME team_id/player_name/is_our_team never lets a later org_id drift -- always reflects that team\'s real org', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    await db.upsertPlayerAdvancedStats(TEAM_A, 'Synthetic Batter', true, { games: 1 });
    await db.upsertPlayerAdvancedStats(TEAM_A, 'Synthetic Batter', true, { games: 2 });
    assert.equal(state.player_advanced_stats.length, 1, 'onConflict must update in place, not duplicate');
    assert.equal(state.player_advanced_stats[0].org_id, ORG_A);
    assert.equal(state.player_advanced_stats[0].games, 2);
  });
});

test('upsertPlayerAdvancedStats: org A and org B\'s stat rows for their OWN teams never collide despite an identical player_name/is_our_team pair', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    await db.upsertPlayerAdvancedStats(TEAM_A, 'Same Name', true, { games: 1 });
    await db.upsertPlayerAdvancedStats(TEAM_B, 'Same Name', true, { games: 9 });
    assert.equal(state.player_advanced_stats.length, 2, 'different team_id must never conflict-collide even with an identical player_name/is_our_team pair');
    const rowA = state.player_advanced_stats.find((r) => r.team_id === TEAM_A);
    const rowB = state.player_advanced_stats.find((r) => r.team_id === TEAM_B);
    assert.equal(rowA.org_id, ORG_A);
    assert.equal(rowB.org_id, ORG_B);
    assert.equal(rowA.games, 1);
    assert.equal(rowB.games, 9);
  });
});

// ── upsertPitcherAdvancedStats ────────────────────────────────────────────────

test('upsertPitcherAdvancedStats: the upserted row carries the parent team\'s org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    await db.upsertPitcherAdvancedStats(TEAM_B, 'Synthetic Pitcher', false, { games: 3 });
    assert.equal(state.pitcher_advanced_stats.length, 1);
    assert.equal(state.pitcher_advanced_stats[0].org_id, ORG_B);
  });
});

test('upsertPitcherAdvancedStats: missing parent team fails closed -- no row is written', async () => {
  await withFreshDbSupabase(async (db, state) => {
    await assert.rejects(
      () => db.upsertPitcherAdvancedStats(TEAM_UNKNOWN, 'Ghost', false, {}),
      /not found/i,
    );
    assert.equal(state.pitcher_advanced_stats.length, 0);
  });
});

// ── writeNormalizedGame (full atomic write + reingest replacement) ───────────

function normalizedGamePayload(overrides = {}) {
  return {
    game: { teamId: TEAM_A, gcGameId: 'gc-123', opponentName: 'Rival Squad', ...overrides.game },
    battingLines: overrides.battingLines || [battingLine()],
    pitchingLines: overrides.pitchingLines || [],
    playEvents: overrides.playEvents || [],
  };
}

test('writeNormalizedGame: a fresh game and its child rows all carry the same authoritative org_id', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    const result = await db.writeNormalizedGame(normalizedGamePayload());
    assert.equal(state.games.length, 1);
    assert.equal(state.games[0].org_id, ORG_A);
    assert.equal(state.batting_lines.length, 1);
    assert.equal(state.batting_lines[0].org_id, ORG_A);
    assert.equal(state.batting_lines[0].game_id, result.gameId);
  });
});

test('writeNormalizedGame: complete-game replacement (reingest) preserves tenant identity -- replaced child rows still carry the original org_id, and stale rows are gone', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    const first = await db.writeNormalizedGame(normalizedGamePayload({
      battingLines: [battingLine({ playerName: 'Original Player' })],
    }));
    assert.equal(state.batting_lines.length, 1);

    // Re-ingest the SAME game (same gcGameId) with different box score
    // content -- this must replace, not duplicate, and the replacement
    // rows must still carry org_id correctly.
    const second = await db.writeNormalizedGame(normalizedGamePayload({
      battingLines: [battingLine({ playerName: 'Corrected Player' })],
    }));

    assert.equal(second.gameId, first.gameId, 'reingest of the same gc_game_id must update the existing game, not create a new one');
    assert.equal(state.batting_lines.length, 1, 'clearGameDetailRows must remove the stale row before the replacement is inserted');
    assert.equal(state.batting_lines[0].player_name, 'Corrected Player');
    assert.equal(state.batting_lines[0].org_id, ORG_A);
  });
});

test('writeNormalizedGame: reingesting org A\'s game never touches org B\'s child rows for a different game', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    const orgBGame = await db.writeNormalizedGame({
      game: { teamId: TEAM_B, gcGameId: 'gc-orgb-1' },
      battingLines: [battingLine({ teamId: TEAM_B, playerName: 'Org B Player' })],
      pitchingLines: [],
      playEvents: [],
    });

    // Reingest org A's own, different game twice.
    await db.writeNormalizedGame(normalizedGamePayload({ game: { teamId: TEAM_A, gcGameId: 'gc-orga-1' } }));
    await db.writeNormalizedGame(normalizedGamePayload({ game: { teamId: TEAM_A, gcGameId: 'gc-orga-1' } }));

    const orgBRows = state.batting_lines.filter((r) => r.game_id === orgBGame.gameId);
    assert.equal(orgBRows.length, 1, 'org B\'s child row must survive org A\'s unrelated reingest untouched');
    assert.equal(orgBRows[0].org_id, ORG_B);
    assert.equal(orgBRows[0].player_name, 'Org B Player');
  });
});

// ── T3K regression: these five write paths no longer depend on the
// tableHasOrgId() capability probe at all -- org_id is attached
// unconditionally now that the schema guarantees the column (see the
// accompanying migration). Each test below rigs the fake client to
// answer tableHasOrgId's exact live probe query with Postgres's real
// "column does not exist" error -- the same response that used to make
// these functions SILENTLY omit org_id -- and proves the row is written
// with org_id anyway, because the function never asks the question
// anymore. This is the concrete regression for the roadmap's stated
// invariant: "must not omit org_id merely because a runtime
// column-capability probe says the table lacks the column."

test('insertBattingLines: THE T3K REGRESSION -- still attaches org_id even when the org_id capability probe would report the column missing', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    state._simulateMissingOrgIdColumn = new Set(['batting_lines']);
    await db.insertBattingLines([battingLine()], GAME_A);
    assert.equal(state.batting_lines.length, 1);
    assert.equal(state.batting_lines[0].org_id, ORG_A, 'org_id must be attached even though the (now-irrelevant) capability probe would say the column is missing');
  });
});

test('insertPitchingLines: THE T3K REGRESSION -- still attaches org_id even when the org_id capability probe would report the column missing', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    state._simulateMissingOrgIdColumn = new Set(['pitching_lines']);
    await db.insertPitchingLines([{ teamId: TEAM_A, playerName: 'Pitcher' }], GAME_A);
    assert.equal(state.pitching_lines.length, 1);
    assert.equal(state.pitching_lines[0].org_id, ORG_A);
  });
});

test('insertPlayEvents: THE T3K REGRESSION -- still attaches org_id even when the org_id capability probe would report the column missing', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    seedGames(state);
    state._simulateMissingOrgIdColumn = new Set(['play_events']);
    await db.insertPlayEvents([{ teamId: TEAM_A, sequenceNum: 1 }], GAME_A);
    assert.equal(state.play_events.length, 1);
    assert.equal(state.play_events[0].org_id, ORG_A);
  });
});

test('upsertPlayerAdvancedStats: THE T3K REGRESSION -- still attaches org_id even when the org_id capability probe would report the column missing', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    state._simulateMissingOrgIdColumn = new Set(['player_advanced_stats']);
    await db.upsertPlayerAdvancedStats(TEAM_A, 'Batter', true, {});
    assert.equal(state.player_advanced_stats.length, 1);
    assert.equal(state.player_advanced_stats[0].org_id, ORG_A);
  });
});

test('upsertPitcherAdvancedStats: THE T3K REGRESSION -- still attaches org_id even when the org_id capability probe would report the column missing', () => {
  return withFreshDbSupabase(async (db, state) => {
    seedTeams(state);
    state._simulateMissingOrgIdColumn = new Set(['pitcher_advanced_stats']);
    await db.upsertPitcherAdvancedStats(TEAM_A, 'Pitcher', true, {});
    assert.equal(state.pitcher_advanced_stats.length, 1);
    assert.equal(state.pitcher_advanced_stats[0].org_id, ORG_A);
  });
});

// ── Source-level regression: the conditional must truly be gone from
// these five functions, not merely bypassed by coincidence ──────────────

test('tableHasOrgId() is no longer called inside insertBattingLines, insertPitchingLines, insertPlayEvents, ' +
     'upsertPlayerAdvancedStats, or upsertPitcherAdvancedStats -- org_id is unconditional in each (a historical ' +
     'mention in an explanatory comment, or the retained scouting_reports/addOrgIdIfSupported call sites, are fine)', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db-supabase.js'), 'utf8');

  function bodyOf(fnName) {
    const start = source.indexOf(`async function ${fnName}(`);
    assert.ok(start >= 0, `${fnName} must still be defined`);
    // Each of these five functions is followed by a blank line then the
    // next "// ───" section header or function -- slicing to the next
    // top-level "async function " after this one is a safe, simple
    // boundary for this file's consistent formatting.
    const nextFn = source.indexOf('\nasync function ', start + 10);
    return source.slice(start, nextFn === -1 ? source.length : nextFn);
  }

  for (const fnName of [
    'insertBattingLines',
    'insertPitchingLines',
    'insertPlayEvents',
    'upsertPlayerAdvancedStats',
    'upsertPitcherAdvancedStats',
  ]) {
    assert.doesNotMatch(bodyOf(fnName), /tableHasOrgId/, `${fnName} must not call tableHasOrgId anymore`);
  }
});

test('insertScoutingReport (a deliberately different, still-partially-migrated table -- see the T3K migration\'s ' +
     'own header) still guards its org_id assignment with tableHasOrgId(), unaffected by this slice', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db-supabase.js'), 'utf8');
  const start = source.indexOf('async function insertScoutingReport(');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('\nasync function ', start + 10));
  assert.match(body, /tableHasOrgId\('scouting_reports'\)/, 'scouting_reports is intentionally out of T3K\'s scope and keeps its own conditional');
});
