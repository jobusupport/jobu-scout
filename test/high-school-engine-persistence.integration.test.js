'use strict';

// Slice 2C relational contract tests. These tests intentionally accept only
// an explicitly supplied LOCAL Supabase URL. They cannot use SUPABASE_URL,
// cannot resolve a project ref, and refuse every non-loopback host.
//
// Disposable-stack invocation:
//   RUN_HS_ENGINE_LOCAL_DB_TESTS=1
//   HS_LOCAL_SUPABASE_URL=http://127.0.0.1:54321
//   HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY=<local status output>
//   HS_LOCAL_SUPABASE_ANON_KEY=<local status output>
//   HS_LOCAL_JWT_SECRET=<local status output>
//   HS_LOCAL_PG_HOST=127.0.0.1 HS_LOCAL_PG_PORT=54322
//   HS_LOCAL_PG_DATABASE=postgres HS_LOCAL_PG_USER=postgres HS_LOCAL_PG_PASSWORD=<local password>
//   node --test test/high-school-engine-persistence.integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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

let admin;
let anon;
let authorizedUser;
let crossTenantUser;
let unaffiliatedUser;
let fixtureDb;
let createSupabaseClient;
let repository;
let mapper;
let ids;
let PgClient;

function relationalTest(name, options, fn) {
  if (!process.env.HS_RELATIONAL_TEST_NAME || process.env.HS_RELATIONAL_TEST_NAME === name) {
    test(name, options, fn);
  }
}

if (canRun) {
  const { createClient } = require('@supabase/supabase-js');
  createSupabaseClient = createClient;
  const { Pool, Client } = require('pg');
  PgClient = Client;
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  ({ mapHighSchoolEngineCollection: mapper } = require('../src/high-school-engine-persistence-mapper'));
  admin = createClient(localUrl, process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  anon = createClient(localUrl, process.env.HS_LOCAL_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  fixtureDb = new Pool({
    host: process.env.HS_LOCAL_PG_HOST,
    port: Number(process.env.HS_LOCAL_PG_PORT),
    database: process.env.HS_LOCAL_PG_DATABASE,
    user: process.env.HS_LOCAL_PG_USER,
    password: process.env.HS_LOCAL_PG_PASSWORD,
    max: 2,
  });
  repository = createHighSchoolImportRepository(admin);
}

const fixtureTables = new Set([
  'organizations', 'hs_programs', 'hs_seasons', 'hs_teams', 'hs_players',
  'hs_roster_memberships', 'hs_import_runs', 'profiles', 'org_members',
]);

async function fixtureInsert(table, values) {
  assert.ok(fixtureTables.has(table), `fixture table is not allowlisted: ${table}`);
  const columns = Object.keys(values);
  const params = Object.values(values);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `insert into public.${table} (${columns.map((column) => `"${column}"`).join(', ')}) values (${placeholders}) returning *`;
  const result = await fixtureDb.query(sql, params);
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
  await fixtureDb.query(
    `insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [userId, `slice2c-${userId}@local.invalid`],
  );
  if (orgId) await fixtureInsert('org_members', { org_id: orgId, user_id: userId, role: 'coach', accepted_at: new Date() });
  return userId;
}

async function createRun(contextIds = ids) {
  return fixtureInsert('hs_import_runs', {
    org_id: contextIds.orgId,
    program_id: contextIds.programId,
    team_id: contextIds.teamId,
    season_id: contextIds.seasonId,
    source_provider: 'gamechanger',
    trigger_kind: 'manual',
    status: 'running',
  });
}

function capturedGame(sourceGameId, meta = {}) {
  const baseMeta = {
    gameDate: '2026-04-01',
    homeTeam: 'Relational Synthetic High',
    awayTeam: 'Relational Synthetic Rival',
    ourSide: 'home',
    capturedAt: '2026-04-01T20:00:00.000Z',
    ...meta,
  };
  if (sourceGameId !== null) baseMeta.sourceGameId = sourceGameId;
  return {
    meta: baseMeta,
    boxScore: {
      batting: [
        { Player: 'Synthetic Player', TeamSide: 'home', own: true, playerId: 'local-provider-player' },
        { Player: 'Synthetic Opponent', TeamSide: 'away', own: false, playerId: 'local-opponent-player' },
      ],
      pitching: [],
    },
    plays: [
      { inning: 'Bottom 1', batterId: 'local-provider-player', text: 'Single. Synthetic Player singles to left field, Synthetic Pitcher pitching.' },
    ],
  };
}

function dto(run, games, contextIds = ids) {
  return mapper({
    context: {
      orgId: contextIds.orgId,
      programId: contextIds.programId,
      teamId: contextIds.teamId,
      seasonId: contextIds.seasonId,
      importRunId: run.id,
      sourceProvider: 'gamechanger',
    },
    capturedGames: games,
    rosterMemberships: [{ playerId: contextIds.playerId, gcExternalPlayerId: 'local-provider-player' }],
  }).dto;
}

test.before(async () => {
  if (!canRun) return;
  assert.ok(loopbackOnly, 'relational tests must target loopback');
  const suffix = crypto.randomUUID().slice(0, 8);
  const org = await fixtureInsert('organizations', {
    name: `HS engine local ${suffix}`,
    slug: `hs-engine-local-${suffix}`,
    customer_type: 'high_school',
    primary_product: 'high_school',
    enabled_products: ['high_school'],
  });
  const program = await fixtureInsert('hs_programs', { org_id: org.id, name: `Program ${suffix}` });
  const season = await fixtureInsert('hs_seasons', {
    org_id: org.id,
    program_id: program.id,
    name: `Season ${suffix}`,
    school_year: '2025-2026',
  });
  const team = await fixtureInsert('hs_teams', {
    org_id: org.id,
    program_id: program.id,
    level: 'varsity',
    name: `Team ${suffix}`,
  });
  const player = await fixtureInsert('hs_players', {
    org_id: org.id,
    program_id: program.id,
    first_name: 'Synthetic',
    last_name: `Player ${suffix}`,
  });
  await fixtureInsert('hs_roster_memberships', {
    org_id: org.id,
    team_id: team.id,
    season_id: season.id,
    player_id: player.id,
    status: 'active',
    gc_external_player_id: 'local-provider-player',
  });
  const otherOrg = await fixtureInsert('organizations', {
    name: `Other local ${suffix}`,
    slug: `other-local-${suffix}`,
    customer_type: 'high_school',
    primary_product: 'high_school',
    enabled_products: ['high_school'],
  });
  const otherProgram = await fixtureInsert('hs_programs', { org_id: otherOrg.id, name: `Other program ${suffix}` });
  const otherSeason = await fixtureInsert('hs_seasons', {
    org_id: otherOrg.id, program_id: otherProgram.id, name: `Other season ${suffix}`, school_year: '2025-2026',
  });
  const otherTeam = await fixtureInsert('hs_teams', {
    org_id: otherOrg.id, program_id: otherProgram.id, level: 'varsity', name: `Other team ${suffix}`,
  });
  const otherPlayer = await fixtureInsert('hs_players', {
    org_id: otherOrg.id, program_id: otherProgram.id, first_name: 'Other', last_name: `Player ${suffix}`,
  });
  await fixtureInsert('hs_roster_memberships', {
    org_id: otherOrg.id, team_id: otherTeam.id, season_id: otherSeason.id,
    player_id: otherPlayer.id, status: 'active', gc_external_player_id: 'other-provider-player',
  });
  const authorizedUserId = await createFixtureIdentity(org.id);
  const crossTenantUserId = await createFixtureIdentity(otherOrg.id);
  const unaffiliatedUserId = await createFixtureIdentity();
  const authenticatedClient = (userId) => createSupabaseClient(localUrl, process.env.HS_LOCAL_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${authenticatedToken(userId)}` } },
  });
  authorizedUser = authenticatedClient(authorizedUserId);
  crossTenantUser = authenticatedClient(crossTenantUserId);
  unaffiliatedUser = authenticatedClient(unaffiliatedUserId);
  ids = {
    orgId: org.id, programId: program.id, teamId: team.id, seasonId: season.id, playerId: player.id,
    otherOrgId: otherOrg.id, otherProgramId: otherProgram.id, otherSeasonId: otherSeason.id,
    otherTeamId: otherTeam.id, otherPlayerId: otherPlayer.id,
    fixtureUserIds: [authorizedUserId, crossTenantUserId, unaffiliatedUserId],
  };
});

test.after(async () => {
  if (!canRun || !ids?.orgId) return;
  await fixtureDb.query('delete from public.organizations where id = $1', [ids.orgId]);
  await fixtureDb.query('delete from public.organizations where id = $1', [ids.otherOrgId]);
  await fixtureDb.query('delete from public.profiles where id = any($1::uuid[])', [ids.fixtureUserIds]);
  await fixtureDb.query('delete from auth.users where id = any($1::uuid[])', [ids.fixtureUserIds]);
  await fixtureDb.end();
});

relationalTest('durable publication is atomic, complete, canonical, and idempotent', { skip }, async () => {
  const run = await createRun();
  const collection = dto(run, [capturedGame('durable-local-1')]);
  const first = await repository.persistEngineCollection(collection);
  const retry = await repository.persistEngineCollection(collection);
  assert.equal(retry.id, first.id);

  const [generations, observations, snapshots, totals, players, noncanonical, runAfter] = await Promise.all([
    admin.from('hs_stat_generations').select('*').eq('id', first.id),
    admin.from('hs_import_run_games').select('*').eq('import_run_id', run.id),
    admin.from('hs_raw_snapshots').select('*').eq('import_run_id', run.id),
    admin.from('hs_verified_totals').select('*').eq('generation_id', first.id),
    admin.from('hs_player_advanced_stats').select('*').eq('generation_id', first.id),
    admin.from('hs_noncanonical_player_stats').select('*').eq('generation_id', first.id),
    admin.from('hs_import_runs').select('*').eq('id', run.id).single(),
  ]);
  for (const result of [generations, observations, snapshots, totals, players, noncanonical, runAfter]) assert.equal(result.error, null, result.error?.message);
  assert.equal(generations.data.length, 1);
  assert.equal(observations.data.length, 1);
  assert.equal(snapshots.data.length, 2);
  assert.equal(totals.data.length, 1);
  assert.equal(players.data[0].player_id, ids.playerId);
  assert.ok(noncanonical.data.some((row) => row.is_opponent));
  assert.equal(runAfter.data.status, 'succeeded');
});

relationalTest('concurrent identical publication converges on one generation', { skip }, async () => {
  const run = await createRun();
  const collection = dto(run, [capturedGame('concurrent-local')]);
  const settled = await Promise.allSettled([
    repository.persistEngineCollection(collection),
    repository.persistEngineCollection(collection),
  ]);
  assert.ok(settled.every((item) => item.status === 'fulfilled'), JSON.stringify(settled));
  assert.equal(settled[0].value.id, settled[1].value.id);
  const rows = await admin.from('hs_stat_generations').select('id').eq('org_id', ids.orgId).eq('input_set_hash', collection.inputSetHash);
  assert.equal(rows.error, null, rows.error?.message);
  assert.equal(rows.data.length, 1);
});

relationalTest('fallback enrichment preserves aliases while genuine doubleheaders remain separate', { skip }, async () => {
  const firstRun = await createRun();
  await repository.persistEngineCollection(dto(firstRun, [capturedGame(null, { startTime: '10:00 AM' })]));
  const secondRun = await createRun();
  await repository.persistEngineCollection(dto(secondRun, [
    capturedGame(null, { startTime: '10:00 AM' }),
    capturedGame(null, { startTime: '10:00 AM', field: 'North' }),
  ]));
  const aliases = await admin.from('hs_game_identity_aliases').select('hs_game_id, discriminators').eq('org_id', ids.orgId).eq('identity_method', 'scheduleComposite');
  const resolutions = await admin.from('hs_game_identity_resolutions').select('*').eq('import_run_id', secondRun.id);
  assert.equal(aliases.error, null, aliases.error?.message);
  assert.equal(resolutions.error, null, resolutions.error?.message);
  assert.ok(aliases.data.length >= 2);
  assert.equal(new Set(aliases.data.map((row) => row.hs_game_id)).size, 1);
  const enrichedObservations = await admin.from('hs_import_run_games').select('hs_game_id').eq('import_run_id', secondRun.id);
  assert.equal(enrichedObservations.error, null, enrichedObservations.error?.message);
  assert.equal(enrichedObservations.data.length, 2, 'both reconciled observations must remain stored');
  assert.equal(new Set(enrichedObservations.data.map((row) => row.hs_game_id)).size, 1);
  assert.ok(resolutions.data.some((row) => row.resolution_kind === 'automatic_fallback_enrichment'));

  const dhRun = await createRun();
  await repository.persistEngineCollection(dto(dhRun, [
    capturedGame(null, { startTime: '13:00', gameNumber: 1 }),
    capturedGame(null, { startTime: '13:00', gameNumber: 2 }),
  ]));
  const dh = await admin.from('hs_import_run_games').select('hs_game_id').eq('import_run_id', dhRun.id);
  assert.equal(dh.error, null, dh.error?.message);
  assert.equal(new Set(dh.data.map((row) => row.hs_game_id)).size, 2);
});

relationalTest('unresolved observations persist without aliases and ambiguity remains excluded', { skip }, async () => {
  const unresolvedRun = await createRun();
  const unresolvedGame = capturedGame(null);
  await repository.persistEngineCollection(dto(unresolvedRun, [unresolvedGame, structuredClone(unresolvedGame)]));
  const unresolved = await admin.from('hs_import_run_games').select('*').eq('import_run_id', unresolvedRun.id);
  assert.equal(unresolved.error, null, unresolved.error?.message);
  assert.equal(unresolved.data.length, 2);
  assert.ok(unresolved.data.every((row) => row.hs_game_id === null && row.identity_method === 'unresolvedScoped' && row.authoritative));

  const ambiguousRun = await createRun();
  await repository.persistEngineCollection(dto(ambiguousRun, [
    capturedGame(null, { startTime: '15:00' }),
    capturedGame(null, { startTime: '15:00', gameNumber: 1 }),
    capturedGame(null, { startTime: '15:00', gameNumber: 2 }),
  ]));
  const ambiguous = await admin.from('hs_import_run_games').select('*').eq('import_run_id', ambiguousRun.id);
  assert.equal(ambiguous.error, null, ambiguous.error?.message);
  assert.ok(ambiguous.data.every((row) => row.hs_game_id === null && row.identity_status === 'ambiguous' && row.excluded_from_official_totals));
});

relationalTest('complete generations supersede absent players and content mismatches fail', { skip }, async () => {
  const firstRun = await createRun();
  const firstDto = dto(firstRun, [capturedGame('supersession-1')]);
  const first = await repository.persistEngineCollection(firstDto);
  const secondRun = await createRun();
  const noPlayerGame = capturedGame('supersession-2');
  noPlayerGame.boxScore.batting = [];
  noPlayerGame.plays = [];
  const second = await repository.persistEngineCollection(dto(secondRun, [noPlayerGame]));
  const oldPlayers = await admin.from('hs_player_advanced_stats').select('is_current').eq('generation_id', first.id);
  const currentGenerations = await admin.from('hs_stat_generations').select('id').eq('org_id', ids.orgId).eq('team_id', ids.teamId).eq('season_id', ids.seasonId).eq('is_current', true);
  assert.equal(oldPlayers.error, null, oldPlayers.error?.message);
  assert.ok(oldPlayers.data.every((row) => row.is_current === false));
  assert.deepEqual(currentGenerations.data.map((row) => row.id), [second.id]);

  const mismatchRun = await createRun();
  const mismatch = dto(mismatchRun, [capturedGame('mismatch-key')]);
  // First establish this idempotency key, then reuse it from another run
  // with a deliberately different content hash.
  await repository.persistEngineCollection(mismatch);
  const retryRun = await createRun();
  const conflicting = { ...mismatch, context: { ...mismatch.context, importRunId: retryRun.id }, contentHash: 'f'.repeat(64) };
  await assert.rejects(() => repository.persistEngineCollection(conflicting), (error) => error.code === 'IDEMPOTENCY_CONTENT_MISMATCH');
});

relationalTest('cross-tenant references and mid-publication player failures roll back; anonymous reads are denied', { skip }, async () => {
  try {
    const run = await createRun();
    const crossTenant = dto(run, [capturedGame('cross-tenant')]);
    crossTenant.context.orgId = ids.otherOrgId;
    await assert.rejects(() => repository.persistEngineCollection(crossTenant), (error) => error.code === 'TEAM_NOT_FOUND_FOR_ORG');

    const rollbackRun = await createRun();
    const rollbackDto = dto(rollbackRun, [capturedGame('rollback-local')]);
    rollbackDto.canonicalPlayers[0].playerId = crypto.randomUUID();
    await assert.rejects(() => repository.persistEngineCollection(rollbackDto), (error) => error.code === 'PLAYER_NOT_ON_ROSTER');
    const [observations, generations] = await Promise.all([
      admin.from('hs_import_run_games').select('id').eq('import_run_id', rollbackRun.id),
      admin.from('hs_stat_generations').select('id').eq('import_run_id', rollbackRun.id),
    ]);
    assert.equal(observations.data.length, 0);
    assert.equal(generations.data.length, 0);

    for (const table of ['hs_game_identity_aliases', 'hs_game_identity_resolutions', 'hs_stat_generations', 'hs_noncanonical_player_stats']) {
      const result = await anon.from(table).select('id').limit(1);
      assert.ok(result.error || result.data.length === 0, `${table} must not expose rows anonymously`);
    }
    const rpc = await anon.rpc('persist_hs_engine_collection', { p_dto: rollbackDto });
    assert.ok(rpc.error, 'anonymous role must not execute the RPC');

    const authenticatedRpc = await authorizedUser.rpc('persist_hs_engine_collection', { p_dto: rollbackDto });
    assert.ok(authenticatedRpc.error, 'authenticated role must not execute the RPC');

    const visibilityRun = await createRun();
    await repository.persistEngineCollection(dto(visibilityRun, [capturedGame('visibility-local')]));
    const authorizedRead = await authorizedUser.from('hs_stat_generations').select('id, org_id').eq('org_id', ids.orgId);
    const crossTenantRead = await crossTenantUser.from('hs_stat_generations').select('id, org_id').eq('org_id', ids.orgId);
    const unaffiliatedRead = await unaffiliatedUser.from('hs_stat_generations').select('id, org_id').eq('org_id', ids.orgId);
    assert.equal(authorizedRead.error, null, authorizedRead.error?.message);
    assert.ok(authorizedRead.data.length > 0 && authorizedRead.data.every((row) => row.org_id === ids.orgId));
    assert.deepEqual(crossTenantRead.data, []);
    assert.deepEqual(unaffiliatedRead.data, []);

    await fixtureDb.query('update public.organizations set enabled_products = $2, primary_product = $3, customer_type = $3 where id = $1', [ids.orgId, ['travel'], 'travel']);
    const incorrectlyEntitledRead = await authorizedUser.from('hs_stat_generations').select('id').eq('org_id', ids.orgId);
    assert.deepEqual(incorrectlyEntitledRead.data, []);
    await fixtureDb.query('update public.organizations set enabled_products = $2, primary_product = $3, customer_type = $3 where id = $1', [ids.orgId, ['high_school'], 'high_school']);

    for (const client of [anon, authorizedUser]) {
      const directWrite = await client.from('hs_stat_generations').insert({ org_id: ids.orgId });
      assert.ok(directWrite.error, 'anonymous/authenticated direct writes must be denied');
    }

    const serviceOrgInsert = await admin.from('organizations').insert({ name: 'forbidden', slug: `forbidden-${crypto.randomUUID()}` });
    const serviceOrgUpdate = await admin.from('organizations').update({ name: 'forbidden' }).eq('id', ids.orgId);
    assert.ok(serviceOrgInsert.error, 'service_role cannot provision organizations through this boundary');
    assert.ok(serviceOrgUpdate.error, 'service_role cannot arbitrarily update organizations through this boundary');

    const privilegeProbeRun = await createRun();
    const privilegeProbeDto = dto(privilegeProbeRun, [capturedGame('privilege-probe')]);
    const client = await fixtureDb.connect();
    try {
      await client.query('begin');
      await client.query('revoke select on public.hs_roster_memberships from service_role');
      await client.query('set local role service_role');
      await assert.rejects(
        client.query('select public.persist_hs_engine_collection($1::jsonb)', [privilegeProbeDto]),
        (error) => error.code === '42501' && !/postgres(?:ql)?:\/\/|service[_-]?role[_-]?key|eyJ/i.test(error.message),
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
  } finally {
    await fixtureDb.query('update public.organizations set enabled_products = $2, primary_product = $3, customer_type = $3 where id = $1', [ids.orgId, ['high_school'], 'high_school']);
  }
});

const SLICE_2C_TABLES = [
  'hs_game_identity_aliases',
  'hs_game_identity_resolutions',
  'hs_stat_generations',
  'hs_noncanonical_player_stats',
];
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const forwardMigrationSql = () => fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260817151031_close_hs_engine_service_role_update_privileges.sql'),
  'utf8',
);

// Effective privileges. has_table_privilege resolves direct grants, grants held
// through role membership, and grants made to PUBLIC, so this is the real
// authorization answer rather than information_schema's direct-grant view
// (which additionally omits PostgreSQL 17's MAINTAIN entirely).
async function effectivePrivileges(queryable, role, table) {
  const { rows } = await queryable.query(
    `select p as privilege from unnest($1::text[]) as p
      where has_table_privilege($2::regrole, $3::regclass, p) order by 1`,
    [TABLE_PRIVILEGES, role, `public.${table}`],
  );
  return rows.map((row) => row.privilege).sort();
}

// Catalog ACL expansion, including grants made to PUBLIC (grantee OID 0).
async function catalogPrivileges(queryable, grantee, table) {
  const { rows } = await queryable.query(
    `select a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(c.relacl) a
      where n.nspname = 'public' and c.relname = $2
        and (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) = $1
      order by 1`,
    [grantee, table],
  );
  return rows.map((row) => row.privilege_type).sort();
}

relationalTest('forward migration converts hosted default privileges into the least-privilege contract', { skip }, async () => {
  const migrationSql = forwardMigrationSql();
  const defaultAclBefore = await fixtureDb.query(
    'select defaclrole, defaclnamespace, defaclobjtype, defaclacl::text as acl from pg_default_acl order by 1, 2, 3');
  const aclBefore = {};
  for (const table of SLICE_2C_TABLES) {
    aclBefore[table] = await catalogPrivileges(fixtureDb, 'service_role', table);
  }

  const client = await fixtureDb.connect();
  try {
    await client.query('begin');

    // Hosted Supabase grants service_role ALL (arwdDxtm) on newly created public
    // tables; the local stack's default privileges grant only Dxtm. Recreate the
    // hosted residue so this assertion tests the migration, not the environment.
    for (const table of SLICE_2C_TABLES) {
      await client.query(`grant update, maintain on table public.${table} to service_role`);
    }

    for (const table of SLICE_2C_TABLES) {
      assert.deepEqual(await effectivePrivileges(client, 'service_role', table),
        ['INSERT', 'MAINTAIN', 'SELECT', 'UPDATE'], `${table}: simulated hosted precondition`);
    }

    // Execute the migration exactly as production will, read from the file itself.
    await client.query(migrationSql);

    const expected = {
      hs_game_identity_aliases: ['INSERT', 'SELECT'],
      hs_game_identity_resolutions: ['INSERT', 'SELECT'],
      hs_stat_generations: ['INSERT', 'SELECT', 'UPDATE'],
      hs_noncanonical_player_stats: ['INSERT', 'SELECT'],
    };
    for (const table of SLICE_2C_TABLES) {
      const effective = await effectivePrivileges(client, 'service_role', table);
      assert.deepEqual(effective, expected[table], `${table}: corrected effective service_role contract`);
      assert.deepEqual(await catalogPrivileges(client, 'service_role', table), expected[table],
        `${table}: corrected service_role catalog ACL`);
      for (const privilege of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
        assert.equal(effective.includes(privilege), false, `${table}: service_role must not hold ${privilege}`);
      }
      assert.deepEqual(await catalogPrivileges(client, 'PUBLIC', table), [], `${table}: PUBLIC must hold nothing`);
      assert.deepEqual(await effectivePrivileges(client, 'anon', table), [], `${table}: anon must hold nothing`);
      assert.deepEqual(await effectivePrivileges(client, 'authenticated', table), ['SELECT'],
        `${table}: authenticated must remain read-only`);
    }

    await client.query('rollback');
  } finally {
    client.release();
  }

  // The simulation must leave nothing behind: every table ACL returns to exactly
  // the state captured before the transaction, and no default privilege changed.
  for (const table of SLICE_2C_TABLES) {
    assert.deepEqual(await catalogPrivileges(fixtureDb, 'service_role', table), aclBefore[table],
      `${table}: simulation must be rolled back, not persisted`);
  }
  const defaultAclAfter = await fixtureDb.query(
    'select defaclrole, defaclnamespace, defaclobjtype, defaclacl::text as acl from pg_default_acl order by 1, 2, 3');
  assert.deepEqual(defaultAclAfter.rows, defaultAclBefore.rows, 'default privileges must be untouched');
});

relationalTest('privilege closure is behaviourally enforced against real matching rows', { skip }, async () => {
  // Two publications over a schedule-composite identity: the first creates the
  // game, alias, generation and noncanonical rows; the second reconciles against
  // that identity, which is what appends resolution history. Both are needed so
  // every affected table holds a real matching row for the probes below.
  // A date/time unique to this test, so the schedule-composite identity cannot
  // collide with fixtures published by any other case in this file.
  const slot = { startTime: '18:30', gameDate: '2026-05-22' };
  const firstRun = await createRun();
  const published = await repository.persistEngineCollection(
    dto(firstRun, [capturedGame(null, slot)]));
  assert.ok(published.id, 'SECURITY INVOKER publication must succeed under the corrected privilege closure');
  const secondRun = await createRun();
  const republished = await repository.persistEngineCollection(dto(secondRun, [
    capturedGame(null, slot),
    capturedGame(null, { ...slot, field: 'South' }),
  ]));
  assert.ok(republished.id, 'identity reconciliation must still publish under the corrected privilege closure');
  assert.notEqual(republished.id, published.id, 'the superseding generation must be distinct');

  const denied = {
    hs_game_identity_aliases: 'identity_method',
    hs_game_identity_resolutions: 'resolution_kind',
    hs_noncanonical_player_stats: 'unresolved_reason',
  };
  for (const [table, column] of Object.entries(denied)) {
    const { rows: [{ count }] } = await fixtureDb.query(
      `select count(*)::int as count from public.${table} where org_id = $1`, [ids.orgId]);
    assert.ok(count > 0, `${table}: probe requires at least one matching row`);

    const client = await fixtureDb.connect();
    try {
      await client.query('begin');
      await client.query('set local role service_role');
      // A matching row exists and service_role bypasses RLS, so a retained
      // privilege would produce a successful non-zero-row update. Rejection with
      // 42501 therefore distinguishes ACL denial from an RLS-filtered no-op.
      await assert.rejects(
        client.query(`update public.${table} set ${column} = ${column} where org_id = $1`, [ids.orgId]),
        (error) => error.code === '42501'
          && /permission denied/i.test(error.message)
          && !/postgres(?:ql)?:\/\/|service[_-]?role[_-]?key|eyJ/i.test(error.message),
        `${table}: service_role UPDATE must fail with SQLSTATE 42501`,
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
  }

  const client = await fixtureDb.connect();
  try {
    await client.query('begin');
    await client.query('set local role service_role');
    const superseded = await client.query(
      'update public.hs_stat_generations set is_current = is_current where org_id = $1', [ids.orgId]);
    assert.ok(superseded.rowCount > 0, 'service_role must retain UPDATE on hs_stat_generations for supersession');
    for (const table of SLICE_2C_TABLES) {
      const privileges = await effectivePrivileges(client, 'service_role', table);
      assert.ok(privileges.includes('SELECT'), `${table}: SELECT must remain effective`);
      assert.ok(privileges.includes('INSERT'), `${table}: INSERT must remain effective`);
      assert.equal(privileges.includes('MAINTAIN'), false, `${table}: MAINTAIN must be ineffective`);
      assert.deepEqual(await catalogPrivileges(client, 'service_role', table), privileges,
        `${table}: catalog ACL must agree with effective privileges`);
    }
    await client.query('rollback');
  } finally {
    client.release();
  }

  for (const role of ['anon', 'authenticated']) {
    for (const table of SLICE_2C_TABLES) {
      const probe = await fixtureDb.connect();
      try {
        await probe.query('begin');
        await probe.query(`set local role ${role}`);
        await assert.rejects(
          probe.query(`update public.${table} set org_id = org_id where org_id = $1`, [ids.orgId]),
          (error) => error.code === '42501',
          `${role} must not update ${table}`,
        );
        await probe.query('rollback');
      } finally {
        probe.release();
      }
    }
  }

  for (const table of SLICE_2C_TABLES) {
    const admin = await effectivePrivileges(fixtureDb, 'postgres', table);
    assert.deepEqual(admin, TABLE_PRIVILEGES.slice().sort(), `${table}: postgres must retain administrative privileges`);
    // has_table_privilege above is membership- and PUBLIC-aware, so the denials
    // already account for indirect grants; assert no PUBLIC grant exists at all.
    assert.deepEqual(await catalogPrivileges(fixtureDb, 'PUBLIC', table), [],
      `${table}: no PUBLIC grant may restore a denied privilege`);
  }
});

function independentRepository() {
  const client = createSupabaseClient(localUrl, process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return require('../src/high-school-import-repository').createHighSchoolImportRepository(client);
}

const OVERLAP_TIMEOUT_MS = 5_000;
const OVERLAP_REPEAT_COUNT = 3;

async function waitForDatabaseOverlap(blockerPid, baselinePids) {
  const deadline = Date.now() + OVERLAP_TIMEOUT_MS;
  let lastSeen = [];
  while (Date.now() < deadline) {
    const result = await fixtureDb.query(
      `select a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) blocking_pids,
              array(select distinct l.locktype from pg_locks l where l.pid=a.pid order by l.locktype) lock_types
         from pg_stat_activity a
        where a.pid <> pg_backend_pid()
          and state = 'active'
          and query ilike '%persist_hs_engine_collection%'
          and not (a.pid = any($2::int[]))
          and a.wait_event_type = 'Lock'
          and $1::int = any(pg_blocking_pids(a.pid))
        order by a.pid`,
      [blockerPid, baselinePids],
    );
    if (result.rowCount === 2) return result.rows;
    const observed = await fixtureDb.query(
      `select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) blocking_pids
         from pg_stat_activity
        where pid <> pg_backend_pid() and query ilike '%persist_hs_engine_collection%'
        order by pid`,
    );
    lastSeen = observed.rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`database overlap witness timed out ${JSON.stringify({ blockerPid, baselinePids, observed: lastSeen })}`);
}

test('concurrency harness requires a PostgreSQL lock-wait witness rather than dispatch timing', () => {
  assert.equal(OVERLAP_REPEAT_COUNT, 3);
  assert.match(waitForDatabaseOverlap.toString(), /pg_stat_activity/);
  assert.match(waitForDatabaseOverlap.toString(), /wait_event_type = 'Lock'/);
  assert.match(databaseWitnessedOverlap.toString(), /for update/);
});

async function databaseWitnessedOverlap(operations) {
  const blocker = await fixtureDb.connect();
  let released = false;
  try {
    await blocker.query('begin');
    await blocker.query('select id from public.hs_teams where id=$1 for update', [ids.teamId]);
    // PostgreSQL queues same-tuple waiters behind one another. Retain the exact
    // row lock and additionally gate relation access in this same transaction so
    // both current RPC backends directly identify this blocker PID.
    await blocker.query('lock table public.hs_teams in access exclusive mode');
    const blockerIdentity = await blocker.query("select pg_backend_pid() pid, 'public.hs_teams'::regclass::oid team_relation_oid");
    const blockerPid = blockerIdentity.rows[0].pid;
    const baseline = await fixtureDb.query(
      "select pid from pg_stat_activity where state='active' and query ilike '%persist_hs_engine_collection%'",
    );
    const baselinePids = baseline.rows.map((row) => row.pid);
    const started = operations.map((operation) => operation().then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    ));
    const waiters = await waitForDatabaseOverlap(blockerPid, baselinePids);
    await blocker.query('commit');
    released = true;
    const timeout = new Promise((_, reject) => setTimeout(
      () => reject(new Error('overlapped RPC operations did not complete within the bounded timeout')),
      OVERLAP_TIMEOUT_MS,
    ));
    return {
      witness: { blockerPid, teamRelationOid: blockerIdentity.rows[0].team_relation_oid, baselinePids, waiters },
      settled: await Promise.race([Promise.all(started), timeout]),
    };
  } finally {
    if (!released) await blocker.query('rollback').catch(() => {});
    blocker.release();
  }
}

function pgClient() {
  return new PgClient({
    host: process.env.HS_LOCAL_PG_HOST, port: Number(process.env.HS_LOCAL_PG_PORT),
    database: process.env.HS_LOCAL_PG_DATABASE, user: process.env.HS_LOCAL_PG_USER,
    password: process.env.HS_LOCAL_PG_PASSWORD,
  });
}

async function startDecoyWaiter() {
  const blocker = pgClient();
  const waiter = pgClient();
  await blocker.connect();
  await waiter.connect();
  await blocker.query('begin');
  await blocker.query('select id from public.hs_seasons where id=$1 for update', [ids.otherSeasonId]);
  const waiterPid = (await waiter.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending = waiter.query("select id from public.hs_seasons where id=$1 for update /* persist_hs_engine_collection decoy */", [ids.otherSeasonId]);
  const deadline = Date.now() + OVERLAP_TIMEOUT_MS;
  let witnessed = false;
  while (Date.now() < deadline) {
    const active = await fixtureDb.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [waiterPid]);
    if (active.rowCount === 1) { witnessed = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!witnessed) {
    await blocker.query('rollback').catch(() => {});
    await pending.catch(() => {});
    await Promise.all([blocker.end(), waiter.end()]);
    throw new Error(`decoy waiter ${waiterPid} did not reach a lock wait`);
  }
  return {
    waiterPid,
    async close() {
      await blocker.query('rollback').catch(() => {});
      await pending.catch(() => {});
      await Promise.all([blocker.end(), waiter.end()]);
    },
  };
}

function assertAttributableWitness(witness, label, repeat) {
  assert.equal(witness.waiters.length, 2);
  const waiterPids = witness.waiters.map((row) => row.pid);
  assert.equal(new Set(waiterPids).size, 2);
  for (const waiter of witness.waiters) {
    assert.notEqual(waiter.pid, witness.blockerPid);
    assert.ok(!witness.baselinePids.includes(waiter.pid));
    assert.ok(waiter.blocking_pids.includes(witness.blockerPid));
    assert.equal(waiter.wait_event_type, 'Lock');
    assert.ok(waiter.lock_types.length > 0);
  }
  console.log(`# overlap-witness ${JSON.stringify({ label, repeat, blockerPid: witness.blockerPid, teamRelationOid: witness.teamRelationOid, baselinePids: witness.baselinePids, waiters: witness.waiters })}`);
  return waiterPids;
}

function refinalizeDto(dto) {
  const { canonicalSerialize } = require('../src/high-school-engine-persistence-mapper');
  const base = { ...dto };
  delete base.contentHash;
  delete base.payloadBytes;
  const contentHash = crypto.createHash('sha256').update(canonicalSerialize(base), 'utf8').digest('hex');
  let payloadBytes = 0;
  let result;
  while (true) {
    result = { ...base, contentHash, payloadBytes };
    const measured = Buffer.byteLength(canonicalSerialize(result), 'utf8');
    if (measured === payloadBytes) return result;
    payloadBytes = measured;
  }
}

async function assertNoPublicationForRun(runId) {
  for (const table of ['hs_import_run_games', 'hs_raw_snapshots', 'hs_game_validation_results', 'hs_stat_generations', 'hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
    const column = table === 'hs_stat_generations' || table === 'hs_verified_totals' ? 'import_run_id' : 'import_run_id';
    const result = await fixtureDb.query(`select count(*)::int count from public.${table} where ${column} = $1`, [runId]);
    assert.equal(result.rows[0].count, 0, `${table} must roll back for failed run`);
  }
}

relationalTest('concurrent same-key different-content publication commits one consistent identity', { skip }, async () => {
  for (let repeat = 0; repeat < OVERLAP_REPEAT_COUNT; repeat += 1) {
    const runA = await createRun();
    const runB = await createRun();
    const freshInputHash = crypto.createHash('sha256').update(`same-key-overlap-${repeat}-${runA.id}`).digest('hex');
    const first = refinalizeDto({ ...dto(runA, [capturedGame(`same-key-a-${repeat}`)]), inputSetHash: freshInputHash });
    const secondBase = dto(runB, [capturedGame(`same-key-b-${repeat}`)]);
    const second = refinalizeDto({ ...secondBase, inputSetHash: freshInputHash });
    const decoy = repeat === 0 ? await startDecoyWaiter() : null;
    let overlap;
    try {
      overlap = await databaseWitnessedOverlap([
        () => independentRepository().persistEngineCollection(first),
        () => independentRepository().persistEngineCollection(second),
      ]);
      const waiterPids = assertAttributableWitness(overlap.witness, 'same-key', repeat);
      if (decoy) {
        assert.ok(overlap.witness.baselinePids.includes(decoy.waiterPid));
        assert.ok(!waiterPids.includes(decoy.waiterPid));
      }
    } finally {
      if (decoy) await decoy.close();
    }
    const { settled } = overlap;
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((item) => item.status === 'rejected' && item.reason.code === 'IDEMPOTENCY_CONTENT_MISMATCH').length, 1);
    const generations = await fixtureDb.query(
      'select id, content_hash, is_current from public.hs_stat_generations where org_id=$1 and team_id=$2 and season_id=$3 and input_set_hash=$4',
      [ids.orgId, ids.teamId, ids.seasonId, first.inputSetHash],
    );
    assert.equal(generations.rowCount, 1);
    assert.equal(generations.rows[0].is_current, true);
    const winning = settled[0].status === 'fulfilled' ? first : second;
    const losing = settled[0].status === 'rejected' ? first : second;
    const losingRun = settled[0].status === 'rejected' ? runA : runB;
    await assertNoPublicationForRun(losingRun.id);
    assert.equal((await independentRepository().persistEngineCollection(winning)).id, generations.rows[0].id);
    await assert.rejects(() => independentRepository().persistEngineCollection(losing), (error) => error.code === 'IDEMPOTENCY_CONTENT_MISMATCH');
  }
});

relationalTest('concurrent successor generations serialize with one internally consistent current generation', { skip }, async () => {
  for (let repeat = 0; repeat < OVERLAP_REPEAT_COUNT; repeat += 1) {
    const initialRun = await createRun();
    await repository.persistEngineCollection(dto(initialRun, [capturedGame(`supersession-base-${repeat}`)]));
    const runA = await createRun();
    const runB = await createRun();
    const successorASeed = dto(runA, [capturedGame(`supersession-a-${repeat}`)]);
    const successorA = refinalizeDto({ ...successorASeed, inputSetHash: crypto.createHash('sha256').update(`supersession-a-${repeat}-${runA.id}`).digest('hex') });
    const successorBGame = capturedGame(`supersession-b-${repeat}`);
    successorBGame.boxScore.batting = [];
    successorBGame.plays = [];
    const successorBSeed = dto(runB, [successorBGame]);
    const successorB = refinalizeDto({ ...successorBSeed, inputSetHash: crypto.createHash('sha256').update(`supersession-b-${repeat}-${runB.id}`).digest('hex') });
    const { witness, settled } = await databaseWitnessedOverlap([
      () => independentRepository().persistEngineCollection(successorA),
      () => independentRepository().persistEngineCollection(successorB),
    ]);
    assertAttributableWitness(witness, 'supersession', repeat);
    assert.ok(settled.every((item) => item.status === 'fulfilled'), JSON.stringify(settled));
    const current = await fixtureDb.query(
      'select id, import_run_id, content_hash, observation_count, snapshot_count from public.hs_stat_generations where org_id=$1 and team_id=$2 and season_id=$3 and is_current',
      [ids.orgId, ids.teamId, ids.seasonId],
    );
    assert.equal(current.rowCount, 1);
    const survivor = current.rows[0];
    const winner = survivor.import_run_id === runA.id ? successorA : successorB;
    assert.ok([runA.id, runB.id].includes(survivor.import_run_id));
    assert.equal(survivor.content_hash, winner.contentHash);
    assert.equal(survivor.observation_count, winner.observations.length);
    assert.equal(survivor.snapshot_count, winner.snapshotCount);
    for (const table of ['hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
      const rows = await fixtureDb.query(
        `select generation_id, import_run_id from public.${table} where org_id=$1 and team_id=$2 and season_id=$3 and is_current`,
        [ids.orgId, ids.teamId, ids.seasonId],
      );
      for (const row of rows.rows) {
        assert.equal(row.generation_id, survivor.id, `${table} generation must match survivor`);
        assert.equal(row.import_run_id, survivor.import_run_id, `${table} run must match survivor`);
      }
      if (table === 'hs_verified_totals') assert.equal(rows.rowCount, 1);
      if (table === 'hs_player_advanced_stats') assert.equal(rows.rowCount, winner.canonicalPlayers.filter((row) => row.role === 'batter').length);
      if (table === 'hs_pitcher_advanced_stats') assert.equal(rows.rowCount, winner.canonicalPlayers.filter((row) => row.role === 'pitcher').length);
    }
    const noncanonical = await fixtureDb.query('select count(*)::int count from public.hs_noncanonical_player_stats where generation_id=$1', [survivor.id]);
    assert.equal(noncanonical.rows[0].count, winner.noncanonicalPlayers.length);
    for (const candidate of [{ run: runA, dto: successorA }, { run: runB, dto: successorB }]) {
      const observations = await fixtureDb.query('select count(*)::int count from public.hs_import_run_games where import_run_id=$1', [candidate.run.id]);
      const snapshots = await fixtureDb.query('select count(*)::int count from public.hs_raw_snapshots where import_run_id=$1', [candidate.run.id]);
      const validations = await fixtureDb.query('select count(*)::int count from public.hs_game_validation_results where import_run_id=$1', [candidate.run.id]);
      const resolutions = await fixtureDb.query(
        `select count(*)::int count, count(*) filter (where g.id is null)::int orphan_count
           from public.hs_game_identity_resolutions r
           left join public.hs_import_run_games g on g.id=r.import_run_game_id and g.import_run_id=r.import_run_id
          where r.import_run_id=$1`,
        [candidate.run.id],
      );
      assert.equal(observations.rows[0].count, candidate.dto.observations.length);
      assert.equal(snapshots.rows[0].count, candidate.dto.snapshotCount);
      assert.equal(validations.rows[0].count, candidate.dto.observations.length);
      assert.equal(resolutions.rows[0].orphan_count, 0);
    }
    const orphanedAliases = await fixtureDb.query(
      `select count(*)::int count from public.hs_game_identity_aliases a
        where a.org_id=$1 and a.team_id=$2 and a.season_id=$3
          and not exists (select 1 from public.hs_games g where g.id=a.hs_game_id and g.org_id=a.org_id)`,
      [ids.orgId, ids.teamId, ids.seasonId],
    );
    assert.equal(orphanedAliases.rows[0].count, 0);
    const orphaned = await fixtureDb.query(
      `select count(*)::int count from public.hs_stat_generations g
        where g.import_run_id=any($1::uuid[]) and not exists
          (select 1 from public.hs_import_runs r where r.id=g.import_run_id and r.org_id=g.org_id)`,
      [[runA.id, runB.id]],
    );
    assert.equal(orphaned.rows[0].count, 0);
    await independentRepository().persistEngineCollection(successorA);
    await independentRepository().persistEngineCollection(successorB);
  }
});

relationalTest('every externally supplied tenant foreign key rejects cross-organization substitution atomically', { skip }, async () => {
  const otherRun = await fixtureInsert('hs_import_runs', {
    org_id: ids.otherOrgId, program_id: ids.otherProgramId, team_id: ids.otherTeamId,
    season_id: ids.otherSeasonId, source_provider: 'gamechanger', trigger_kind: 'manual', status: 'running',
  });
  const substitutions = [
    ['orgId', ids.otherOrgId], ['programId', ids.otherProgramId], ['teamId', ids.otherTeamId],
    ['seasonId', ids.otherSeasonId], ['importRunId', otherRun.id],
  ];
  for (const [field, value] of substitutions) {
    const run = await createRun();
    const hostile = dto(run, [capturedGame(`cross-${field}`)]);
    hostile.context = { ...hostile.context, [field]: value };
    await assert.rejects(() => independentRepository().persistEngineCollection(hostile));
    await assertNoPublicationForRun(run.id);
  }
  const playerRun = await createRun();
  const hostilePlayer = dto(playerRun, [capturedGame('cross-player')]);
  hostilePlayer.canonicalPlayers[0].playerId = ids.otherPlayerId;
  await assert.rejects(() => independentRepository().persistEngineCollection(hostilePlayer), (error) => error.code === 'PLAYER_NOT_ON_ROSTER');
  await assertNoPublicationForRun(playerRun.id);
});

relationalTest('near-limit valid JSON commits through the real local service-role RPC without truncation', { skip }, async () => {
  const run = await createRun();
  const collection = dto(run, [capturedGame('near-limit')]);
  const target = 4_194_000;
  collection.observations[0].snapshots[0].payload.reviewPadding = 'x'.repeat(target - collection.payloadBytes - 200);
  let finalDto = refinalizeDto(collection);
  const adjustment = target - finalDto.payloadBytes;
  collection.observations[0].snapshots[0].payload.reviewPadding += 'x'.repeat(Math.max(0, adjustment));
  finalDto = refinalizeDto(collection);
  assert.ok(finalDto.payloadBytes <= 4_194_304 && finalDto.payloadBytes >= 4_193_900);
  const generation = await independentRepository().persistEngineCollection(finalDto);
  assert.equal(generation.payload_bytes, finalDto.payloadBytes);
  assert.equal(generation.content_hash, finalDto.contentHash);
  const snapshot = await fixtureDb.query('select payload from public.hs_raw_snapshots where import_run_id=$1 and snapshot_kind=$2', [run.id, 'box_score']);
  assert.equal(snapshot.rows[0].payload.reviewPadding.length, collection.observations[0].snapshots[0].payload.reviewPadding.length);
});

relationalTest('hostile nested and malformed JSON rejects boundedly and leaves the local stack healthy', { skip }, async () => {
  const baselineRun = await createRun();
  let baseline = await independentRepository().persistEngineCollection(dto(baselineRun, [capturedGame('malformed-baseline')]));
  const mutateObservation = (mutator) => (value) => {
    const observation = structuredClone(value.observations[0]);
    mutator(observation);
    return { ...value, observations: [observation] };
  };
  for (const [index, diagnostic] of [
    { status: 'not_run', code: null },
    { status: 'ok' },
    { status: 'error', code: 'AMBIGUOUS_RECONSTRUCTION_FAILED', message: 'Ambiguous game diagnostic reconstruction failed.' },
  ].entries()) {
    const run = await createRun();
    const valid = refinalizeDto(mutateObservation((o) => { o.diagnostic = diagnostic; })(dto(run, [capturedGame(`valid-diagnostic-${index}`)])));
    baseline = await independentRepository().persistEngineCollection(valid);
  }
  const invalidDiagnostics = [
    {}, { status: 'unknown' }, { status: null }, { status: 17 }, { status: true }, { status: [] }, { status: {} },
    { status: '' }, { status: '   ' }, { status: 'ok', unexpected: true },
    { status: 'ok', unexpected: { deeply: { nested: true } } }, { unexpected: true },
    { status: 'not_run', code: 17 }, { status: 'error', code: 17, message: 'Ambiguous game diagnostic reconstruction failed.' },
    { status: 'error', code: 'AMBIGUOUS_RECONSTRUCTION_FAILED', message: 17 },
    { status: 'not_run' }, { status: 'not_run', code: 'UNEXPECTED' }, { status: 'not_run', code: null, message: 'unexpected' },
    { status: 'ok', code: null }, { status: 'ok', message: 'unexpected' },
    { status: 'error', message: 'Ambiguous game diagnostic reconstruction failed.' },
    { status: 'error', code: 'AMBIGUOUS_RECONSTRUCTION_FAILED' },
    { status: 'error', code: null, message: 'Ambiguous game diagnostic reconstruction failed.' },
    { status: 'error', code: 'AMBIGUOUS_RECONSTRUCTION_FAILED', message: null },
    { status: 'error', code: 'AMBIGUOUS_RECONSTRUCTION_FAILED', message: '' },
    { status: 'error', code: 'AMBIGUOUS_RECONSTRUCTION_FAILED', message: '   ' },
    { status: 'error', code: 'WRONG', message: 'Ambiguous game diagnostic reconstruction failed.' },
    { status: 'error', code: 'AMBIGUOUS_RECONSTRUCTION_FAILED', message: 'wrong' },
  ];
  const cases = [
    (value) => ({ ...value, observations: {} }),
    (value) => ({ ...value, canonicalPlayers: 'wrong' }),
    (value) => ({ ...value, teamTotals: [] }),
    (value) => ({ ...value, observations: Array.from({ length: 128 }, () => ({ unexpected: true })) }),
    (value) => ({ ...value, unexpectedTopLevel: { nested: { nested: { nested: true } } } }),
    mutateObservation((o) => { delete o.identityMethod; }),
    mutateObservation((o) => { o.unexpected = true; }),
    mutateObservation((o) => { o.unexpected = { deeply: { nested: [{ hostile: true }] } }; }),
    ...[null, 17, true, '', '   ', ` ${'a'.repeat(64)}`, `${'a'.repeat(64)} `, 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), `\u0430${'a'.repeat(63)}`, `e\u0301${'a'.repeat(62)}`, `\u00e9${'a'.repeat(63)}`]
      .map((key) => mutateObservation((o) => { o.observationKey = key; })),
    ...['identityMethod', 'identityStatus', 'identityDigest', 'engineVersion', 'authoritative', 'excludedFromOfficialTotals', 'discriminators', 'conflictFields', 'diagnostic', 'validation', 'snapshots']
      .map((field) => mutateObservation((o) => { o[field] = 17; })),
    ...invalidDiagnostics.map((diagnostic) => mutateObservation((o) => { o.diagnostic = diagnostic; })),
    (value) => {
      const first = structuredClone(value.observations[0]);
      const second = { ...structuredClone(first) };
      return { ...value, observations: [second, first] };
    },
    (value) => {
      const first = structuredClone(value.observations[0]);
      const second = { ...structuredClone(first), unexpected: true };
      return { ...value, observations: [second, first] };
    },
  ];
  for (const [index, mutate] of cases.entries()) {
    const run = await createRun();
    const hostile = refinalizeDto(mutate(dto(run, [capturedGame(`malformed-${index}`)])));
    await assert.rejects(
      () => independentRepository().persistEngineCollection(hostile),
      (error) => !/node_modules|[A-Z]:\\|postgres(?:ql)?:\/\/|eyJ|reviewPadding/i.test(String(error.message)),
      `hostile malformed case ${index} must reject`,
    );
    await assertNoPublicationForRun(run.id);
    const current = await fixtureDb.query(
      'select id from public.hs_stat_generations where org_id=$1 and team_id=$2 and season_id=$3 and is_current',
      [ids.orgId, ids.teamId, ids.seasonId],
    );
    assert.deepEqual(current.rows.map((row) => row.id), [baseline.id], `hostile malformed case ${index} changed current publication`);
  }
  const healthyRun = await createRun();
  const healthy = await independentRepository().persistEngineCollection(dto(healthyRun, [capturedGame('healthy-after-hostile')]));
  assert.ok(healthy.id);
});

relationalTest('retry after deliberate mid-transaction failure leaves no reservation and commits exactly once', { skip }, async () => {
  const run = await createRun();
  const intended = dto(run, [capturedGame('retry-after-failure')]);
  const failing = structuredClone(intended);
  delete failing.observations[0].diagnostic.status;
  const correctlyRehashedFailing = refinalizeDto(failing);
  await assert.rejects(() => independentRepository().persistEngineCollection(correctlyRehashedFailing));
  await assertNoPublicationForRun(run.id);
  const generation = await independentRepository().persistEngineCollection(intended);
  const retry = await independentRepository().persistEngineCollection(intended);
  assert.equal(retry.id, generation.id);
  for (const table of ['hs_import_run_games', 'hs_raw_snapshots', 'hs_game_validation_results', 'hs_stat_generations', 'hs_verified_totals']) {
    const result = await fixtureDb.query(`select count(*)::int count from public.${table} where import_run_id=$1`, [run.id]);
    const expected = table === 'hs_raw_snapshots' ? intended.snapshotCount : 1;
    assert.equal(result.rows[0].count, expected, `${table} must contain exactly the committed publication rows`);
  }
  await assert.rejects(() => independentRepository().persistEngineCollection(correctlyRehashedFailing));
  const unchanged = await fixtureDb.query('select id, content_hash, is_current from public.hs_stat_generations where import_run_id=$1', [run.id]);
  assert.deepEqual(unchanged.rows, [{ id: generation.id, content_hash: intended.contentHash, is_current: true }]);
  const current = await fixtureDb.query(
    'select count(*)::int count from public.hs_stat_generations where org_id=$1 and team_id=$2 and season_id=$3 and is_current',
    [ids.orgId, ids.teamId, ids.seasonId],
  );
  assert.equal(current.rows[0].count, 1);
});
