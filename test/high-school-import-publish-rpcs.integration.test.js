'use strict';

// Integration tests for the Slice 1A.1 atomic publishing RPCs
// (supabase/migrations/20260729190000_add_hs_publish_rpcs.sql):
// publish_hs_verified_totals, publish_hs_player_advanced_stats,
// publish_hs_pitcher_advanced_stats.
//
// WRITTEN BUT NOT EXECUTED by default -- mirrors
// test/api-product-capabilities.test.js's and
// test/high-school-api-integration.test.js's exact gating design (see
// those files' own header comments for the full rationale). Unlike those
// two, this file talks to Postgres DIRECTLY via
// createHighSchoolImportRepository(adminClient) -- it never starts or
// calls this application's own server -- because what this file proves
// (transactional rollback, row-level ownership checks, EXECUTE grants)
// lives entirely inside the database function, not in any HTTP route.
//
// Requires:
//   1. supabase/migrations/20260729190000_add_hs_publish_rpcs.sql (and
//      every migration before it) applied to a NON-PRODUCTION Supabase
//      project/branch.
//   2. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in this process's own
//      environment, pointing at that project.
//   3. SUPABASE_ANON_KEY, for the anon/authenticated-cannot-execute
//      security tests.
//
// Same multi-gate safety design as the two files above: RUN_INTEGRATION_TESTS=1
// AND TEST_CONFIRM_NON_PRODUCTION=yes must BOTH be set, AND the configured
// SUPABASE_URL is refused outright if it resolves to the known production
// project ref, regardless of what the other flags say.
//
// Every fixture row this file creates is tagged with a fresh, random UUID
// prefix per run and deleted in an `after` hook -- safe to run repeatedly
// against the same preview branch without accumulating state.
//
// Run with: node --test test/high-school-import-publish-rpcs.integration.test.js

const KNOWN_PRODUCTION_PROJECT_REF = 'jqycdruhcaqdumuhirsw'; // "Jobu Scout Project"
const configuredSupabaseUrl = process.env.SUPABASE_URL || '';
const pointsAtProduction = configuredSupabaseUrl.includes(KNOWN_PRODUCTION_PROJECT_REF);

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const confirmedNonProduction = process.env.TEST_CONFIRM_NON_PRODUCTION === 'yes';
const hasCredentials = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = RUN && confirmedNonProduction && hasCredentials && !pointsAtProduction;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const skip = pointsAtProduction
  ? `refusing to run: SUPABASE_URL resolves to the known production project (${KNOWN_PRODUCTION_PROJECT_REF}) -- point this process's environment at a preview branch/staging project first`
  : canRun
  ? false
  : 'requires RUN_INTEGRATION_TESTS=1, TEST_CONFIRM_NON_PRODUCTION=yes, and SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY in this process\'s own environment -- see file header';

let adminClient;
let repo;
let orgAId, orgBId, programAId, programBId, seasonAId, teamAId, teamBId, playerAId, runAId, runBId;

if (canRun) {
  const { createClient } = require('@supabase/supabase-js');
  const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');
  adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  repo = createHighSchoolImportRepository(adminClient);
}

test.before(async () => {
  if (!canRun) return;
  const suffix = crypto.randomUUID().slice(0, 8);

  const org = async (label) => {
    const { data, error } = await adminClient.from('organizations').insert({
      name: `Publish RPC test org ${label} ${suffix}`,
      slug: `publish-rpc-test-${label}-${suffix}`,
      customer_type: 'high_school',
      primary_product: 'high_school',
      enabled_products: ['high_school'],
    }).select('id').single();
    assert.equal(error, null, `failed to create org ${label}: ${error?.message}`);
    return data.id;
  };
  orgAId = await org('a');
  orgBId = await org('b');

  const program = async (orgId, label) => {
    const { data, error } = await adminClient.from('hs_programs').insert({ org_id: orgId, name: `Program ${label} ${suffix}` }).select('id').single();
    assert.equal(error, null, error?.message);
    return data.id;
  };
  programAId = await program(orgAId, 'a');
  programBId = await program(orgBId, 'b');

  const season = async (orgId, programId) => {
    const { data, error } = await adminClient.from('hs_seasons').insert({ org_id: orgId, program_id: programId, name: `Season ${suffix}`, school_year: '2025-2026' }).select('id').single();
    assert.equal(error, null, error?.message);
    return data.id;
  };
  seasonAId = await season(orgAId, programAId);

  const team = async (orgId, programId, label) => {
    const { data, error } = await adminClient.from('hs_teams').insert({ org_id: orgId, program_id: programId, level: 'varsity', name: `Team ${label} ${suffix}` }).select('id').single();
    assert.equal(error, null, error?.message);
    return data.id;
  };
  teamAId = await team(orgAId, programAId, 'a');
  teamBId = await team(orgBId, programBId, 'b');

  const { data: playerRow, error: playerError } = await adminClient.from('hs_players').insert({ org_id: orgAId, program_id: programAId, first_name: 'Test', last_name: `Player ${suffix}` }).select('id').single();
  assert.equal(playerError, null, playerError?.message);
  playerAId = playerRow.id;

  const run = async (status, startedOffsetMinutesAgo = 0) => {
    const { data, error } = await adminClient.from('hs_import_runs').insert({
      org_id: orgAId, program_id: programAId, team_id: teamAId, season_id: seasonAId,
      source_provider: 'gamechanger', trigger_kind: 'manual', status,
      started_at: new Date(Date.now() - startedOffsetMinutesAgo * 60000).toISOString(),
      completed_at: status === 'running' ? null : new Date().toISOString(),
    }).select('id').single();
    assert.equal(error, null, error?.message);
    return data.id;
  };
  runAId = await run('running', 10); // older
  runBId = await run('running', 0); // newer
});

test.after(async () => {
  if (!canRun) return;
  // Children first, respecting FK order; org cascade-deletes everything else.
  await adminClient.from('organizations').delete().in('id', [orgAId, orgBId].filter(Boolean));
});

// ── successful publish ────────────────────────────────────────────────────

test('publishVerifiedTotals succeeds through the real RPC and returns the persisted row', { skip }, async () => {
  const row = await repo.publishVerifiedTotals({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: runAId,
    aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
  });
  assert.equal(row.org_id, orgAId);
  assert.equal(row.team_id, teamAId);
  assert.equal(row.is_current, true);
});

test('publishPlayerAdvancedStats and publishPitcherAdvancedStats succeed through the real RPC', { skip }, async () => {
  const player = await repo.publishPlayerAdvancedStats({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: runAId,
    playerId: playerAId, stats: { games: 5, gb: 3, fb: 2, k_pct: 12.5 },
  });
  assert.equal(player.player_id, playerAId);
  assert.equal(player.games, 5);
  assert.equal(player.is_current, true);

  const pitcher = await repo.publishPitcherAdvancedStats({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: runAId,
    playerId: playerAId, stats: { games: 3, so_per7: 8.1 },
  });
  assert.equal(pitcher.player_id, playerAId);
  assert.equal(Number(pitcher.so_per7), 8.1);
  assert.equal(pitcher.is_current, true);
});

test('publishing again for the same identity supersedes the prior row -- both remain in history, only one is current', { skip }, async () => {
  const first = await repo.publishVerifiedTotals({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: runAId,
    aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
  });
  const second = await repo.publishVerifiedTotals({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: runBId,
    aggregate: { games: 2, boxScoreGames: 2, playByPlayGames: 1, validatedGames: 1, mismatchGames: 0, confidence: 'medium' },
  });
  assert.notEqual(first.id, second.id);

  const { data: rows, error } = await adminClient.from('hs_verified_totals').select('id, is_current').eq('team_id', teamAId).eq('season_id', seasonAId);
  assert.equal(error, null);
  const current = rows.filter((r) => r.is_current);
  assert.equal(current.length, 1, 'exactly one current row must exist for this identity');
  assert.equal(current[0].id, second.id);
  assert.ok(rows.find((r) => r.id === first.id), 'the prior row must still exist -- never deleted');
});

// ── ownership / lifecycle / gate rejections (defense in depth) ────────────

test('publishVerifiedTotals rejects a team belonging to a different organization', { skip }, async () => {
  await assert.rejects(
    () => repo.publishVerifiedTotals({
      orgId: orgAId, programId: programAId, teamId: teamBId, seasonId: seasonAId, importRunId: null,
      aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
    }),
    (err) => { assert.equal(err.code, 'TEAM_NOT_FOUND_FOR_ORG'); return true; }
  );
});

test('publishVerifiedTotals rejects an import run belonging to a different team/org', { skip }, async () => {
  const { data: otherRun, error } = await adminClient.from('hs_import_runs').insert({
    org_id: orgBId, program_id: programBId, team_id: teamBId, source_provider: 'gamechanger', trigger_kind: 'manual', status: 'running', started_at: new Date().toISOString(),
  }).select('id').single();
  assert.equal(error, null);
  try {
    await assert.rejects(
      () => repo.publishVerifiedTotals({
        orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: otherRun.id,
        aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
      }),
      (err) => { assert.equal(err.code, 'IMPORT_RUN_NOT_FOUND_FOR_ORG_TEAM'); return true; }
    );
  } finally {
    await adminClient.from('hs_import_runs').delete().eq('id', otherRun.id);
  }
});

test('publishVerifiedTotals rejects a non-running import run', { skip }, async () => {
  const { data: doneRun, error } = await adminClient.from('hs_import_runs').insert({
    org_id: orgAId, program_id: programAId, team_id: teamAId, season_id: seasonAId, source_provider: 'gamechanger', trigger_kind: 'manual', status: 'succeeded', started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  }).select('id').single();
  assert.equal(error, null);
  try {
    await assert.rejects(
      () => repo.publishVerifiedTotals({
        orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: doneRun.id,
        aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
      }),
      (err) => { assert.equal(err.code, 'INVALID_IMPORT_RUN_STATE'); return true; }
    );
  } finally {
    await adminClient.from('hs_import_runs').delete().eq('id', doneRun.id);
  }
});

test('publishVerifiedTotals rejects incomplete box-score coverage even if called directly (defense in depth beneath the service-layer gate)', { skip }, async () => {
  await assert.rejects(
    () => repo.publishVerifiedTotals({
      orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: null,
      aggregate: { games: 3, boxScoreGames: 2, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
    }),
    (err) => { assert.equal(err.code, 'INCOMPLETE_BOX_SCORE_COVERAGE'); return true; }
  );
});

test('publishVerifiedTotals rejects any unresolved mismatch even if called directly', { skip }, async () => {
  await assert.rejects(
    () => repo.publishVerifiedTotals({
      orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: null,
      aggregate: { games: 2, boxScoreGames: 2, playByPlayGames: 1, validatedGames: 1, mismatchGames: 1, confidence: 'medium' },
    }),
    (err) => { assert.equal(err.code, 'UNRESOLVED_MISMATCH'); return true; }
  );
});

test('publishPlayerAdvancedStats rejects a stats blob containing a reserved/unknown field', { skip }, async () => {
  await assert.rejects(
    () => repo.publishPlayerAdvancedStats({
      orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: null,
      playerId: playerAId, stats: { games: 1, org_id: 'attacker-org', is_current: false },
    }),
    (err) => { assert.equal(err.code, 'UNKNOWN_STAT_FIELD'); return true; }
  );
});

test('publishPitcherAdvancedStats rejects a stats blob containing an unknown field', { skip }, async () => {
  await assert.rejects(
    () => repo.publishPitcherAdvancedStats({
      orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: null,
      playerId: playerAId, stats: { games: 1, batting_average: 0.5 }, // not a pitcher column
    }),
    (err) => { assert.equal(err.code, 'UNKNOWN_STAT_FIELD'); return true; }
  );
});

test('publishVerifiedTotals rejects an OLDER import run publishing after a NEWER run already published (stale-publication guard)', { skip }, async () => {
  await repo.publishVerifiedTotals({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: runBId, // newer run publishes first
    aggregate: { games: 2, boxScoreGames: 2, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
  });
  await assert.rejects(
    () => repo.publishVerifiedTotals({
      orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: runAId, // older run tries to publish after
      aggregate: { games: 3, boxScoreGames: 3, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
    }),
    (err) => { assert.equal(err.code, 'STALE_IMPORT_RUN_PUBLICATION'); return true; }
  );
});

// ── real transactional atomicity (not a mocked JS function) ──────────────

test('a bad player row causes the ENTIRE publish to roll back at the database level -- the prior current row is left completely unchanged', { skip }, async () => {
  const before = await repo.publishPlayerAdvancedStats({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: null,
    playerId: playerAId, stats: { games: 7 },
  });

  // "games" is an integer column; jsonb_populate_record fails casting this,
  // AFTER the function has already (in-transaction) superseded `before`.
  await assert.rejects(() => adminClient.rpc('publish_hs_player_advanced_stats', {
    p_org_id: orgAId, p_program_id: programAId, p_team_id: teamAId, p_season_id: seasonAId,
    p_player_id: playerAId, p_import_run_id: null, p_stats: { games: 'not-a-number' },
  }).then(({ error }) => { if (error) throw error; }));

  const { data: rows, error } = await adminClient.from('hs_player_advanced_stats').select('id, is_current, superseded_at, games').eq('id', before.id).single();
  assert.equal(error, null);
  assert.equal(rows.is_current, true, 'the failed publish must not have superseded the prior row');
  assert.equal(rows.superseded_at, null);
  assert.equal(rows.games, 7);
});

test('a bad pitcher row causes the ENTIRE publish to roll back, leaving the prior current row unchanged', { skip }, async () => {
  const before = await repo.publishPitcherAdvancedStats({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: null,
    playerId: playerAId, stats: { games: 4 },
  });

  await assert.rejects(() => adminClient.rpc('publish_hs_pitcher_advanced_stats', {
    p_org_id: orgAId, p_program_id: programAId, p_team_id: teamAId, p_season_id: seasonAId,
    p_player_id: playerAId, p_import_run_id: null, p_stats: { games: 'not-a-number' },
  }).then(({ error }) => { if (error) throw error; }));

  const { data: rows, error } = await adminClient.from('hs_pitcher_advanced_stats').select('id, is_current, superseded_at, games').eq('id', before.id).single();
  assert.equal(error, null);
  assert.equal(rows.is_current, true);
  assert.equal(rows.superseded_at, null);
  assert.equal(rows.games, 4);
});

test('verified totals are never partially changed on failure -- an ownership rejection leaves the existing current row untouched', { skip }, async () => {
  const before = await repo.publishVerifiedTotals({
    orgId: orgAId, programId: programAId, teamId: teamAId, seasonId: seasonAId, importRunId: null,
    aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
  });

  await assert.rejects(() => repo.publishVerifiedTotals({
    orgId: orgAId, programId: programAId, teamId: teamBId, seasonId: seasonAId, importRunId: null, // wrong org/team combo
    aggregate: { games: 9, boxScoreGames: 9, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
  }));

  const { data: row, error } = await adminClient.from('hs_verified_totals').select('id, is_current, games').eq('id', before.id).single();
  assert.equal(error, null);
  assert.equal(row.is_current, true);
  assert.equal(row.games, 1);
});

// ── authorization: anon/authenticated cannot execute these RPCs at all ───

test('anonymous callers cannot execute any of the three publishing RPCs', { skip }, async () => {
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_ANON_KEY) {
    // eslint-disable-next-line no-console
    console.log('  (skipping anon-role assertion: SUPABASE_ANON_KEY not set)');
    return;
  }
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  for (const rpcName of ['publish_hs_verified_totals', 'publish_hs_player_advanced_stats', 'publish_hs_pitcher_advanced_stats']) {
    const { error } = await anonClient.rpc(rpcName, {});
    assert.ok(error, `${rpcName} must be unreachable for the anon role`);
    assert.match(String(error.message || error.code || ''), /permission denied|42501/i);
  }
});
