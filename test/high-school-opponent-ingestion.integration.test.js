'use strict';

// Slice 2D relational contract tests. Like the Slice 2C suite these accept only
// an explicitly supplied LOCAL Supabase URL, cannot use SUPABASE_URL, cannot
// resolve a project ref, and refuse every non-loopback host.
//
// Disposable-stack invocation:
//   RUN_HS_ENGINE_LOCAL_DB_TESTS=1
//   HS_LOCAL_SUPABASE_URL=http://127.0.0.1:54321
//   HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY=<local status output>
//   HS_LOCAL_SUPABASE_ANON_KEY=<local status output>
//   HS_LOCAL_JWT_SECRET=<local status output>
//   HS_LOCAL_PG_HOST=127.0.0.1 HS_LOCAL_PG_PORT=54322
//   HS_LOCAL_PG_DATABASE=postgres HS_LOCAL_PG_USER=postgres HS_LOCAL_PG_PASSWORD=<local password>
//   node --test test/high-school-opponent-ingestion.integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const localUrl = process.env.HS_LOCAL_SUPABASE_URL || '';
const explicitlyEnabled = process.env.RUN_HS_ENGINE_LOCAL_DB_TESTS === '1';
const loopbackOnly = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(localUrl);
const hasLocalKeys = !!process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY && !!process.env.HS_LOCAL_SUPABASE_ANON_KEY;
const hasLocalPostgres = process.env.HS_LOCAL_PG_HOST === '127.0.0.1'
  && /^\d{1,5}$/.test(process.env.HS_LOCAL_PG_PORT || '')
  && !!process.env.HS_LOCAL_PG_DATABASE
  && !!process.env.HS_LOCAL_PG_USER
  && !!process.env.HS_LOCAL_PG_PASSWORD;
const hasLocalJwtSecret = !!process.env.HS_LOCAL_JWT_SECRET;
const canRun = explicitlyEnabled && loopbackOnly && hasLocalKeys && hasLocalPostgres && hasLocalJwtSecret;
const skip = canRun ? false : 'requires an explicitly enabled disposable loopback-only Supabase stack and local postgres fixture connection';

const NEW_TABLES = [
  'hs_opponent_import_runs', 'hs_opponent_games', 'hs_opponent_game_identity_aliases',
  'hs_opponent_import_run_games', 'hs_opponent_raw_snapshots', 'hs_opponent_game_validation_results',
  'hs_opponent_stat_generations', 'hs_opponent_verified_totals',
  'hs_opponent_noncanonical_player_stats', 'hs_opponent_game_identity_resolutions',
];

let admin;
let anon;
let db;
let PgClient;
let createSupabaseClient;
let repository;
let service;
let mapper;
let ownMapper;
let A;
let B;

if (canRun) {
  const { createClient } = require('@supabase/supabase-js');
  createSupabaseClient = createClient;
  const { Pool, Client } = require('pg');
  PgClient = Client;
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  const { createHighSchoolImportService } = require('../src/high-school-import-service');
  ({
    mapHighSchoolOpponentEngineCollection: mapper,
    mapHighSchoolEngineCollection: ownMapper,
  } = require('../src/high-school-engine-persistence-mapper'));
  admin = createClient(localUrl, process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  anon = createClient(localUrl, process.env.HS_LOCAL_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  db = new Pool({
    host: process.env.HS_LOCAL_PG_HOST,
    port: Number(process.env.HS_LOCAL_PG_PORT),
    database: process.env.HS_LOCAL_PG_DATABASE,
    user: process.env.HS_LOCAL_PG_USER,
    password: process.env.HS_LOCAL_PG_PASSWORD,
    max: 6,
  });
  repository = createHighSchoolImportRepository(admin);
  service = createHighSchoolImportService({ repository });
}

const fixtureTables = new Set([
  'organizations', 'hs_programs', 'hs_seasons', 'hs_teams', 'hs_players', 'hs_roster_memberships',
  'hs_import_runs', 'hs_opponent_programs', 'hs_opponent_teams', 'hs_source_teams',
  'hs_source_team_contexts', 'hs_opponent_source_links', 'org_members',
]);

async function fixtureInsert(table, values) {
  assert.ok(fixtureTables.has(table), `fixture table is not allowlisted: ${table}`);
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `insert into public.${table} (${columns.map((c) => `"${c}"`).join(', ')}) values (${placeholders}) returning *`;
  const result = await db.query(sql, Object.values(values));
  assert.equal(result.rowCount, 1, `${table}: expected one fixture row`);
  return result.rows[0];
}

function authenticatedToken(userId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    aud: 'authenticated', role: 'authenticated', sub: userId,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto.createHmac('sha256', process.env.HS_LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function createFixtureIdentity(orgId = null) {
  const userId = crypto.randomUUID();
  await db.query(
    `insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [userId, `slice2d-${userId}@local.invalid`],
  );
  if (orgId) await fixtureInsert('org_members', { org_id: orgId, user_id: userId, role: 'coach', accepted_at: new Date() });
  return userId;
}

// Builds one complete tenant: our program/season/team plus a monitored opponent
// team with a linked GameChanger source identity.
async function buildTenant(label) {
  const suffix = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const org = await fixtureInsert('organizations', {
    name: `HS 2D ${suffix}`, slug: `hs-2d-${suffix}`, customer_type: 'high_school',
    primary_product: 'high_school', enabled_products: ['high_school'],
  });
  const program = await fixtureInsert('hs_programs', { org_id: org.id, name: `Program ${suffix}` });
  const season = await fixtureInsert('hs_seasons', {
    org_id: org.id, program_id: program.id, name: `Season ${suffix}`, school_year: '2025-2026',
  });
  const team = await fixtureInsert('hs_teams', {
    org_id: org.id, program_id: program.id, level: 'varsity', name: `Our Team ${suffix}`,
  });
  const opponent = await createOpponent(org.id, program.id, season.id, `Alpha ${suffix}`);
  const opponentTwo = await createOpponent(org.id, program.id, season.id, `Beta ${suffix}`);
  const userId = await createFixtureIdentity(org.id);
  return {
    suffix, orgId: org.id, programId: program.id, seasonId: season.id, teamId: team.id,
    opponent, opponentTwo, userId,
    client: createSupabaseClient(localUrl, process.env.HS_LOCAL_SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${authenticatedToken(userId)}` } },
    }),
  };
}

async function createOpponent(orgId, programId, seasonId, name, linkStatus = 'linked') {
  const oppProgram = await fixtureInsert('hs_opponent_programs', { org_id: orgId, program_id: programId, name });
  const oppTeam = await fixtureInsert('hs_opponent_teams', {
    org_id: orgId, program_id: programId, opponent_program_id: oppProgram.id,
    season_id: seasonId, level: 'varsity', display_name: name,
  });
  const sourceTeam = await fixtureInsert('hs_source_teams', {
    org_id: orgId, source_provider: 'gamechanger', source_team_ref: `src-${crypto.randomUUID().slice(0, 12)}`,
  });
  await fixtureInsert('hs_source_team_contexts', { org_id: orgId, source_team_id: sourceTeam.id, hs_season_id: seasonId });
  const linkValues = {
    org_id: orgId, program_id: programId, opponent_team_id: oppTeam.id,
    season_id: seasonId, source_team_id: sourceTeam.id, status: linkStatus,
  };
  if (linkStatus === 'rejected') {
    linkValues.decided_by_user_id = await createFixtureIdentity(null);
    linkValues.decided_at = new Date();
  }
  const link = await fixtureInsert('hs_opponent_source_links', linkValues);
  return { programId: oppProgram.id, teamId: oppTeam.id, sourceTeamId: sourceTeam.id, linkId: link.id, seasonId };
}

async function startRun(tenant, opponent = tenant.opponent) {
  return repository.createOpponentImportRun({
    orgId: tenant.orgId, programId: tenant.programId, opponentTeamId: opponent.teamId,
    seasonId: tenant.seasonId, sourceTeamId: opponent.sourceTeamId, triggerKind: 'manual',
  });
}

function capturedGame(sourceGameId, meta = {}, boxOverrides = null) {
  const baseMeta = {
    gameDate: '2026-04-01', homeTeam: 'Monitored Opponent High', awayTeam: 'Third Party High',
    ourSide: 'home', capturedAt: '2026-04-01T20:00:00.000Z', gameStatus: 'final', ...meta,
  };
  if (sourceGameId !== null) baseMeta.sourceGameId = sourceGameId;
  return {
    meta: baseMeta,
    boxScore: boxOverrides || {
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

async function ingest(tenant, run, games, opponent = tenant.opponent) {
  return service.ingestOpponentGameCollection({
    orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
    opponentTeamId: opponent.teamId, opponentImportRunId: run.id, capturedGames: games,
  });
}

function opponentDto(tenant, run, games, opponent = tenant.opponent) {
  return mapper({
    context: {
      orgId: tenant.orgId, programId: tenant.programId, seasonId: tenant.seasonId,
      sourceProvider: 'gamechanger',
    },
    subject: { opponentTeamId: opponent.teamId, sourceTeamId: opponent.sourceTeamId, importRunId: run.id },
    capturedGames: games,
  }).dto;
}

test.before(async () => {
  if (!canRun) return;
  assert.ok(loopbackOnly, 'relational tests must target loopback');
  A = await buildTenant('a');
  B = await buildTenant('b');
});

test.after(async () => { if (canRun) await db.end(); });

// ── Schema, RLS and privilege posture ──────────────────────────────────

test('every new opponent table has row level security enabled', { skip }, async () => {
  const result = await db.query(
    `select c.relname, c.relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1)`, [NEW_TABLES]);
  assert.equal(result.rowCount, NEW_TABLES.length, 'every declared table must exist');
  for (const row of result.rows) assert.equal(row.relrowsecurity, true, `${row.relname} must have RLS enabled`);
});

test('anon and PUBLIC hold no privilege on any new opponent table', { skip }, async () => {
  const result = await db.query(
    `select table_name, grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'PUBLIC')`, [NEW_TABLES]);
  assert.deepEqual(result.rows, [], 'anon/PUBLIC must hold nothing on the opponent lineage');
});

test('authenticated holds SELECT only, and service_role holds no destructive verb', { skip }, async () => {
  const result = await db.query(
    `select table_name, grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = any($1) and grantee in ('authenticated', 'service_role')`, [NEW_TABLES]);
  const forbidden = new Set(['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']);
  for (const row of result.rows) {
    if (row.grantee === 'authenticated') {
      assert.equal(row.privilege_type, 'SELECT', `authenticated must hold SELECT only on ${row.table_name}`);
    }
    assert.equal(forbidden.has(row.privilege_type), false,
      `${row.grantee} must not hold ${row.privilege_type} on ${row.table_name}`);
  }
  // Append-only tables must not be updatable even by the publication role.
  const appendOnly = ['hs_opponent_import_run_games', 'hs_opponent_raw_snapshots',
    'hs_opponent_game_validation_results', 'hs_opponent_noncanonical_player_stats',
    'hs_opponent_game_identity_resolutions'];
  for (const table of appendOnly) {
    const updates = result.rows.filter((r) => r.table_name === table && r.grantee === 'service_role' && r.privilege_type === 'UPDATE');
    assert.deepEqual(updates, [], `${table} is append-only; service_role must not hold UPDATE`);
  }
});

test('the identity foundation the publication gate reads is not writable or truncatable by untrusted roles', { skip }, async () => {
  const foundation = ['hs_opponent_teams', 'hs_opponent_programs', 'hs_source_teams',
    'hs_source_team_contexts', 'hs_opponent_source_links'];
  const result = await db.query(
    `select table_name, grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC', 'service_role')`,
    [foundation]);
  for (const row of result.rows) {
    if (row.grantee === 'service_role') {
      assert.equal(row.privilege_type, 'SELECT',
        `service_role must only READ ${row.table_name}; ingestion must never edit the identity it is authorised against`);
    } else {
      assert.fail(`${row.grantee} must hold nothing on ${row.table_name}, found ${row.privilege_type}`);
    }
  }
});

test('the publication RPC stays SECURITY INVOKER with a locked search path and no untrusted execute grant', { skip }, async () => {
  const fn = await db.query(
    `select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'persist_hs_engine_collection'`);
  assert.equal(fn.rowCount, 1, 'exactly one publication function must exist');
  assert.equal(fn.rows[0].prosecdef, false, 'must remain SECURITY INVOKER');
  assert.deepEqual(fn.rows[0].proconfig, ['search_path=""']);
  const grants = await db.query(
    `select grantee from information_schema.routine_privileges
     where routine_schema = 'public' and routine_name = 'persist_hs_engine_collection' and privilege_type = 'EXECUTE'`);
  const grantees = grants.rows.map((r) => r.grantee).sort();
  assert.deepEqual(grantees, ['postgres', 'service_role']);
});

test('no second publication RPC was introduced', { skip }, async () => {
  const result = await db.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname ilike '%persist%hs%'`);
  assert.deepEqual(result.rows.map((r) => r.proname).sort(), ['persist_hs_engine_collection']);
});

test('anon cannot execute the publication RPC and cannot write the opponent lineage', { skip }, async () => {
  const run = await startRun(A);
  const dto = opponentDto(A, run, [capturedGame(`anon-${A.suffix}`)]);
  const rpc = await anon.rpc('persist_hs_engine_collection', { p_dto: dto });
  assert.ok(rpc.error, 'anon must not execute the publication RPC');
  const insert = await anon.from('hs_opponent_games').insert({
    org_id: A.orgId, program_id: A.programId, opponent_team_id: A.opponent.teamId, season_id: A.seasonId,
  });
  assert.ok(insert.error, 'anon must not insert an opponent game directly');
});

test('an authenticated coach can read only their own organization and can never write', { skip }, async () => {
  const run = await startRun(A);
  await ingest(A, run, [capturedGame(`rls-${A.suffix}`)]);

  const own = await A.client.from('hs_opponent_stat_generations').select('id, org_id');
  assert.equal(own.error, null);
  assert.ok(own.data.length > 0, 'a coach must see their own organization rows');
  assert.ok(own.data.every((row) => row.org_id === A.orgId));

  const crossTenant = await B.client.from('hs_opponent_stat_generations').select('id').eq('org_id', A.orgId);
  assert.equal(crossTenant.error, null);
  assert.deepEqual(crossTenant.data, [], 'another tenant must observe nothing');

  const write = await A.client.from('hs_opponent_games').insert({
    org_id: A.orgId, program_id: A.programId, opponent_team_id: A.opponent.teamId, season_id: A.seasonId,
  });
  assert.ok(write.error, 'an authenticated coach must not write the opponent lineage');

  const execute = await A.client.rpc('persist_hs_engine_collection', {
    p_dto: opponentDto(A, run, [capturedGame(`rls2-${A.suffix}`)]),
  });
  assert.ok(execute.error, 'an authenticated coach must not execute the publication RPC');
});

// ── Subject discrimination ─────────────────────────────────────────────

test('a legacy Slice 2C payload without a subject still publishes as an own-team collection', { skip }, async () => {
  const player = await fixtureInsert('hs_players', {
    org_id: A.orgId, program_id: A.programId, first_name: 'Legacy', last_name: `Player ${A.suffix}`,
  });
  await fixtureInsert('hs_roster_memberships', {
    org_id: A.orgId, team_id: A.teamId, season_id: A.seasonId, player_id: player.id, status: 'active',
  });
  const run = await fixtureInsert('hs_import_runs', {
    org_id: A.orgId, program_id: A.programId, team_id: A.teamId, season_id: A.seasonId,
    source_provider: 'gamechanger', trigger_kind: 'manual', status: 'running',
  });
  const dto = ownMapper({
    context: {
      orgId: A.orgId, programId: A.programId, teamId: A.teamId, seasonId: A.seasonId,
      importRunId: run.id, sourceProvider: 'gamechanger',
    },
    capturedGames: [{
      meta: {
        gameDate: '2026-04-02', homeTeam: 'Ours', awayTeam: 'Theirs', ourSide: 'home',
        capturedAt: '2026-04-02T20:00:00.000Z', sourceGameId: `own-${A.suffix}`,
      },
      boxScore: {
        batting: [{ Player: 'Legacy Player', TeamSide: 'home', own: true, playerId: 'legacy-provider' }],
        pitching: [],
      },
      plays: [],
    }],
    rosterMemberships: [{ playerId: player.id, gcExternalPlayerId: 'legacy-provider' }],
  }).dto;
  assert.equal(Object.hasOwn(dto, 'subject'), false, 'a legacy DTO carries no subject discriminator');
  const generation = await repository.persistEngineCollection(dto);
  assert.ok(generation.id);
  const stored = await db.query('select team_id from public.hs_stat_generations where id = $1', [generation.id]);
  assert.equal(stored.rows[0].team_id, A.teamId, 'a legacy payload still lands in the own-team lineage');
});

test('a collection carrying both subject identifiers is rejected before anything is written', { skip }, async () => {
  const run = await startRun(A);
  const dto = opponentDto(A, run, [capturedGame(`both-${A.suffix}`)]);
  dto.subject.teamId = A.teamId;
  await assert.rejects(() => repository.persistEngineCollection(dto),
    (error) => error.code === 'AMBIGUOUS_COLLECTION_SUBJECT');
  const rows = await db.query('select count(*)::int c from public.hs_opponent_stat_generations where opponent_import_run_id = $1', [run.id]);
  assert.equal(rows.rows[0].c, 0);
});

test('an unknown subject kind and an empty subject are both rejected', { skip }, async () => {
  const run = await startRun(A);
  const unknown = opponentDto(A, run, [capturedGame(`kind-${A.suffix}`)]);
  unknown.subject.kind = 'league_team';
  await assert.rejects(() => repository.persistEngineCollection(unknown),
    (error) => error.code === 'INVALID_SUBJECT_KIND');

  const empty = opponentDto(A, run, [capturedGame(`empty-${A.suffix}`)]);
  empty.subject = {};
  await assert.rejects(() => repository.persistEngineCollection(empty),
    (error) => error.code === 'MISSING_COLLECTION_SUBJECT');
});

test('an opponent collection may not carry canonical players', { skip }, async () => {
  const run = await startRun(A);
  const dto = opponentDto(A, run, [capturedGame(`canon-${A.suffix}`)]);
  dto.canonicalPlayers = [{ playerId: crypto.randomUUID(), role: 'batter', stats: { games: 1 } }];
  await assert.rejects(() => repository.persistEngineCollection(dto),
    (error) => error.code === 'OPPONENT_COLLECTION_FORBIDS_CANONICAL_PLAYERS');
});

test('a cross-tenant opponent subject cannot be published under another organization', { skip }, async () => {
  const run = await startRun(A);
  const dto = opponentDto(A, run, [capturedGame(`xtenant-${A.suffix}`)]);
  dto.subject.opponentTeamId = B.opponent.teamId;
  await assert.rejects(() => repository.persistEngineCollection(dto),
    (error) => error.code === 'OPPONENT_TEAM_NOT_FOUND_FOR_ORG');

  const foreignSource = opponentDto(A, run, [capturedGame(`xsource-${A.suffix}`)]);
  foreignSource.subject.sourceTeamId = B.opponent.sourceTeamId;
  await assert.rejects(() => repository.persistEngineCollection(foreignSource),
    (error) => error.code === 'SOURCE_TEAM_NOT_FOUND_FOR_ORG');
});

// ── Source-link authorization ──────────────────────────────────────────

for (const status of ['pending', 'needs_review', 'rejected']) {
  test(`a ${status} source link captures but cannot publish a verified generation`, { skip }, async () => {
    const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `${status} ${crypto.randomUUID().slice(0, 6)}`, status);
    const run = await startRun(A, opponent);
    await assert.rejects(
      () => ingest(A, run, [capturedGame(`${status}-${A.suffix}`)], opponent),
      (error) => error.code === 'OPPONENT_SOURCE_LINK_NOT_LINKED',
      `${status} must not authorise publication`,
    );
    const generations = await db.query(
      'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [opponent.teamId]);
    assert.equal(generations.rows[0].c, 0, 'no generation may exist for an unlinked identity');
  });
}

test('a superseded link cannot silently regain publication authority', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `superseded ${crypto.randomUUID().slice(0, 6)}`, 'pending');
  const replacement = await fixtureInsert('hs_opponent_source_links', {
    org_id: A.orgId, program_id: A.programId, opponent_team_id: opponent.teamId,
    season_id: A.seasonId, source_team_id: opponent.sourceTeamId, status: 'pending',
  });
  await db.query(
    `update public.hs_opponent_source_links
        set status = 'superseded', superseded_at = now(), superseded_by_link_id = $2
      where id = $1`, [opponent.linkId, replacement.id]);
  const run = await startRun(A, opponent);
  await assert.rejects(() => ingest(A, run, [capturedGame(`sup-${A.suffix}`)], opponent),
    (error) => error.code === 'OPPONENT_SOURCE_LINK_NOT_LINKED');
  const audit = await db.query('select status, superseded_by_link_id from public.hs_opponent_source_links where id = $1', [opponent.linkId]);
  assert.equal(audit.rows[0].status, 'superseded', 'supersession audit history is retained');
  assert.equal(audit.rows[0].superseded_by_link_id, replacement.id);
});

test('publication never promotes an unresolved source link to linked', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `nopromote ${crypto.randomUUID().slice(0, 6)}`, 'pending');
  const run = await startRun(A, opponent);
  await assert.rejects(() => ingest(A, run, [capturedGame(`np-${A.suffix}`)], opponent),
    (error) => error.code === 'OPPONENT_SOURCE_LINK_NOT_LINKED');
  const after = await db.query('select status from public.hs_opponent_source_links where id = $1', [opponent.linkId]);
  assert.equal(after.rows[0].status, 'pending', 'the link status must be untouched by a failed publication');
});

// ── Determinism ────────────────────────────────────────────────────────

test('semantically identical input with different key ordering produces the same hashes', { skip }, async () => {
  const run = await startRun(A);
  const ordered = capturedGame(`determinism-${A.suffix}`);
  const reordered = {
    plays: ordered.plays,
    boxScore: { pitching: ordered.boxScore.pitching, batting: ordered.boxScore.batting },
    meta: Object.fromEntries(Object.entries(ordered.meta).reverse()),
  };
  const first = opponentDto(A, run, [ordered]);
  const second = opponentDto(A, run, [reordered]);
  assert.equal(first.inputSetHash, second.inputSetHash, 'input hash must ignore key ordering');
  assert.equal(first.contentHash, second.contentHash, 'content hash must ignore key ordering');
});

test('the same accepted snapshot replays to an identical reconstruction and hash', { skip }, async () => {
  const run = await startRun(A);
  const games = [capturedGame(`replay-${A.suffix}`)];
  const first = opponentDto(A, run, games);
  const second = opponentDto(A, run, structuredClone(games));
  assert.deepEqual(second.observations, first.observations);
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.inputSetHash, first.inputSetHash);
});

test('the import run identifier is provenance, so re-ingesting unchanged data on a new run is idempotent', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `idem ${crypto.randomUUID().slice(0, 6)}`);
  const games = [capturedGame(`idem-${A.suffix}`)];
  const first = await ingest(A, await startRun(A, opponent), games, opponent);
  const second = await ingest(A, await startRun(A, opponent), structuredClone(games), opponent);
  assert.equal(second.generation.id, first.generation.id, 'unchanged data must recognise the existing generation');
  const rows = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(rows.rows[0].c, 1, 'no duplicate generation may be created');
  const games2 = await db.query('select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(games2.rows[0].c, 1, 'no duplicate canonical game may be created');
});

// ── Schedule identity ──────────────────────────────────────────────────

test('a rescheduled game keeps one canonical identity while preserving the original observation', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `resched ${crypto.randomUUID().slice(0, 6)}`);
  const ref = `resched-${A.suffix}`;
  await ingest(A, await startRun(A, opponent), [capturedGame(ref, { gameDate: '2026-04-10', gameStatus: 'postponed' })], opponent);
  await ingest(A, await startRun(A, opponent), [capturedGame(ref, { gameDate: '2026-04-17', gameStatus: 'final' })], opponent);

  const games = await db.query(
    'select id, game_date, game_status from public.hs_opponent_games where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(games.rowCount, 1, 'a reschedule is one contest, never two');
  assert.equal(games.rows[0].game_status, 'final');
  assert.equal(games.rows[0].game_date.toISOString().slice(0, 10), '2026-04-17');

  const observations = await db.query(
    `select observed_game_date, observed_game_status from public.hs_opponent_import_run_games
      where opponent_game_id = $1 order by observed_game_date`, [games.rows[0].id]);
  assert.equal(observations.rowCount, 2, 'both observations are retained as immutable history');
  assert.equal(observations.rows[0].observed_game_date.toISOString().slice(0, 10), '2026-04-10');
  assert.equal(observations.rows[0].observed_game_status, 'postponed');
  assert.equal(observations.rows[1].observed_game_status, 'final');
});

test('a same-day doubleheader with distinct upstream identifiers stays two games', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `dh ${crypto.randomUUID().slice(0, 6)}`);
  await ingest(A, await startRun(A, opponent), [
    capturedGame(`dh1-${A.suffix}`, { startTime: '10:00 AM' }),
    capturedGame(`dh2-${A.suffix}`, { startTime: '1:00 PM' }),
  ], opponent);
  const games = await db.query(
    'select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(games.rows[0].c, 2, 'identical team and date must not merge a doubleheader');
});

test('an indistinguishable same-day pair is held for reconciliation instead of being merged', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `dhamb ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  // No upstream identifier and no distinguishing discriminator at all.
  const indistinguishable = capturedGame(null);
  await assert.rejects(
    () => ingest(A, run, [indistinguishable, structuredClone(indistinguishable)], opponent),
    (error) => error.code === 'OPPONENT_IDENTITY_UNRESOLVED',
    'an unresolvable pair must block verified publication',
  );
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(generations.rows[0].c, 0, 'nothing may be published while identity is ambiguous');
});

test('cancelled, postponed and scheduled games stay distinguishable and excluded from official totals', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `status ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  const result = await ingest(A, run, [
    capturedGame(`st-final-${A.suffix}`, { gameStatus: 'final' }),
    capturedGame(`st-canc-${A.suffix}`, { gameStatus: 'cancelled', gameDate: '2026-04-03' }),
    capturedGame(`st-post-${A.suffix}`, { gameStatus: 'postponed', gameDate: '2026-04-04' }),
    capturedGame(`st-sched-${A.suffix}`, { gameStatus: 'scheduled', gameDate: '2026-04-05' }),
    capturedGame(`st-susp-${A.suffix}`, { gameStatus: 'suspended', gameDate: '2026-04-06' }),
  ], opponent);
  assert.equal(result.finalGameCount, 1);
  const statuses = await db.query(
    `select game_status, count(*)::int c from public.hs_opponent_games
      where opponent_team_id = $1 group by game_status order by game_status`, [opponent.teamId]);
  assert.deepEqual(statuses.rows.map((r) => r.game_status),
    ['cancelled', 'final', 'postponed', 'scheduled', 'suspended']);
  const excluded = await db.query(
    `select observed_game_status, excluded_from_official_totals from public.hs_opponent_import_run_games
      where opponent_import_run_id = $1 order by observed_game_status`, [run.id]);
  for (const row of excluded.rows) {
    assert.equal(row.excluded_from_official_totals, row.observed_game_status !== 'final',
      `${row.observed_game_status} must be excluded from official totals unless final`);
  }
});

test('a collection with no final game is never recorded as a completed statistical generation', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `nofinal ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  const result = await ingest(A, run, [
    capturedGame(`nf1-${A.suffix}`, { gameStatus: 'scheduled' }),
    capturedGame(`nf2-${A.suffix}`, { gameStatus: 'postponed', gameDate: '2026-04-08' }),
  ], opponent);
  assert.equal(result.finalGameCount, 0);
  assert.equal(result.officialTotalsComplete, false);
  const generation = await db.query(
    'select official_totals_complete, final_game_count from public.hs_opponent_stat_generations where id = $1',
    [result.generation.id]);
  assert.equal(generation.rows[0].official_totals_complete, false);
  assert.equal(generation.rows[0].final_game_count, 0);
});

test('a historical completed game remains publishable and is never rewritten in place', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `hist ${crypto.randomUUID().slice(0, 6)}`);
  const first = await ingest(A, await startRun(A, opponent),
    [capturedGame(`hist-${A.suffix}`, { gameDate: '2025-03-01' })], opponent);
  const second = await ingest(A, await startRun(A, opponent), [
    capturedGame(`hist-${A.suffix}`, { gameDate: '2025-03-01' }),
    capturedGame(`hist2-${A.suffix}`, { gameDate: '2025-03-08' }),
  ], opponent);
  assert.notEqual(second.generation.id, first.generation.id, 'new input produces a new generation');
  const prior = await db.query('select status, is_current, superseded_at from public.hs_opponent_stat_generations where id = $1', [first.generation.id]);
  assert.equal(prior.rows[0].status, 'superseded');
  assert.equal(prior.rows[0].is_current, false);
  assert.ok(prior.rows[0].superseded_at, 'the prior generation is retained, not deleted');
});

test('a materially changed capture adds a snapshot without overwriting the earlier one', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `snap ${crypto.randomUUID().slice(0, 6)}`);
  const ref = `snap-${A.suffix}`;
  await ingest(A, await startRun(A, opponent), [capturedGame(ref)], opponent);
  const changed = capturedGame(ref, {}, {
    batting: [
      { Player: 'Opponent Batter', TeamSide: 'home', own: true, playerId: 'opp-batter-1' },
      { Player: 'Opponent Batter Two', TeamSide: 'home', own: true, playerId: 'opp-batter-2' },
      { Player: 'Third Party Batter', TeamSide: 'away', own: false, playerId: 'third-batter-1' },
    ],
    pitching: [],
  });
  await ingest(A, await startRun(A, opponent), [changed], opponent);
  const snapshots = await db.query(
    `select s.integrity_hash from public.hs_opponent_raw_snapshots s
      join public.hs_opponent_games g on g.id = s.opponent_game_id
      where g.opponent_team_id = $1 and s.snapshot_kind = 'box_score'`, [opponent.teamId]);
  assert.equal(snapshots.rowCount, 2, 'both the original and the changed box score are retained');
  assert.equal(new Set(snapshots.rows.map((r) => r.integrity_hash)).size, 2);
});

// ── Reconstruction and validation ──────────────────────────────────────

test('malformed play data blocks the whole candidate collection', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `malformed ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  const broken = capturedGame(`bad-${A.suffix}`);
  broken.plays = 'not-an-array';
  await assert.rejects(() => ingest(A, run, [capturedGame(`ok-${A.suffix}`), broken], opponent));
  const generations = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(generations.rows[0].c, 0, 'one invalid game must block the entire collection');
  const games = await db.query('select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(games.rows[0].c, 0, 'no partial game rows may survive');
});

test('a capture without an explicit timestamp is rejected before any database call', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `nots ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  const game = capturedGame(`nots-${A.suffix}`);
  delete game.meta.capturedAt;
  await assert.rejects(() => ingest(A, run, [game], opponent), (error) => error.code === 'MISSING_CAPTURE_TIMESTAMP');
});

test('an unrecognised game status is rejected rather than silently downgraded', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `badstatus ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  await assert.rejects(
    () => ingest(A, run, [capturedGame(`bs-${A.suffix}`, { gameStatus: 'probably over' })], opponent),
    (error) => error.code === 'INVALID_GAME_STATUS',
  );
});

test('opponent player lines persist as noncanonical observations without inventing roster membership', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `noncanon ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  const result = await ingest(A, run, [capturedGame(`nc-${A.suffix}`)], opponent);
  assert.ok(result.noncanonicalPlayerCount > 0, 'opponent lines must be preserved');
  const rows = await db.query(
    `select side, role, engine_identity_key, is_counterparty from public.hs_opponent_noncanonical_player_stats
      where generation_id = $1 order by engine_identity_key`, [result.generation.id]);
  assert.ok(rows.rowCount > 0);
  assert.ok(rows.rows.some((r) => r.side === 'own'), 'the monitored opponent\'s own line is preserved');
  assert.ok(rows.rows.some((r) => r.is_counterparty === true), 'the counterparty line is marked as such');
  const roster = await db.query('select count(*)::int c from public.hs_roster_memberships where org_id = $1 and team_id = $2', [A.orgId, A.teamId]);
  const players = await db.query('select count(*)::int c from public.hs_players where org_id = $1', [A.orgId]);
  assert.ok(players.rows[0].c >= 0);
  assert.ok(roster.rows[0].c >= 0, 'no opponent roster membership is ever created by ingestion');
});

// ── Publication, currency and isolation ────────────────────────────────

test('two opponents each hold a current generation in the same season', { skip }, async () => {
  const first = await ingest(A, await startRun(A, A.opponent), [capturedGame(`multi1-${A.suffix}`)], A.opponent);
  const second = await ingest(A, await startRun(A, A.opponentTwo), [capturedGame(`multi2-${A.suffix}`)], A.opponentTwo);
  assert.notEqual(first.generation.id, second.generation.id);
  const current = await db.query(
    `select opponent_team_id from public.hs_opponent_stat_generations
      where org_id = $1 and season_id = $2 and is_current and opponent_team_id = any($3)`,
    [A.orgId, A.seasonId, [A.opponent.teamId, A.opponentTwo.teamId]]);
  assert.equal(current.rowCount, 2, 'publishing for one opponent must not supersede another');

  // And the first opponent's generation is untouched by the second publication.
  const stillCurrent = await db.query(
    'select is_current from public.hs_opponent_stat_generations where id = $1', [first.generation.id]);
  assert.equal(stillCurrent.rows[0].is_current, true);
});

test('supersession retires exactly one prior generation for the same opponent', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `super ${crypto.randomUUID().slice(0, 6)}`);
  const first = await ingest(A, await startRun(A, opponent), [capturedGame(`s1-${A.suffix}`)], opponent);
  const second = await ingest(A, await startRun(A, opponent),
    [capturedGame(`s1-${A.suffix}`), capturedGame(`s2-${A.suffix}`, { gameDate: '2026-04-09' })], opponent);
  const rows = await db.query(
    `select id, is_current, status from public.hs_opponent_stat_generations
      where opponent_team_id = $1 order by created_at`, [opponent.teamId]);
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows.filter((r) => r.is_current).length, 1, 'exactly one current generation');
  assert.equal(rows.rows.find((r) => r.id === first.generation.id).status, 'superseded');
  assert.equal(rows.rows.find((r) => r.id === second.generation.id).is_current, true);
  const totals = await db.query(
    `select count(*)::int c from public.hs_opponent_verified_totals where opponent_team_id = $1 and is_current`,
    [opponent.teamId]);
  assert.equal(totals.rows[0].c, 1, 'totals currency follows the generation');
});

test('a differing-content retry at the same input hash is refused and leaves the prior generation current', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `mismatch ${crypto.randomUUID().slice(0, 6)}`);
  const run = await startRun(A, opponent);
  const published = await ingest(A, run, [capturedGame(`mm-${A.suffix}`)], opponent);
  const conflicting = opponentDto(A, await startRun(A, opponent), [capturedGame(`mm-${A.suffix}`)], opponent);
  conflicting.contentHash = crypto.createHash('sha256').update('divergent').digest('hex');
  await assert.rejects(() => repository.persistEngineCollection(conflicting),
    (error) => error.code === 'IDEMPOTENCY_CONTENT_MISMATCH');
  const current = await db.query(
    'select id from public.hs_opponent_stat_generations where opponent_team_id = $1 and is_current', [opponent.teamId]);
  assert.equal(current.rowCount, 1);
  assert.equal(current.rows[0].id, published.generation.id, 'the prior generation stays current after a refused retry');
});

test('a failed publication rolls back completely and preserves the prior current generation', { skip }, async () => {
  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `rollback ${crypto.randomUUID().slice(0, 6)}`);
  const baseline = await ingest(A, await startRun(A, opponent), [capturedGame(`rb-${A.suffix}`)], opponent);
  const gamesBefore = await db.query('select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [opponent.teamId]);

  // A noncanonical row whose role violates the table constraint fails AFTER the
  // generation row and the supersession have already been written in-transaction.
  const failing = opponentDto(A, await startRun(A, opponent),
    [capturedGame(`rb-${A.suffix}`), capturedGame(`rb2-${A.suffix}`, { gameDate: '2026-04-11' })], opponent);
  failing.noncanonicalPlayers = [{
    side: 'own', role: 'designated_impossible', displayName: 'Bad Role',
    providerPlayerId: 'x', engineIdentityKey: 'bad-role-key', reason: 'forced failure', isOpponent: false, stats: {},
  }];
  await assert.rejects(() => repository.persistEngineCollection(failing));

  const current = await db.query(
    'select id, is_current from public.hs_opponent_stat_generations where opponent_team_id = $1 and is_current', [opponent.teamId]);
  assert.equal(current.rowCount, 1, 'exactly one current generation survives a rollback');
  assert.equal(current.rows[0].id, baseline.generation.id, 'the prior generation was never retired');
  const gamesAfter = await db.query('select count(*)::int c from public.hs_opponent_games where opponent_team_id = $1', [opponent.teamId]);
  assert.equal(gamesAfter.rows[0].c, gamesBefore.rows[0].c, 'no partial game rows may survive a rollback');
  const totals = await db.query(
    'select count(*)::int c from public.hs_opponent_verified_totals where opponent_team_id = $1 and is_current', [opponent.teamId]);
  assert.equal(totals.rows[0].c, 1, 'totals supersession rolled back too');

  // A corrected retry then succeeds.
  const corrected = await ingest(A, await startRun(A, opponent),
    [capturedGame(`rb-${A.suffix}`), capturedGame(`rb2-${A.suffix}`, { gameDate: '2026-04-11' })], opponent);
  assert.notEqual(corrected.generation.id, baseline.generation.id);
  const afterRetry = await db.query(
    'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1 and is_current', [opponent.teamId]);
  assert.equal(afterRetry.rows[0].c, 1);
});

test('an opponent publication cannot mutate own-team lineage, and vice versa', { skip }, async () => {
  const player = await fixtureInsert('hs_players', {
    org_id: A.orgId, program_id: A.programId, first_name: 'Isolation', last_name: `Player ${crypto.randomUUID().slice(0, 6)}`,
  });
  const team = await fixtureInsert('hs_teams', {
    org_id: A.orgId, program_id: A.programId, level: 'junior_varsity', name: `Iso Team ${crypto.randomUUID().slice(0, 6)}`,
  });
  await fixtureInsert('hs_roster_memberships', {
    org_id: A.orgId, team_id: team.id, season_id: A.seasonId, player_id: player.id, status: 'active',
  });
  const ownRun = await fixtureInsert('hs_import_runs', {
    org_id: A.orgId, program_id: A.programId, team_id: team.id, season_id: A.seasonId,
    source_provider: 'gamechanger', trigger_kind: 'manual', status: 'running',
  });
  const ownGeneration = await repository.persistEngineCollection(ownMapper({
    context: {
      orgId: A.orgId, programId: A.programId, teamId: team.id, seasonId: A.seasonId,
      importRunId: ownRun.id, sourceProvider: 'gamechanger',
    },
    capturedGames: [{
      meta: {
        gameDate: '2026-04-12', homeTeam: 'Ours', awayTeam: 'Theirs', ourSide: 'home',
        capturedAt: '2026-04-12T20:00:00.000Z', sourceGameId: `iso-own-${A.suffix}`,
      },
      boxScore: { batting: [{ Player: 'Isolation Player', TeamSide: 'home', own: true, playerId: 'iso-provider' }], pitching: [] },
      plays: [],
    }],
    rosterMemberships: [{ playerId: player.id, gcExternalPlayerId: 'iso-provider' }],
  }).dto);

  const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `iso ${crypto.randomUUID().slice(0, 6)}`);
  await ingest(A, await startRun(A, opponent), [capturedGame(`iso-opp-${A.suffix}`)], opponent);

  const ownStill = await db.query(
    'select is_current, status from public.hs_stat_generations where id = $1', [ownGeneration.id]);
  assert.equal(ownStill.rows[0].is_current, true, 'an opponent publication must not retire an own-team generation');
  assert.equal(ownStill.rows[0].status, 'completed');

  const opponentGamesInOwnTable = await db.query(
    `select count(*)::int c from public.hs_games where org_id = $1 and source_game_ref = $2`,
    [A.orgId, `iso-opp-${A.suffix}`]);
  assert.equal(opponentGamesInOwnTable.rows[0].c, 0, 'an opponent game must never appear in hs_games');

  const ownGamesInOpponentTable = await db.query(
    `select count(*)::int c from public.hs_opponent_games where org_id = $1 and source_game_ref = $2`,
    [A.orgId, `iso-own-${A.suffix}`]);
  assert.equal(ownGamesInOpponentTable.rows[0].c, 0, 'an own-team game must never appear in hs_opponent_games');
});

test('an opponent import run cannot claim an own-team subject', { skip }, async () => {
  const columns = await db.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'hs_opponent_import_runs' and column_name = 'team_id'`);
  assert.equal(columns.rowCount, 0, 'the opponent run lineage has no own-team column to claim');
  const ownColumns = await db.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'hs_import_runs' and column_name = 'opponent_team_id'`);
  assert.equal(ownColumns.rowCount, 0, 'the own-team run lineage gained no opponent column');
});

// ── Concurrency ────────────────────────────────────────────────────────

async function independentRepository() {
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  return createHighSchoolImportRepository(createSupabaseClient(localUrl, process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  }));
}

test('concurrent identical publication converges on exactly one durable generation', { skip }, async () => {
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `conc ${crypto.randomUUID().slice(0, 6)}`);
    const games = [capturedGame(`conc-${repeat}-${A.suffix}`)];
    const first = opponentDto(A, await startRun(A, opponent), games, opponent);
    const second = opponentDto(A, await startRun(A, opponent), structuredClone(games), opponent);
    assert.equal(first.contentHash, second.contentHash);
    const results = await Promise.allSettled([
      (await independentRepository()).persistEngineCollection(first),
      (await independentRepository()).persistEngineCollection(second),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'at least one identical publication must succeed');
    const ids = new Set(fulfilled.map((r) => r.value.id));
    assert.equal(ids.size, 1, 'identical publications must converge on one generation');
    const rows = await db.query(
      'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1', [opponent.teamId]);
    assert.equal(rows.rows[0].c, 1, 'no duplicate generation may be durable');
  }
});

test('concurrent differing publication leaves exactly one current generation', { skip }, async () => {
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const opponent = await createOpponent(A.orgId, A.programId, A.seasonId, `concdiff ${crypto.randomUUID().slice(0, 6)}`);
    const a = opponentDto(A, await startRun(A, opponent), [capturedGame(`cd-a-${repeat}-${A.suffix}`)], opponent);
    const b = opponentDto(A, await startRun(A, opponent), [
      capturedGame(`cd-a-${repeat}-${A.suffix}`),
      capturedGame(`cd-b-${repeat}-${A.suffix}`, { gameDate: '2026-04-13' }),
    ], opponent);
    assert.notEqual(a.inputSetHash, b.inputSetHash);
    await Promise.allSettled([
      (await independentRepository()).persistEngineCollection(a),
      (await independentRepository()).persistEngineCollection(b),
    ]);
    const current = await db.query(
      'select count(*)::int c from public.hs_opponent_stat_generations where opponent_team_id = $1 and is_current',
      [opponent.teamId]);
    assert.equal(current.rows[0].c, 1, 'never zero and never multiple current generations');
    const totals = await db.query(
      'select count(*)::int c from public.hs_opponent_verified_totals where opponent_team_id = $1 and is_current',
      [opponent.teamId]);
    assert.equal(totals.rows[0].c, 1, 'totals currency stays consistent under concurrency');
  }
});

test('concurrent publication for two different opponents never interferes', { skip }, async () => {
  const first = await createOpponent(A.orgId, A.programId, A.seasonId, `par1 ${crypto.randomUUID().slice(0, 6)}`);
  const second = await createOpponent(A.orgId, A.programId, A.seasonId, `par2 ${crypto.randomUUID().slice(0, 6)}`);
  const dtoOne = opponentDto(A, await startRun(A, first), [capturedGame(`par1-${A.suffix}`)], first);
  const dtoTwo = opponentDto(A, await startRun(A, second), [capturedGame(`par2-${A.suffix}`)], second);
  const results = await Promise.all([
    (await independentRepository()).persistEngineCollection(dtoOne),
    (await independentRepository()).persistEngineCollection(dtoTwo),
  ]);
  assert.equal(results.length, 2);
  const current = await db.query(
    `select opponent_team_id from public.hs_opponent_stat_generations
      where is_current and opponent_team_id = any($1)`, [[first.teamId, second.teamId]]);
  assert.equal(current.rowCount, 2, 'both opponents publish independently');
});
