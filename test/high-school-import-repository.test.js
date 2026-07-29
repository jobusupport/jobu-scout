'use strict';

// Tests for src/high-school-import-repository.js against the stateful,
// uniqueness-enforcing fake Supabase client (test/helpers/fake-supabase-client.js).
// No network access, no Supabase credentials, no production access.
// Run with: node --test test/high-school-import-repository.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabaseClient } = require('./helpers/fake-supabase-client');
const { createHighSchoolImportRepository } = require('../src/high-school-import-repository');

const LEGACY_TRAVEL_TABLES = [
  'games', 'teams', 'players', 'roster_players', 'batting_lines', 'pitching_lines', 'play_events',
  'stat_validation_runs', 'game_stat_validation_results', 'derived_team_verified_totals',
  'player_advanced_stats', 'pitcher_advanced_stats',
];

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const PROGRAM_A = '33333333-3333-3333-3333-333333333333';
const PROGRAM_B = '44444444-4444-4444-4444-444444444444';
const TEAM_A = '55555555-5555-5555-5555-555555555555';
const TEAM_B = '66666666-6666-6666-6666-666666666666';
const SEASON_A = '77777777-7777-7777-7777-777777777777';
const SEASON_B = '88888888-8888-8888-8888-888888888888';
const RUN_1 = '99999999-9999-9999-9999-999999999999';
const RUN_2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PLAYER_1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PITCHER_1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const GAME_1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const GAME_IDEM = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function ctxA(extra = {}) {
  return { orgId: ORG_A, programId: PROGRAM_A, teamId: TEAM_A, seasonId: SEASON_A, ...extra };
}

function setup() {
  const client = createFakeSupabaseClient();
  const repo = createHighSchoolImportRepository(client);
  return { client, repo };
}

// ── hs_import_runs lifecycle ──────────────────────────────────────────────

test('createImportRun persists a running run with the supplied hierarchy context', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', sourceTeamRef: null, triggerKind: 'manual', config: { dryRun: true } });
  assert.equal(run.status, 'running');
  assert.equal(run.org_id, ORG_A);
  assert.equal(run.team_id, TEAM_A);
  assert.ok(run.started_at);
  assert.equal(run.completed_at, undefined);
  assert.deepEqual(run.config, { dryRun: true });
});

// item 4: completion counts are derived consistently
test('completeImportRun derives games_processed/succeeded/failed from persisted run-game rows, not a caller-supplied number', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });

  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-1', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-2', discoveryStatus: 'processed', gameOutcome: 'replaced' });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-3', discoveryStatus: 'failed', gameOutcome: 'failed' });

  const completed = await repo.completeImportRun({ orgId: ORG_A, importRunId: run.id });
  assert.equal(completed.games_processed, 3);
  assert.equal(completed.games_succeeded, 2);
  assert.equal(completed.games_failed, 1);
  assert.equal(completed.status, 'partial');
  assert.ok(completed.completed_at);
});

test('completeImportRun reports succeeded when zero games failed', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-1', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  const completed = await repo.completeImportRun({ orgId: ORG_A, importRunId: run.id });
  assert.equal(completed.status, 'succeeded');
});

test('completeImportRun reports failed when every processed game failed', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-1', discoveryStatus: 'failed', gameOutcome: 'failed' });
  const completed = await repo.completeImportRun({ orgId: ORG_A, importRunId: run.id });
  assert.equal(completed.status, 'failed');
});

// A row still 'discovered' or 'processing' with no recorded outcome is NOT
// terminal -- completion must be refused rather than silently counted as
// "processed" and reported as a falsely-confident 'succeeded'.
test('completeImportRun refuses to complete while any game is still discovered/processing with no recorded outcome', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-done', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-pending', discoveryStatus: 'discovered' });
  await assert.rejects(
    () => repo.completeImportRun({ orgId: ORG_A, importRunId: run.id }),
    (err) => { assert.equal(err.code, 'RUN_NOT_READY_TO_COMPLETE'); assert.equal(err.retryable, true); return true; }
  );
});

test('completeImportRun refuses to complete while a game is still "processing"', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-in-flight', discoveryStatus: 'processing' });
  await assert.rejects(() => repo.completeImportRun({ orgId: ORG_A, importRunId: run.id }), (err) => { assert.equal(err.code, 'RUN_NOT_READY_TO_COMPLETE'); return true; });
});

test('completeImportRun refuses to complete a "processed" game that was never given a terminal game_outcome', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-ambiguous', discoveryStatus: 'processed' }); // no gameOutcome
  await assert.rejects(() => repo.completeImportRun({ orgId: ORG_A, importRunId: run.id }), (err) => { assert.equal(err.code, 'RUN_NOT_READY_TO_COMPLETE'); return true; });
});

// The exact scenario this repository's own review flagged: three games all
// SKIPPED (a legitimate terminal outcome, not a failure) must not be
// silently miscounted as neither succeeded nor failed while still letting
// the run complete -- every terminal row is now classified into exactly
// one bucket, and skipped/rejected counts are surfaced in result_summary
// even though the status enum itself has no distinct "some games skipped"
// value.
test('completeImportRun classifies skipped and rejected outcomes explicitly rather than excluding them from every count', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-skip-1', discoveryStatus: 'skipped', gameOutcome: 'skipped' });
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-skip-2', discoveryStatus: 'skipped' }); // discovery-level skip, no game_outcome
  await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-rejected', discoveryStatus: 'rejected', gameOutcome: 'rejected' });

  const completed = await repo.completeImportRun({ orgId: ORG_A, importRunId: run.id });
  assert.equal(completed.games_processed, 3);
  assert.equal(completed.games_succeeded, 0);
  assert.equal(completed.games_failed, 0);
  // With zero failures the run itself did not fail -- 'succeeded' is the
  // schema's closest available status -- but the nuance is NOT lost:
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result_summary.skipped, 2);
  assert.equal(completed.result_summary.rejected, 1);
});

// item 5: a failed run receives a bounded, sanitized error
test('failImportRun sanitizes and bounds the stored error_summary', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const failed = await repo.failImportRun({
    orgId: ORG_A, importRunId: run.id, failureStage: 'snapshot_capture',
    rawErrorMessage: `Request failed: Authorization: Bearer secret-token-value. ${'x'.repeat(3000)}`,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_stage, 'snapshot_capture');
  assert.ok(failed.error_summary.length <= 2000);
  assert.doesNotMatch(failed.error_summary, /secret-token-value/);
  assert.ok(failed.completed_at);
});

test('failImportRun does not disturb hs_import_run_games rows already recorded for other games in the same run', async () => {
  const { repo, client } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row: goodGame } = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-good', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  await repo.failImportRun({ orgId: ORG_A, importRunId: run.id, failureStage: 'reconstruction', rawErrorMessage: 'boom' });

  // The already-recorded successful game row must still be intact after the run-level failure.
  const [persisted] = client.__getRows('hs_import_run_games').filter((r) => r.id === goodGame.id);
  assert.equal(persisted.source_game_ref, 'gc-good');
  assert.equal(persisted.game_outcome, 'inserted');
});

// ── hs_import_run_games idempotency (items 6, 7, 24) ──────────────────────

test('recordRunGame is idempotent: a duplicate source game within the SAME run returns the existing row, not a second one', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const first = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-dup', discoveryStatus: 'discovered' });
  const second = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-dup', discoveryStatus: 'discovered' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.row.id, second.row.id);
});

test('the same source game IS allowed again in a LATER, separate import run', async () => {
  const { repo } = setup();
  const runOne = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const runTwo = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const first = await repo.recordRunGame({ orgId: ORG_A, importRunId: runOne.id, sourceGameRef: 'gc-repeat', discoveryStatus: 'discovered' });
  const second = await repo.recordRunGame({ orgId: ORG_A, importRunId: runTwo.id, sourceGameRef: 'gc-repeat', discoveryStatus: 'discovered' });
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(first.row.id, second.row.id);
});

test('retrying an interrupted run (re-calling recordRunGame, resolveOrCreateGame, insertGameValidationResult) never creates unintended duplicates', async () => {
  const { repo, client } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });

  for (let attempt = 0; attempt < 3; attempt++) {
    await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-retry', discoveryStatus: 'discovered' });
    await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-retry' });
  }
  const { row: game } = await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-retry' });
  for (let attempt = 0; attempt < 3; attempt++) {
    await repo.insertGameValidationResult({
      orgId: ORG_A, importRunId: run.id, importRunGameId: null, hsGameId: game.id, teamId: TEAM_A,
      hasBoxScore: true, hasPlayByPlay: false, battingMatchesBox: false, confidence: 'medium', validationStatus: 'validated',
    });
  }

  assert.equal(client.__getRows('hs_import_run_games').filter((r) => r.source_game_ref === 'gc-retry').length, 1);
  assert.equal(client.__getRows('hs_games').filter((r) => r.source_game_ref === 'gc-retry').length, 1);
  assert.equal(client.__getRows('hs_game_validation_results').filter((r) => r.hs_game_id === game.id).length, 1);
});

// item 15/E: unresolved canonical game remains nullable rather than guessed
test('resolveOrCreateGame refuses to guess canonical identity when no sourceGameRef is supplied', async () => {
  const { repo } = setup();
  await assert.rejects(
    () => repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: null }),
    (err) => { assert.equal(err.code, 'CANNOT_RESOLVE_GAME_IDENTITY'); return true; }
  );
});

test('recordRunGame leaves hs_game_id nullable when the source game has not yet resolved to a canonical hs_games row', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row } = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-unresolved', discoveryStatus: 'discovered' });
  assert.equal(row.hs_game_id, null);
});

// item 14: existing canonical game is reused by scoped source identity
test('resolveOrCreateGame reuses the existing hs_games row for the same (org, team, sourceGameRef)', async () => {
  const { repo } = setup();
  const first = await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-reuse', opponentName: 'Rival A', gameDate: '2026-04-01' });
  const second = await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-reuse', opponentName: 'Rival A (renamed)', gameDate: '2026-04-01' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.row.id, second.row.id);
});

// item 8: doubleheaders on the same date remain distinct
test('two games on the same date for the same team (a doubleheader) are NOT deduped -- distinct source refs create distinct hs_games rows', async () => {
  const { repo } = setup();
  const gameOne = await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-dh-1', opponentName: 'Rival', gameDate: '2026-04-10' });
  const gameTwo = await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-dh-2', opponentName: 'Rival', gameDate: '2026-04-10' });
  assert.equal(gameOne.created, true);
  assert.equal(gameTwo.created, true);
  assert.notEqual(gameOne.row.id, gameTwo.row.id);
  assert.equal(gameOne.row.game_date, gameTwo.row.game_date);
});

// item 16: cross-org context cannot be substituted
//
// In production, team_id is a globally-unique uuid_generate_v4() value
// scoped to exactly one org via hs_teams' own composite FK -- two
// different orgs can never legitimately share the same team_id, so the
// realistic case is simply "two different orgs, with their own distinct
// team_id values, never see each other's games":
test('resolveOrCreateGame keeps games fully independent across two different orgs with their own distinct teams', async () => {
  const { repo } = setup();
  const orgAGame = await repo.resolveOrCreateGame({ orgId: ORG_A, programId: PROGRAM_A, teamId: TEAM_A, seasonId: SEASON_A, sourceProvider: 'gamechanger', sourceGameRef: 'gc-shared-ref' });
  const orgBGame = await repo.resolveOrCreateGame({ orgId: ORG_B, programId: PROGRAM_B, teamId: TEAM_B, seasonId: SEASON_B, sourceProvider: 'gamechanger', sourceGameRef: 'gc-shared-ref' });
  assert.equal(orgAGame.created, true);
  assert.equal(orgBGame.created, true);
  assert.notEqual(orgAGame.row.id, orgBGame.row.id);
  assert.equal(orgAGame.row.org_id, ORG_A);
  assert.equal(orgBGame.row.org_id, ORG_B);
});

// Defense in depth: resolveOrCreateGame's lookup is explicitly scoped by
// org_id (not just team_id) -- even in the data-integrity-impossible case
// of a team_id string being shared across two orgs (which cannot happen
// via the real composite FK, but is worth verifying the QUERY itself
// still guards against), org B's lookup must never return org A's row.
// The fake DB's unique index (matching the migration's own
// idx_hs_games_team_source_game_ref, which is NOT org-scoped) means this
// contrived case fails closed rather than succeeding -- but critically,
// it fails closed, never leaking org A's row to an org B caller.
test('resolveOrCreateGame never returns another org\'s row even under a contrived shared team_id (fails closed, never leaks cross-org data)', async () => {
  const { repo } = setup();
  const orgAGame = await repo.resolveOrCreateGame({ orgId: ORG_A, programId: PROGRAM_A, teamId: TEAM_A, seasonId: SEASON_A, sourceProvider: 'gamechanger', sourceGameRef: 'gc-contrived-shared' });

  const result = await repo.resolveOrCreateGame({ orgId: ORG_B, programId: PROGRAM_A, teamId: TEAM_A, seasonId: SEASON_A, sourceProvider: 'gamechanger', sourceGameRef: 'gc-contrived-shared' });
  if (result.row) {
    assert.equal(result.row.org_id, ORG_B, 'must never return org A\'s row to an org B caller');
    assert.notEqual(result.row.id, orgAGame.row.id);
  }
});

// item 17: cross-team context cannot be substituted
test('resolveOrCreateGame never reuses a game across two different teams in the same org', async () => {
  const { repo } = setup();
  const teamAGame = await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-team-scoped' });
  const teamBGame = await repo.resolveOrCreateGame({ ...ctxA({ teamId: TEAM_B }), sourceProvider: 'gamechanger', sourceGameRef: 'gc-team-scoped' });
  assert.equal(teamAGame.created, true);
  assert.equal(teamBGame.created, true);
  assert.notEqual(teamAGame.row.id, teamBGame.row.id);
});

// ── hs_raw_snapshots (items 9, 13) ─────────────────────────────────────────

test('captureRawSnapshot persists a JSON payload directly -- no local file path field exists on the row', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row } = await repo.captureRawSnapshot({
    orgId: ORG_A, importRunId: run.id, snapshotKind: 'box_score', sourceProvider: 'gamechanger',
    payload: { batting: [{ player: 'Alice', ab: 3 }] }, contentType: 'json',
  });
  assert.deepEqual(row.payload, { batting: [{ player: 'Alice', ab: 3 }] });
  assert.equal(row.json_file, undefined);
  assert.equal(row.file_path, undefined);
  assert.equal(row.screenshot_path, undefined);
});

test('snapshot uniqueness: two captures for the same (import_run_game_id, kind, captured_at) are deduped -- the WITH-game partial index', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row: runGame } = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-snap', discoveryStatus: 'discovered' });
  const capturedAt = '2026-04-01T12:00:00.000Z';
  const first = await repo.captureRawSnapshot({ orgId: ORG_A, importRunId: run.id, importRunGameId: runGame.id, snapshotKind: 'box_score', sourceProvider: 'gamechanger', payload: { v: 1 }, contentType: 'json', capturedAt });
  const second = await repo.captureRawSnapshot({ orgId: ORG_A, importRunId: run.id, importRunGameId: runGame.id, snapshotKind: 'box_score', sourceProvider: 'gamechanger', payload: { v: 1 }, contentType: 'json', capturedAt });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.row.id, second.row.id);
});

test('snapshot uniqueness: two RUN-LEVEL captures (no game association) at the same (run, kind, captured_at) are deduped -- the RUN-LEVEL partial index', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const capturedAt = '2026-04-01T09:00:00.000Z';
  const first = await repo.captureRawSnapshot({ orgId: ORG_A, importRunId: run.id, snapshotKind: 'schedule_discovery', sourceProvider: 'gamechanger', payload: { games: [] }, contentType: 'json', capturedAt });
  const second = await repo.captureRawSnapshot({ orgId: ORG_A, importRunId: run.id, snapshotKind: 'schedule_discovery', sourceProvider: 'gamechanger', payload: { games: [] }, contentType: 'json', capturedAt });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
});

test('a run-level snapshot and a game-scoped snapshot for the same run/kind/timestamp do NOT collide with each other (the two partial indexes are independent)', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row: runGame } = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-mix', discoveryStatus: 'discovered' });
  const capturedAt = '2026-04-01T10:00:00.000Z';
  const runLevel = await repo.captureRawSnapshot({ orgId: ORG_A, importRunId: run.id, snapshotKind: 'schedule_discovery', sourceProvider: 'gamechanger', payload: {}, contentType: 'json', capturedAt });
  const gameLevel = await repo.captureRawSnapshot({ orgId: ORG_A, importRunId: run.id, importRunGameId: runGame.id, snapshotKind: 'schedule_discovery', sourceProvider: 'gamechanger', payload: {}, contentType: 'json', capturedAt });
  assert.equal(runLevel.created, true);
  assert.equal(gameLevel.created, true);
  assert.notEqual(runLevel.row.id, gameLevel.row.id);
});

// ── hs_game_validation_results (official vs reconstructed separation) ────

test('insertGameValidationResult keeps box-score and reconstructed totals in separate columns, never merged', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row } = await repo.insertGameValidationResult({
    orgId: ORG_A, importRunId: run.id, importRunGameId: null, hsGameId: GAME_1, teamId: TEAM_A,
    hasBoxScore: true, hasPlayByPlay: true,
    boxScoreBatting: { ab: 10, h: 3 },
    reconstructedBatting: { ab: 9, h: 2 },
    battingMatchesBox: false, confidence: 'medium', validationStatus: 'mismatched',
  });
  assert.deepEqual(row.box_score_batting, { ab: 10, h: 3 });
  assert.deepEqual(row.reconstructed_batting, { ab: 9, h: 2 });
  assert.notDeepEqual(row.box_score_batting, row.reconstructed_batting);
});

test('insertGameValidationResult is idempotent per (import_run_id, hs_game_id)', async () => {
  const { repo } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const first = await repo.insertGameValidationResult({ orgId: ORG_A, importRunId: run.id, hsGameId: GAME_IDEM, teamId: TEAM_A, hasBoxScore: true, hasPlayByPlay: false, battingMatchesBox: false, confidence: 'medium', validationStatus: 'validated' });
  const second = await repo.insertGameValidationResult({ orgId: ORG_A, importRunId: run.id, hsGameId: GAME_IDEM, teamId: TEAM_A, hasBoxScore: true, hasPlayByPlay: false, battingMatchesBox: false, confidence: 'medium', validationStatus: 'validated' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
});

// ── current/superseded (item 20, item 22) ─────────────────────────────────

test('publishVerifiedTotals never deletes -- superseding a current row leaves the prior row intact with is_current=false and a superseded_at timestamp', async () => {
  const { repo, client } = setup();
  const first = await repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } });
  const second = await repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 2, boxScoreGames: 2, playByPlayGames: 1, validatedGames: 1, mismatchGames: 0, confidence: 'medium' } });

  assert.equal(first.is_current, true);
  assert.equal(second.is_current, true);
  assert.notEqual(first.id, second.id);

  const allRows = client.__getRows('hs_verified_totals');
  assert.equal(allRows.length, 2, 'the prior row must still exist, not be deleted');
  const priorRow = allRows.find((r) => r.id === first.id);
  assert.equal(priorRow.is_current, false);
  assert.ok(priorRow.superseded_at);
  const currentRow = allRows.find((r) => r.id === second.id);
  assert.equal(currentRow.is_current, true);
  assert.equal(currentRow.superseded_at, null);
});

test('at most one current row can ever exist per (team_id, season_id) -- the fake DB enforces the same partial unique index the migration declares', async () => {
  const { repo, client } = setup();
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } });
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 2, boxScoreGames: 2, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } });
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 3, boxScoreGames: 3, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } });
  const currentRows = client.__getRows('hs_verified_totals').filter((r) => r.is_current);
  assert.equal(currentRows.length, 1);
  assert.equal(currentRows[0].games, 3);
});

test('publishVerifiedTotals for a DIFFERENT season does not supersede the other season\'s current row', async () => {
  const { repo, client } = setup();
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } });
  await repo.publishVerifiedTotals({ ...ctxA({ seasonId: SEASON_B }), importRunId: null, aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } });
  const currentRows = client.__getRows('hs_verified_totals').filter((r) => r.is_current);
  assert.equal(currentRows.length, 2);
});

// item 22: pre-resolved player IDs are persisted with full hierarchy context
test('publishPlayerAdvancedStats persists the full hierarchy (org/program/team/season/player) alongside the stat blob', async () => {
  const { repo } = setup();
  const row = await repo.publishPlayerAdvancedStats({ ...ctxA(), importRunId: RUN_1, playerId: PLAYER_1, stats: { games: 5, gb: 3, fb: 2, k_pct: 12.5 } });
  assert.equal(row.org_id, ORG_A);
  assert.equal(row.program_id, PROGRAM_A);
  assert.equal(row.team_id, TEAM_A);
  assert.equal(row.season_id, SEASON_A);
  assert.equal(row.player_id, PLAYER_1);
  assert.equal(row.games, 5);
  assert.equal(row.gb, 3);
  assert.equal(row.is_current, true);
});

test('publishPlayerAdvancedStats supersedes the prior current row for the same (player, team, season), keeping history', async () => {
  const { repo, client } = setup();
  const first = await repo.publishPlayerAdvancedStats({ ...ctxA(), importRunId: RUN_1, playerId: PLAYER_1, stats: { games: 1 } });
  const second = await repo.publishPlayerAdvancedStats({ ...ctxA(), importRunId: RUN_2, playerId: PLAYER_1, stats: { games: 2 } });
  assert.notEqual(first.id, second.id);
  const rows = client.__getRows('hs_player_advanced_stats');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === first.id).is_current, false);
});

// Slice 1A.1: the RPC now REJECTS a reserved/identity key inside the stats
// blob outright (UNKNOWN_STAT_FIELD) rather than Slice 1A's own JS-level
// silent-strip -- see src/high-school-import-repository.js's
// publishPlayerAdvancedStats comment for why an explicit rejection is
// preferable to a caller never finding out their org_id/is_current/
// player_id override was silently discarded.
test('publishPlayerAdvancedStats rejects a stats blob containing a reserved/identity key rather than silently stripping it', async () => {
  const { repo } = setup();
  await assert.rejects(
    () => repo.publishPlayerAdvancedStats({
      ...ctxA(), importRunId: RUN_1, playerId: PLAYER_1,
      stats: { games: 3, org_id: 'attacker-org', is_current: false, player_id: 'someone-else' },
    }),
    (err) => { assert.equal(err.code, 'UNKNOWN_STAT_FIELD'); return true; }
  );
});

test('publishPitcherAdvancedStats follows the same current/superseded and hierarchy rules as player stats', async () => {
  const { repo, client } = setup();
  const first = await repo.publishPitcherAdvancedStats({ ...ctxA(), importRunId: RUN_1, playerId: PITCHER_1, stats: { games: 1, so_per7: 8.1 } });
  const second = await repo.publishPitcherAdvancedStats({ ...ctxA(), importRunId: RUN_2, playerId: PITCHER_1, stats: { games: 2, so_per7: 9.0 } });
  assert.notEqual(first.id, second.id);
  const currentRows = client.__getRows('hs_pitcher_advanced_stats').filter((r) => r.is_current);
  assert.equal(currentRows.length, 1);
  assert.equal(currentRows[0].id, second.id);
});

// ── Slice 1A.1: atomic publish via RPC (was "documented non-atomicity") ──
//
// Slice 1A's own repository made a THREE-call sequence (select, update,
// insert) and could only document -- never close -- the gap where an
// insert failure after a successful supersede left zero current rows.
// Slice 1A.1 (supabase/migrations/20260729190000_add_hs_publish_rpcs.sql)
// replaces that sequence with a single `adminClient.rpc(...)` call, so
// there is no longer a client-visible partial state to simulate via
// `.from()` monkey-patching -- proving true transactional rollback (a bad
// row leaving the database completely unchanged) requires a real Postgres
// transaction, which this fake cannot fabricate. That proof lives in
// test/high-school-import-publish-rpcs.integration.test.js (real Supabase
// preview branch). What THIS fake-client-level test proves instead is the
// repository's own contract: an RPC failure of any kind propagates as a
// thrown, typed error, and the fake's in-memory state (which never
// diverges mid-call, since `executePublishRpc` runs synchronously
// start-to-finish with no await in the middle) is left with the prior
// current row intact.
test('publishVerifiedTotals propagates an RPC failure as a thrown error and leaves the prior current row untouched', async () => {
  const { repo, client } = setup();
  const first = await repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } });

  const originalRpc = client.rpc.bind(client);
  client.rpc = (name, params) => {
    if (name === 'publish_hs_verified_totals') {
      return Promise.resolve({ data: null, error: { message: 'simulated_rpc_failure: forced for this test' } });
    }
    return originalRpc(name, params);
  };

  await assert.rejects(
    () => repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 2, boxScoreGames: 2, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } }),
    (err) => { assert.equal(err.code, 'PERSISTENCE_FAILED'); return true; }
  );

  const rows = client.__getRows('hs_verified_totals').filter((r) => r.team_id === TEAM_A && r.season_id === SEASON_A);
  assert.equal(rows.length, 1, 'no new row was inserted');
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].is_current, true, 'the prior current row must remain current -- an RPC failure never partially supersedes it');
  assert.equal(rows[0].superseded_at, null);
});

// The RPC-specific error-message prefixes this repository maps to typed
// codes (see PUBLISH_RPC_ERRORS in src/high-school-import-repository.js)
// propagate with their documented code and retryable flag, exactly as
// Slice 1A's own CONCURRENT_PUBLICATION_CONFLICT did -- proving the
// mapping itself, not the underlying database race (which this fake
// cannot produce; see the real, disposable-Postgres integration test for
// that).
test('a concurrent_publication_conflict-prefixed RPC error is surfaced as the documented, retryable CONCURRENT_PUBLICATION_CONFLICT code', async () => {
  const { repo, client } = setup();
  const originalRpc = client.rpc.bind(client);
  client.rpc = (name, params) => {
    if (name === 'publish_hs_verified_totals') {
      return Promise.resolve({ data: null, error: { message: 'concurrent_publication_conflict: could not supersede the current row for team x/season y' } });
    }
    return originalRpc(name, params);
  };

  await assert.rejects(
    () => repo.publishVerifiedTotals({ ...ctxA(), importRunId: null, aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' } }),
    (err) => { assert.equal(err.code, 'CONCURRENT_PUBLICATION_CONFLICT'); assert.equal(err.retryable, true); return true; }
  );
});

// ── item 23: repository failures propagate, never silently succeed ───────

test('a client-level failure during completeImportRun propagates as a thrown error rather than a falsely-successful completion', async () => {
  const { repo, client } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const originalFrom = client.from.bind(client);
  client.from = (table) => {
    if (table === 'hs_import_run_games') {
      return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'simulated read failure' } }) }) }) };
    }
    return originalFrom(table);
  };
  await assert.rejects(() => repo.completeImportRun({ orgId: ORG_A, importRunId: run.id }), (err) => {
    assert.equal(err.code, 'PERSISTENCE_FAILED');
    return true;
  });
});

// ── item 25: no legacy travel table ever receives a write ────────────────

test('a full run/game/snapshot/validation/verified-totals/player-stats lifecycle never touches any legacy Travel table', async () => {
  const { repo, client } = setup();
  const run = await repo.createImportRun({ ...ctxA(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row: runGame } = await repo.recordRunGame({ orgId: ORG_A, importRunId: run.id, sourceGameRef: 'gc-full', discoveryStatus: 'discovered' });
  await repo.captureRawSnapshot({ orgId: ORG_A, importRunId: run.id, importRunGameId: runGame.id, snapshotKind: 'box_score', sourceProvider: 'gamechanger', payload: { ok: true }, contentType: 'json' });
  const { row: game } = await repo.resolveOrCreateGame({ ...ctxA(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-full' });
  await repo.updateRunGameOutcome({ orgId: ORG_A, runGameId: runGame.id, discoveryStatus: 'processed', gameOutcome: 'inserted', hsGameId: game.id });
  await repo.insertGameValidationResult({ orgId: ORG_A, importRunId: run.id, importRunGameId: runGame.id, hsGameId: game.id, teamId: TEAM_A, hasBoxScore: true, hasPlayByPlay: false, battingMatchesBox: false, confidence: 'medium', validationStatus: 'validated' });
  await repo.publishVerifiedTotals({ ...ctxA(), importRunId: run.id, aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'medium' } });
  await repo.publishPlayerAdvancedStats({ ...ctxA(), importRunId: run.id, playerId: PLAYER_1, stats: { games: 1 } });
  await repo.publishPitcherAdvancedStats({ ...ctxA(), importRunId: run.id, playerId: PITCHER_1, stats: { games: 1 } });
  await repo.completeImportRun({ orgId: ORG_A, importRunId: run.id });

  for (const legacyTable of LEGACY_TRAVEL_TABLES) {
    assert.equal(client.__touchedTables.has(legacyTable), false, `expected ${legacyTable} to never be touched`);
  }
  for (const hsTable of ['hs_import_runs', 'hs_import_run_games', 'hs_raw_snapshots', 'hs_games', 'hs_game_validation_results', 'hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats']) {
    assert.equal(client.__touchedTables.has(hsTable), true, `expected ${hsTable} to be touched by the full lifecycle`);
  }
});

// ── fake client schema enforcement (item 5: UUID/NOT NULL, not just uniqueness) ─
//
// These prove a malformed identifier or a missing required column is
// rejected by THIS repository's calls, not merely tolerated by the fake
// and left for a real database to catch later.

test('a malformed (non-UUID) hierarchy identifier is rejected by the fake client the same way a real uuid column would reject it', async () => {
  const { repo } = setup();
  await assert.rejects(
    () => repo.createImportRun({ orgId: 'not-a-uuid', programId: PROGRAM_A, teamId: TEAM_A, seasonId: SEASON_A, sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} }),
    (err) => { assert.equal(err.code, 'PERSISTENCE_FAILED'); assert.match(err.message, /uuid/i); return true; }
  );
});

test('a missing NOT NULL column is rejected by the fake client rather than silently persisted as null', async () => {
  const { repo } = setup();
  await assert.rejects(
    () => repo.createImportRun({ orgId: ORG_A, programId: undefined, teamId: TEAM_A, seasonId: SEASON_A, sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} }),
    (err) => { assert.equal(err.code, 'PERSISTENCE_FAILED'); assert.match(err.message, /program_id/); return true; }
  );
});

test('resolveOrCreateGame with a malformed teamId is rejected rather than silently creating an unreferenceable row', async () => {
  const { repo } = setup();
  await assert.rejects(
    () => repo.resolveOrCreateGame({ orgId: ORG_A, programId: PROGRAM_A, teamId: 'team-not-a-uuid', seasonId: SEASON_A, sourceProvider: 'gamechanger', sourceGameRef: 'gc-bad-team' }),
    (err) => { assert.equal(err.code, 'PERSISTENCE_FAILED'); assert.match(err.message, /uuid/i); return true; }
  );
});

// ── constructor guard ─────────────────────────────────────────────────────

test('createHighSchoolImportRepository refuses to build without an injected client', () => {
  assert.throws(() => createHighSchoolImportRepository(null), (err) => { assert.equal(err.code, 'INVALID_REPOSITORY_CLIENT'); return true; });
  assert.throws(() => createHighSchoolImportRepository({}));
});
