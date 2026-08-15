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

function relationalTest(name, options, fn) {
  if (!process.env.HS_RELATIONAL_TEST_NAME || process.env.HS_RELATIONAL_TEST_NAME === name) {
    test(name, options, fn);
  }
}

if (canRun) {
  const { createClient } = require('@supabase/supabase-js');
  createSupabaseClient = createClient;
  const { Pool } = require('pg');
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

function independentRepository() {
  const client = createSupabaseClient(localUrl, process.env.HS_LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return require('../src/high-school-import-repository').createHighSchoolImportRepository(client);
}

const OVERLAP_TIMEOUT_MS = 5_000;
const OVERLAP_REPEAT_COUNT = 3;

async function waitForDatabaseOverlap() {
  const deadline = Date.now() + OVERLAP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await fixtureDb.query(
      `select count(*)::int reached,
              count(*) filter (where wait_event_type = 'Lock')::int lock_waiters
         from pg_stat_activity
        where pid <> pg_backend_pid()
          and state = 'active'
          and query ilike '%persist_hs_engine_collection%'`,
    );
    if (result.rows[0].reached >= 2 && result.rows[0].lock_waiters >= 2) return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('database overlap witness timed out before two RPC sessions reached the held hierarchy lock');
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
    const started = operations.map((operation) => operation());
    const witness = await waitForDatabaseOverlap();
    await blocker.query('commit');
    released = true;
    const timeout = new Promise((_, reject) => setTimeout(
      () => reject(new Error('overlapped RPC operations did not complete within the bounded timeout')),
      OVERLAP_TIMEOUT_MS,
    ));
    return { witness, settled: await Promise.race([Promise.allSettled(started), timeout]) };
  } finally {
    if (!released) await blocker.query('rollback').catch(() => {});
    blocker.release();
  }
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
    const first = dto(runA, [capturedGame(`same-key-a-${repeat}`)]);
    const secondBase = dto(runB, [capturedGame(`same-key-b-${repeat}`)]);
    const second = refinalizeDto({ ...secondBase, inputSetHash: first.inputSetHash });
    const { witness, settled } = await databaseWitnessedOverlap([
      () => independentRepository().persistEngineCollection(first),
      () => independentRepository().persistEngineCollection(second),
    ]);
    assert.ok(witness.reached >= 2 && witness.lock_waiters >= 2);
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
    const successorA = dto(runA, [capturedGame(`supersession-a-${repeat}`)]);
    const successorBGame = capturedGame(`supersession-b-${repeat}`);
    successorBGame.boxScore.batting = [];
    successorBGame.plays = [];
    const successorB = dto(runB, [successorBGame]);
    const { witness, settled } = await databaseWitnessedOverlap([
      () => independentRepository().persistEngineCollection(successorA),
      () => independentRepository().persistEngineCollection(successorB),
    ]);
    assert.ok(witness.reached >= 2 && witness.lock_waiters >= 2);
    assert.ok(settled.every((item) => item.status === 'fulfilled'), JSON.stringify(settled));
    const current = await fixtureDb.query(
      'select id, import_run_id from public.hs_stat_generations where org_id=$1 and team_id=$2 and season_id=$3 and is_current',
      [ids.orgId, ids.teamId, ids.seasonId],
    );
    assert.equal(current.rowCount, 1);
    const stale = await fixtureDb.query(
      'select count(*)::int count from public.hs_player_advanced_stats where org_id=$1 and team_id=$2 and season_id=$3 and is_current and generation_id<>$4',
      [ids.orgId, ids.teamId, ids.seasonId, current.rows[0].id],
    );
    assert.equal(stale.rows[0].count, 0);
    assert.ok([runA.id, runB.id].includes(current.rows[0].import_run_id));
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
  const baseline = await independentRepository().persistEngineCollection(dto(baselineRun, [capturedGame('malformed-baseline')]));
  const mutateObservation = (mutator) => (value) => {
    const observation = structuredClone(value.observations[0]);
    mutator(observation);
    return { ...value, observations: [observation] };
  };
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
  failing.canonicalPlayers[0].playerId = ids.otherPlayerId;
  await assert.rejects(() => independentRepository().persistEngineCollection(failing), (error) => error.code === 'PLAYER_NOT_ON_ROSTER');
  await assertNoPublicationForRun(run.id);
  const generation = await independentRepository().persistEngineCollection(intended);
  const retry = await independentRepository().persistEngineCollection(intended);
  assert.equal(retry.id, generation.id);
  for (const table of ['hs_stat_generations', 'hs_verified_totals']) {
    const result = await fixtureDb.query(`select count(*)::int count from public.${table} where import_run_id=$1`, [run.id]);
    assert.equal(result.rows[0].count, 1, `${table} must contain exactly one committed row`);
  }
  const current = await fixtureDb.query(
    'select count(*)::int count from public.hs_stat_generations where org_id=$1 and team_id=$2 and season_id=$3 and is_current',
    [ids.orgId, ids.teamId, ids.seasonId],
  );
  assert.equal(current.rows[0].count, 1);
});
