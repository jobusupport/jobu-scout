'use strict';

// Slice 2D structural + mapper contract tests. These run with no database:
// they assert the migration's declared posture and the pure mapper's behaviour.
// The relational proofs live in
// test/high-school-opponent-ingestion.integration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  mapHighSchoolOpponentEngineCollection,
  mapHighSchoolEngineCollection,
  canonicalSerialize,
  OPPONENT_GAME_STATUSES,
} = require('../src/high-school-engine-persistence-mapper');

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260819024053_add_hs_opponent_ingestion_lineage.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
// Line comments removed so prose describing a withheld privilege can never be
// mistaken for a granted one.
const executableSql = sql.replace(/^\s*--.*$/gm, '');

const collisionGuardMigrationPath = path.join(__dirname, '..', 'supabase', 'migrations',
  '20260826180000_harden_opponent_source_event_identity_collision_guard.sql');
const collisionGuardSql = fs.readFileSync(collisionGuardMigrationPath, 'utf8');

const NEW_TABLES = [
  'hs_opponent_import_runs', 'hs_opponent_games', 'hs_opponent_game_identity_aliases',
  'hs_opponent_import_run_games', 'hs_opponent_raw_snapshots', 'hs_opponent_game_validation_results',
  'hs_opponent_stat_generations', 'hs_opponent_verified_totals',
  'hs_opponent_noncanonical_player_stats', 'hs_opponent_game_identity_resolutions',
];

const ORG = '11111111-1111-4111-8111-111111111111';
const PROGRAM = '22222222-2222-4222-8222-222222222222';
const SEASON = '33333333-3333-4333-8333-333333333333';
const OPPONENT = '44444444-4444-4444-8444-444444444444';
const SOURCE_TEAM = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';

function context(overrides = {}) {
  return { orgId: ORG, programId: PROGRAM, seasonId: SEASON, sourceProvider: 'gamechanger', ...overrides };
}

function subject(overrides = {}) {
  return { opponentTeamId: OPPONENT, sourceTeamId: SOURCE_TEAM, importRunId: RUN, ...overrides };
}

function capturedGame(sourceGameId, meta = {}) {
  const baseMeta = {
    gameDate: '2026-04-01', homeTeam: 'Monitored Opponent High', awayTeam: 'Third Party High',
    ourSide: 'home', capturedAt: '2026-04-01T20:00:00.000Z', gameStatus: 'final', ...meta,
  };
  if (sourceGameId !== null) baseMeta.sourceGameId = sourceGameId;
  return {
    meta: baseMeta,
    boxScore: {
      batting: [
        { Player: 'Opponent Batter', TeamSide: 'home', own: true, playerId: 'opp-batter-1' },
        { Player: 'Third Party Batter', TeamSide: 'away', own: false, playerId: 'third-batter-1' },
      ],
      pitching: [],
    },
    plays: [{
      inning: 'Bottom 1', batterId: 'opp-batter-1',
      text: 'Single. Opponent Batter singles to left field, Third Pitcher pitching.',
    }],
  };
}

function map(games, overrides = {}) {
  return mapHighSchoolOpponentEngineCollection({
    context: overrides.context || context(),
    subject: overrides.subject || subject(),
    capturedGames: games,
  });
}

// ── Migration posture ──────────────────────────────────────────────────

test('every new opponent table declares row level security in the migration', () => {
  for (const table of NEW_TABLES) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`, 'i'), `${table} must be created`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`, 'i'),
      `${table} must enable RLS`);
  }
});

test('the migration revokes everything from untrusted roles before granting anything', () => {
  assert.match(sql, /revoke all on public\.hs_opponent_import_runs[\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.doesNotMatch(sql, /grant[^;]*to\s+anon\b/i, 'anon must never be granted anything');
  assert.doesNotMatch(sql, /grant[^;]*to\s+public\b/i, 'PUBLIC must never be granted anything');
  assert.doesNotMatch(sql, /alter default privileges/i, 'privileges must be explicit, never defaulted');
});

test('no destructive verb is granted anywhere in the migration', () => {
  // Comments are stripped first: the prose below explains which verbs are
  // withheld, and naming them must not read as a grant statement.
  const grants = executableSql.match(/^\s*grant[\s\S]*?;/gim) || [];
  assert.ok(grants.length > 0, 'the migration must contain grant statements to inspect');
  for (const grant of grants) {
    if (!/\bto\b/i.test(grant)) continue;
    for (const verb of ['delete', 'truncate', 'references', 'trigger', 'maintain']) {
      assert.doesNotMatch(grant, new RegExp(`grant[^;]*\\b${verb}\\b[^;]*on`, 'i'),
        `no grant may include ${verb.toUpperCase()}: ${grant.slice(0, 90)}`);
    }
  }
});

test('the identity foundation is granted read-only to the publication role and nothing to untrusted roles', () => {
  assert.match(sql, /revoke all on public\.hs_opponent_teams, public\.hs_opponent_programs, public\.hs_source_teams,[\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant select on public\.hs_opponent_teams, public\.hs_opponent_programs, public\.hs_source_teams,[\s\S]*?to service_role;/i);
  // Ingestion must never be able to edit the identity it is authorised against.
  assert.doesNotMatch(sql, /grant[^;]*(?:insert|update)[^;]*public\.hs_opponent_source_links[^;]*to/i);
  assert.doesNotMatch(sql, /grant[^;]*(?:insert|update)[^;]*public\.hs_opponent_teams[^;]*to/i);
});

test('the append-only tables are never granted UPDATE', () => {
  const appendOnly = ['hs_opponent_import_run_games', 'hs_opponent_raw_snapshots',
    'hs_opponent_game_validation_results', 'hs_opponent_noncanonical_player_stats',
    'hs_opponent_game_identity_resolutions'];
  const updateGrants = sql.match(/grant[^;]*update[^;]*;/gi) || [];
  for (const grant of updateGrants) {
    for (const table of appendOnly) {
      assert.doesNotMatch(grant, new RegExp(`public\\.${table}\\b`, 'i'),
        `${table} is append-only and must not appear in an UPDATE grant`);
    }
  }
});

test('the widened RPC stays SECURITY INVOKER, search-path-locked, and free of dynamic SQL', () => {
  const fn = sql.match(/create function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i)?.[0] || '';
  assert.ok(fn, 'the widened function must exist');
  assert.match(fn, /security invoker/i);
  assert.doesNotMatch(fn, /security definer/i);
  assert.match(fn, /set search_path = ''/i);
  assert.doesNotMatch(fn, /\bexecute\s+(?:format|'|")/i, 'the RPC must contain no dynamic SQL');
  assert.match(sql, /revoke execute on function public\.persist_hs_engine_collection\(jsonb\) from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.persist_hs_engine_collection\(jsonb\) to postgres, service_role;/i);
});

// ── Source-event collision hardening (post-preview-validation fix) ──────

test('the hardened RPC still stays SECURITY INVOKER, search-path-locked, and free of dynamic SQL', () => {
  const fn = collisionGuardSql.match(/create function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i)?.[0] || '';
  assert.ok(fn, 'the hardened function must exist');
  assert.match(fn, /security invoker/i);
  assert.doesNotMatch(fn, /security definer/i);
  assert.match(fn, /set search_path = ''/i);
  assert.doesNotMatch(fn, /\bexecute\s+(?:format|'|")/i, 'the RPC must contain no dynamic SQL');
  assert.match(collisionGuardSql, /revoke execute on function public\.persist_hs_engine_collection\(jsonb\) from public, anon, authenticated;/i);
  assert.match(collisionGuardSql, /grant execute on function public\.persist_hs_engine_collection\(jsonb\) to postgres, service_role;/i);
});

test('the hardened RPC creates no second publication function and adds no SECURITY DEFINER', () => {
  const created = collisionGuardSql.match(/create (?:or replace )?function public\.(\w+)/gi) || [];
  assert.deepEqual(created.map((c) => c.split('.').pop()), ['persist_hs_engine_collection']);
  assert.doesNotMatch(collisionGuardSql, /security definer/i);
});

test('the migration adds no table, column, index, constraint, policy or grant beyond the RPC redefinition', () => {
  const withoutFunctionBody = collisionGuardSql.replace(/create function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i, '');
  assert.doesNotMatch(withoutFunctionBody, /create table/i);
  assert.doesNotMatch(withoutFunctionBody, /alter table/i);
  assert.doesNotMatch(withoutFunctionBody, /create policy/i);
  assert.doesNotMatch(withoutFunctionBody, /create index/i);
  assert.doesNotMatch(withoutFunctionBody, /create (?:unique )?index/i);
});

test('a second, independent collision guard is grouped on the normalized identity pair, not on identityStatus or sourceGameRef alone', () => {
  const fn = collisionGuardSql.match(/create function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i)?.[0] || '';
  const guards = fn.match(/if exists \([\s\S]*?having count\(\*\) > 1[\s\S]*?end if;/gi) || [];
  assert.equal(guards.length, 2, 'exactly two independent collision guards must exist: sourceGameRef-based and identity-pair-based');

  const sourceRefGuard = guards.find((g) => /group by observation ->> 'sourceGameRef'/i.test(g));
  const identityGuard = guards.find((g) => /group by observation ->> 'identityMethod', observation ->> 'identityDigest'/i.test(g));
  assert.ok(sourceRefGuard, 'the original sourceGameRef-based guard must remain intact');
  assert.ok(identityGuard, 'a new identity-pair-based guard must exist');

  // The new guard must never key off, or filter by, the caller-supplied
  // identityStatus label -- that is precisely the field a privileged caller
  // could falsify to smuggle a collision past a status-based check.
  assert.doesNotMatch(identityGuard, /identityStatus/i,
    'the identity-pair collision guard must not reference identityStatus at all');
  assert.match(identityGuard, /identityMethod/i);
  assert.match(identityGuard, /identityDigest/i);

  // Both guards must raise the one established, stable error.
  for (const guard of guards) {
    assert.match(guard, /raise exception 'opponent_source_event_identity_collision: two or more distinct observations claim one source game identity' using errcode = 'P0001';/i);
  }
});

test('the identity-pair collision guard runs before any INSERT in the opponent branch', () => {
  const fn = collisionGuardSql.match(/create function public\.persist_hs_engine_collection[\s\S]*?\$function\$;/i)?.[0] || '';
  const identityGuardIndex = fn.search(/group by observation ->> 'identityMethod', observation ->> 'identityDigest'/i);
  assert.ok(identityGuardIndex > -1, 'the identity-pair guard must be present');
  const opponentBranchIndex = fn.search(/v_subject_kind = 'opponent_team' then/i);
  const firstOpponentInsert = fn.slice(opponentBranchIndex).search(/\binsert into public\.hs_opponent_/i);
  assert.ok(firstOpponentInsert > -1, 'the opponent branch must eventually insert a canonical row');
  assert.ok(identityGuardIndex < opponentBranchIndex + firstOpponentInsert,
    'the identity-pair collision guard must execute before any opponent-lineage INSERT');
});

test('the correction migration does not touch any of the 47 previously canonical migrations', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  assert.equal(files.length, 48, 'exactly one migration must be added to the prior 47');
  assert.ok(files.includes('20260826180000_harden_opponent_source_event_identity_collision_guard.sql'));
});

test('opponent currency is scoped by opponent team, never by the organization own team', () => {
  assert.match(sql, /unique index idx_hs_opponent_stat_generations_current_per_subject_season[\s\S]*?\(org_id, opponent_team_id, season_id\) where is_current/i);
  assert.match(sql, /unique \(org_id, opponent_team_id, season_id, engine_version, input_set_hash\)/i);
  // The opponent lineage must not borrow the own-team subject column at all.
  const opponentTables = sql.match(/create table public\.hs_opponent_[\s\S]*?\n\);/g) || [];
  for (const table of opponentTables) {
    assert.doesNotMatch(table, /^\s{2}team_id uuid/m, 'no opponent table may carry an own-team team_id column');
  }
});

test('the migration creates no second publication function and adds no SECURITY DEFINER', () => {
  const created = sql.match(/create (?:or replace )?function public\.(\w+)/gi) || [];
  assert.deepEqual(created.map((c) => c.split('.').pop()), ['persist_hs_engine_collection']);
  assert.doesNotMatch(sql, /security definer/i);
});

test('the design contract document accompanies the migration', () => {
  const contract = path.join(__dirname, '..', 'docs', 'architecture', 'HS_2D_OPPONENT_INGESTION_CONTRACT.md');
  assert.ok(fs.existsSync(contract), 'HS 2D ships its design contract');
  const text = fs.readFileSync(contract, 'utf8');
  for (const heading of ['Subject key', 'Raw snapshot identity', 'Schedule reality',
    'Publication eligibility', 'Rollback and failure semantics', 'Backward compatibility']) {
    assert.ok(text.includes(heading), `the contract must define: ${heading}`);
  }
});

// ── Mapper contract ────────────────────────────────────────────────────

test('an opponent collection carries the discriminated subject and never a canonical player', () => {
  const { dto } = map([capturedGame('g-1')]);
  assert.equal(dto.subject.kind, 'opponent_team');
  assert.equal(dto.subject.opponentTeamId, OPPONENT);
  assert.equal(dto.subject.sourceTeamId, SOURCE_TEAM);
  assert.equal(dto.subject.importRunId, RUN);
  assert.equal(Object.hasOwn(dto.context, 'teamId'), false, 'an opponent context carries no own-team id');
  assert.equal(Object.hasOwn(dto.context, 'importRunId'), false);
  assert.deepEqual(dto.canonicalPlayers, [], 'opponent players are never canonical in HS 2D');
  assert.ok(dto.noncanonicalPlayers.length > 0, 'opponent player lines are preserved');
});

test('an own-team context field on an opponent collection is refused', () => {
  assert.throws(() => map([capturedGame('g-1')], { context: context({ teamId: OPPONENT }) }),
    (error) => error.code === 'AMBIGUOUS_COLLECTION_SUBJECT');
  assert.throws(() => map([capturedGame('g-1')], { context: context({ importRunId: RUN }) }),
    (error) => error.code === 'AMBIGUOUS_COLLECTION_SUBJECT');
  assert.throws(() => map([capturedGame('g-1')], { subject: subject({ teamId: OPPONENT }) }),
    (error) => error.code === 'AMBIGUOUS_COLLECTION_SUBJECT');
});

test('an incomplete opponent subject is refused', () => {
  for (const missing of ['opponentTeamId', 'sourceTeamId', 'importRunId']) {
    const partial = subject();
    delete partial[missing];
    assert.throws(() => map([capturedGame('g-1')], { subject: partial }),
      `omitting ${missing} must be refused`);
  }
  assert.throws(() => mapHighSchoolOpponentEngineCollection({ context: context(), subject: null, capturedGames: [] }),
    (error) => error.code === 'MISSING_COLLECTION_SUBJECT');
});

test('the same input maps to identical observations, content hash and input hash', () => {
  const games = [capturedGame('g-1'), capturedGame('g-2', { gameDate: '2026-04-02' })];
  const first = map(games).dto;
  const second = map(structuredClone(games)).dto;
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.inputSetHash, first.inputSetHash);
  assert.deepEqual(second.observations, first.observations);
});

test('arrival order and JSON key order never change the input set hash', () => {
  const a = capturedGame('g-1');
  const b = capturedGame('g-2', { gameDate: '2026-04-02' });
  const forwards = map([a, b]).dto;
  const backwards = map([b, a]).dto;
  assert.equal(backwards.inputSetHash, forwards.inputSetHash, 'a season is a set, not a sequence');
  const reordered = { plays: a.plays, boxScore: a.boxScore, meta: Object.fromEntries(Object.entries(a.meta).reverse()) };
  assert.equal(map([reordered, b]).dto.inputSetHash, forwards.inputSetHash);
});

test('the import run identifier is provenance and stays out of both hashes', () => {
  const games = [capturedGame('g-1')];
  const first = map(games).dto;
  const second = map(games, { subject: subject({ importRunId: '77777777-7777-4777-8777-777777777777' }) }).dto;
  assert.equal(second.inputSetHash, first.inputSetHash);
  assert.equal(second.contentHash, first.contentHash,
    're-ingesting unchanged data on a new run must not look like changed content');
  assert.notEqual(second.subject.importRunId, first.subject.importRunId,
    'the run is still carried for the RPC');
});

test('two different opponents can never collide on one input set hash', () => {
  const games = [capturedGame('g-1')];
  const first = map(games).dto;
  const other = map(games, { subject: subject({ opponentTeamId: '88888888-8888-4888-8888-888888888888' }) }).dto;
  assert.notEqual(other.inputSetHash, first.inputSetHash);
});

test('changed source content produces a different input set hash', () => {
  const first = map([capturedGame('g-1')]).dto;
  const second = map([capturedGame('g-1'), capturedGame('g-2', { gameDate: '2026-04-02' })]).dto;
  assert.notEqual(second.inputSetHash, first.inputSetHash);
});

test('each observation carries its source-reported game status', () => {
  const { dto } = map([
    capturedGame('g-final', { gameStatus: 'final' }),
    capturedGame('g-post', { gameStatus: 'postponed', gameDate: '2026-04-03' }),
  ]);
  const statuses = dto.observations.map((observation) => observation.gameStatus).sort();
  assert.deepEqual(statuses, ['final', 'postponed']);
});

test('an unrecognised game status is refused rather than coerced to unknown', () => {
  assert.throws(() => map([capturedGame('g-1', { gameStatus: 'mostly over' })]),
    (error) => error.code === 'INVALID_GAME_STATUS');
  // An absent status is legitimately unknown, which is not the same as a status
  // the source reported and we failed to recognise.
  const game = capturedGame('g-1');
  delete game.meta.gameStatus;
  assert.equal(map([game]).dto.observations[0].gameStatus, 'unknown');
});

test('a collection with no final game is never marked officially complete', () => {
  const { dto, finalGameCount } = map([
    capturedGame('g-1', { gameStatus: 'scheduled' }),
    capturedGame('g-2', { gameStatus: 'cancelled', gameDate: '2026-04-04' }),
  ]);
  assert.equal(finalGameCount, 0);
  assert.equal(dto.officialTotalsComplete, false);
});

test('every declared game status is accepted', () => {
  for (const status of OPPONENT_GAME_STATUSES) {
    assert.doesNotThrow(() => map([capturedGame(`g-${status}`, { gameStatus: status })]), `${status} must be accepted`);
  }
});

test('an opponent snapshot records capture time separately from the game date', () => {
  const { dto } = map([capturedGame('g-1', { gameDate: '2026-04-01', capturedAt: '2026-06-15T12:00:00.000Z' })]);
  const [observation] = dto.observations;
  assert.equal(observation.gameDate, '2026-04-01');
  for (const snapshot of observation.snapshots) {
    assert.equal(snapshot.capturedAt, '2026-06-15T12:00:00.000Z');
    assert.match(snapshot.integrityHash, /^[0-9a-f]{64}$/);
  }
});

test('a materially changed capture yields a different snapshot integrity hash', () => {
  const original = map([capturedGame('g-1')]).dto.observations[0];
  const changed = capturedGame('g-1');
  changed.boxScore.batting.push({ Player: 'Extra Batter', TeamSide: 'home', own: true, playerId: 'opp-batter-2' });
  const updated = map([changed]).dto.observations[0];
  const box = (observation) => observation.snapshots.find((s) => s.kind === 'box_score').integrityHash;
  assert.notEqual(box(updated), box(original), 'changed content must not reuse the prior snapshot identity');
});

test('capture timestamps are provenance and never decide collection identity', () => {
  const first = map([capturedGame('g-1', { capturedAt: '2026-04-01T20:00:00.000Z' })]).dto;
  const later = map([capturedGame('g-1', { capturedAt: '2026-09-09T09:09:09.000Z' })]).dto;
  // An opponent schedule is re-scraped on a schedule. If WHEN it was read
  // participated in identity, every unchanged re-scrape would mint a new
  // generation and supersede the last one for no reason.
  assert.equal(later.inputSetHash, first.inputSetHash);
  assert.equal(later.contentHash, first.contentHash);
  assert.equal(canonicalSerialize(first.subject), canonicalSerialize(later.subject));
  // The evidence of when each observation was actually taken is still preserved
  // on the snapshots themselves.
  assert.equal(first.observations[0].snapshots[0].capturedAt, '2026-04-01T20:00:00.000Z');
  assert.equal(later.observations[0].snapshots[0].capturedAt, '2026-09-09T09:09:09.000Z');
});

test('the own-team mapper is unaffected by the opponent subject work', () => {
  const playerId = crypto.randomUUID();
  const { dto } = mapHighSchoolEngineCollection({
    context: {
      orgId: ORG, programId: PROGRAM, teamId: OPPONENT, seasonId: SEASON,
      importRunId: RUN, sourceProvider: 'gamechanger',
    },
    capturedGames: [{
      meta: {
        gameDate: '2026-04-01', homeTeam: 'Ours', awayTeam: 'Theirs', ourSide: 'home',
        capturedAt: '2026-04-01T20:00:00.000Z', sourceGameId: 'own-1',
      },
      boxScore: { batting: [{ Player: 'Our Player', TeamSide: 'home', own: true, playerId: 'own-provider' }], pitching: [] },
      plays: [{
        inning: 'Bottom 1', batterId: 'own-provider',
        text: 'Single. Our Player singles to left field, Their Pitcher pitching.',
      }],
    }],
    rosterMemberships: [{ playerId, gcExternalPlayerId: 'own-provider' }],
  });
  assert.equal(Object.hasOwn(dto, 'subject'), false, 'an own-team DTO gains no subject discriminator');
  assert.equal(Object.hasOwn(dto.observations[0], 'gameStatus'), false,
    'an own-team observation gains no gameStatus field, so its content hash is unchanged');
  assert.equal(dto.canonicalPlayers.length, 1, 'own-team roster gating is untouched');
});

// ── RPC return-contract compatibility (Slice 2D audit) ──────────────────

test('the repository fails closed when the RPC returns no generation envelope', async () => {
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const stub = (data) => createHighSchoolImportRepository({
    rpc: async () => ({ data, error: null }),
    from() { throw new Error('unused'); },
  });
  // A database older than this code would return the bare Slice 2C composite
  // row. Returning it silently would hand a publication caller a row with no
  // subject discrimination; returning undefined would be worse.
  for (const legacyShape of [{ id: 'x', status: 'completed' }, null, 'not-an-object', {}]) {
    await assert.rejects(
      () => stub(legacyShape).persistEngineCollection({}),
      (error) => error.code === 'PERSISTENCE_FAILED',
      `must fail closed for ${JSON.stringify(legacyShape)}`,
    );
  }
});

test('the repository unwraps the envelope to exactly the generation row', async () => {
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const generation = { id: 'gen-1', publication_state: 'verified', final_game_count: 2 };
  const repo = createHighSchoolImportRepository({
    rpc: async () => ({ data: { subjectKind: 'opponent_team', generation }, error: null }),
    from() { throw new Error('unused'); },
  });
  assert.deepEqual(await repo.persistEngineCollection({}), generation);
});
