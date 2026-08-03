'use strict';

// Tests for src/high-school-import-service.js -- the orchestration layer
// wiring validation, sanitization, pure reconstruction (game-reconstructor.js,
// unmodified), and the repository together. Uses the SAME stateful fake
// Supabase client as the repository tests (via the real
// createHighSchoolImportRepository), never a hand-written parallel fake --
// see fake-supabase-client.js's own header for why. No network access, no
// Supabase credentials, no production access, no GameChanger, no Playwright.
// Run with: node --test test/high-school-import-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createFakeSupabaseClient } = require('./helpers/fake-supabase-client');
const { createHighSchoolImportRepository, createHighSchoolImportService } = require('../src/high-school-import-service');

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROGRAM_ID = '22222222-2222-2222-2222-222222222222';
const TEAM_ID = '33333333-3333-3333-3333-333333333333';
const SEASON_ID = '44444444-4444-4444-4444-444444444444';
const PLAYER_ID = '55555555-5555-5555-5555-555555555555';
const RUN_ID = '66666666-6666-6666-6666-666666666666';

function ctx(extra = {}) {
  return { orgId: ORG_ID, programId: PROGRAM_ID, teamId: TEAM_ID, seasonId: SEASON_ID, ...extra };
}

function setup() {
  const client = createFakeSupabaseClient();
  const repository = createHighSchoolImportRepository(client);
  const service = createHighSchoolImportService({ repository });
  return { client, repository, service };
}

// A single-play game, box score and play-by-play IN AGREEMENT (one single,
// no other events). isHighSchoolTeam: true marks Alice's row as the
// imported High School team's OWN data, in this module's natural
// (non-inverted) public polarity -- see toReconstructionInput's own header
// comment for why this is a deliberately distinct field from the
// travel-ball is_our_team convention.
function agreeingCapturedGame() {
  return {
    boxScore: {
      batting: [{ Player: 'Alice Smith', TeamSide: 'away', isHighSchoolTeam: true, AB: 1, H: 1, BB: 0, SO: 0, HBP: 0 }],
      pitching: [],
    },
    plays: [{ text: 'Alice Smith singles to left field.', inning: 'Top 1' }],
  };
}

// Box score claims 3 hits in 3 at-bats; play-by-play only reconstructs one
// ground-out -- a genuine mismatch (delta beyond the ±1 tolerance).
function mismatchedCapturedGame() {
  return {
    boxScore: {
      batting: [{ Player: 'Alice Smith', TeamSide: 'away', isHighSchoolTeam: true, AB: 3, H: 3, BB: 0, SO: 0, HBP: 0 }],
      pitching: [],
    },
    plays: [{ text: 'Alice Smith grounds out to second base.', inning: 'Top 1' }],
  };
}

function boxScoreOnlyCapturedGame() {
  return {
    boxScore: {
      batting: [{ Player: 'Alice Smith', TeamSide: 'away', isHighSchoolTeam: true, AB: 1, H: 1, BB: 0, SO: 0, HBP: 0 }],
      pitching: [],
    },
    plays: [],
  };
}

function noDataCapturedGame() {
  return { boxScore: { batting: [], pitching: [] }, plays: [] };
}

// A two-game aggregate where BOTH games have complete box-score coverage
// and no mismatch -- used to prove the publication gate accepts a fully
// box-score-only aggregate (no play-by-play at all), matching this
// domain's own stated philosophy that box score alone is official.
function completeBoxScoreOnlyGames() {
  return [boxScoreOnlyCapturedGame(), boxScoreOnlyCapturedGame()];
}

// One game with a box score, one game WITHOUT -- incomplete coverage.
function incompleteBoxScoreCoverageGames() {
  return [boxScoreOnlyCapturedGame(), noDataCapturedGame()];
}

// ── item 1: import run starts with valid scoped context ──────────────────

test('startImportRun creates a running run when given a fully valid, scoped context', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  assert.equal(run.status, 'running');
  assert.equal(run.org_id, ORG_ID);
});

// ── item 2: missing tenant/program/team context is rejected ─────────────

test('startImportRun rejects a request missing teamId rather than defaulting or guessing it', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.startImportRun({ orgId: ORG_ID, programId: PROGRAM_ID, teamId: undefined, seasonId: SEASON_ID, sourceProvider: 'gamechanger', triggerKind: 'manual' }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); assert.match(err.message, /teamId/); return true; }
  );
});

test('startImportRun rejects an invalid triggerKind rather than silently accepting an unknown value', async () => {
  const { service } = setup();
  await assert.rejects(() => service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'webhook' }), (err) => {
    assert.equal(err.code, 'INVALID_ENUM_VALUE');
    return true;
  });
});

// ── item 12: unsupported snapshot types are rejected ─────────────────────

test('captureSnapshot rejects an unsupported snapshot kind before attempting persistence', async () => {
  const { service, client } = setup();
  await assert.rejects(
    () => service.captureSnapshot({ orgId: ORG_ID, importRunId: RUN_ID, snapshotKind: 'screenshot', sourceProvider: 'gamechanger', payload: {} }),
    (err) => { assert.equal(err.code, 'INVALID_ENUM_VALUE'); return true; }
  );
  assert.equal(client.__touchedTables.has('hs_raw_snapshots'), false, 'nothing should be written when validation fails first');
});

// ── credential rejection wired end-to-end through the service ────────────

test('captureSnapshot rejects a payload containing a nested credential-shaped key before any write occurs', async () => {
  const { service, client } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  await assert.rejects(
    () => service.captureSnapshot({
      orgId: ORG_ID, importRunId: run.id, snapshotKind: 'box_score', sourceProvider: 'gamechanger',
      payload: { batting: [{ player: 'Alice', meta: { cookie: 'sess=abc123' } }] },
    }),
    (err) => { assert.equal(err.code, 'CREDENTIAL_LIKE_KEY_REJECTED'); return true; }
  );
  assert.equal(client.__getRows('hs_raw_snapshots').length, 0);
});

test('captureSnapshot persists a clean payload successfully', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row } = await service.captureSnapshot({
    orgId: ORG_ID, importRunId: run.id, snapshotKind: 'box_score', sourceProvider: 'gamechanger',
    payload: { batting: [{ player: 'Alice', ab: 3, h: 1 }] },
  });
  assert.deepEqual(row.payload.batting[0], { player: 'Alice', ab: 3, h: 1 });
});

// Required before merge #4: config/diagnostics/stats get the SAME
// recursive credential scan as payload, not just a serializability check.

test('startImportRun rejects a credential-shaped key nested inside config, before any write occurs', async () => {
  const { service, client } = setup();
  await assert.rejects(
    () => service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: { options: { apiKey: 'sk_live_xyz' } } }),
    (err) => { assert.equal(err.code, 'CREDENTIAL_LIKE_KEY_REJECTED'); return true; }
  );
  assert.equal(client.__getRows('hs_import_runs').length, 0);
});

test('recordSourceGame rejects a credential-shaped key nested inside diagnostics, before any write occurs', async () => {
  const { service, client } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  await assert.rejects(
    () => service.recordSourceGame({
      orgId: ORG_ID, importRunId: run.id, sourceGameRef: 'gc-diag', discoveryStatus: 'failed',
      diagnostics: { error: { context: { headers: { authorization: 'Bearer xyz' } } } },
    }),
    (err) => { assert.equal(err.code, 'CREDENTIAL_LIKE_KEY_REJECTED'); return true; }
  );
  assert.equal(client.__getRows('hs_import_run_games').length, 0);
});

test('publishPlayerAdvancedStats rejects a credential-shaped key nested inside the stats blob, before any write occurs', async () => {
  const { service, client } = setup();
  await assert.rejects(
    () => service.publishPlayerAdvancedStats({ ...ctx(), hsPlayerId: PLAYER_ID, stats: { games: 1, debug: { session_token: 'abc' } } }),
    (err) => { assert.equal(err.code, 'CREDENTIAL_LIKE_KEY_REJECTED'); return true; }
  );
  assert.equal(client.__getRows('hs_player_advanced_stats').length, 0);
});

// ── recordGameValidation: confidence/status derivation matrix (items 18, 19) ─

test('deriveGameConfidenceAndStatus: no box score at all -> low confidence, pending status', () => {
  const { service } = setup();
  assert.deepEqual(
    service.deriveGameConfidenceAndStatus({ hasBoxScore: false, hasPlayByPlay: false, battingMatchesBox: false }),
    { confidence: 'low', validationStatus: 'pending' }
  );
});

test('deriveGameConfidenceAndStatus: box score only, no play-by-play -> medium confidence, validated status', () => {
  const { service } = setup();
  assert.deepEqual(
    service.deriveGameConfidenceAndStatus({ hasBoxScore: true, hasPlayByPlay: false, battingMatchesBox: false }),
    { confidence: 'medium', validationStatus: 'validated' }
  );
});

test('deriveGameConfidenceAndStatus: box score + matching play-by-play -> high confidence, validated status', () => {
  const { service } = setup();
  assert.deepEqual(
    service.deriveGameConfidenceAndStatus({ hasBoxScore: true, hasPlayByPlay: true, battingMatchesBox: true }),
    { confidence: 'high', validationStatus: 'validated' }
  );
});

// item 19: a PBP mismatch does not become verified merely because PBP exists
test('deriveGameConfidenceAndStatus: box score + MISMATCHED play-by-play is never "validated" merely because play-by-play exists', () => {
  const { service } = setup();
  const result = service.deriveGameConfidenceAndStatus({ hasBoxScore: true, hasPlayByPlay: true, battingMatchesBox: false });
  assert.equal(result.validationStatus, 'mismatched');
  assert.notEqual(result.validationStatus, 'validated');
});

test('recordGameValidation on an agreeing box score + play-by-play produces a high-confidence, validated row', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: game } = await service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-agree' });
  const { row } = await service.recordGameValidation({ orgId: ORG_ID, importRunId: run.id, importRunGameId: null, hsGameId: game.id, teamId: TEAM_ID, capturedGame: agreeingCapturedGame() });
  assert.equal(row.confidence, 'high');
  assert.equal(row.validation_status, 'validated');
  assert.equal(row.batting_matches_box, true);
});

// item 18: official and reconstructed totals remain separate
test('recordGameValidation on a MISMATCHED game keeps box-score and reconstructed totals in distinct columns and reports mismatched, never silently reconciling them', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: game } = await service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-mismatch' });
  const { row } = await service.recordGameValidation({ orgId: ORG_ID, importRunId: run.id, importRunGameId: null, hsGameId: game.id, teamId: TEAM_ID, capturedGame: mismatchedCapturedGame() });

  assert.equal(row.validation_status, 'mismatched');
  assert.equal(row.confidence, 'medium');
  assert.equal(row.batting_matches_box, false);
  assert.equal(row.box_score_batting.h, 3);
  assert.equal(row.reconstructed_batting.h, 0);
  assert.notDeepEqual(row.box_score_batting, row.reconstructed_batting);
});

test('recordGameValidation on a box-score-only game (no play-by-play) is validated at medium confidence', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: game } = await service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-box-only' });
  const { row } = await service.recordGameValidation({ orgId: ORG_ID, importRunId: run.id, importRunGameId: null, hsGameId: game.id, teamId: TEAM_ID, capturedGame: boxScoreOnlyCapturedGame() });
  assert.equal(row.has_play_by_play, false);
  assert.equal(row.confidence, 'medium');
  assert.equal(row.validation_status, 'validated');
});

test('recordGameValidation on a game with no captured data at all is "pending", never falsely "validated"', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: game } = await service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-empty' });
  const { row } = await service.recordGameValidation({ orgId: ORG_ID, importRunId: run.id, importRunGameId: null, hsGameId: game.id, teamId: TEAM_ID, capturedGame: noDataCapturedGame() });
  assert.equal(row.validation_status, 'pending');
  assert.equal(row.confidence, 'low');
});

// ── High School team ownership: natural polarity, never falsified ────────
// (corrects the earlier version's brittle requirement that CALLERS pass
// is_our_team: false to mean "this is the school's own team")

test('invertRowOwnershipForReconstruction requires an explicit isHighSchoolTeam boolean and refuses to guess', () => {
  const { service } = setup();
  assert.throws(() => service.invertRowOwnershipForReconstruction({ Player: 'Alice' }), (err) => { assert.equal(err.code, 'MISSING_TEAM_OWNERSHIP'); return true; });
  assert.throws(() => service.invertRowOwnershipForReconstruction({ Player: 'Alice', isHighSchoolTeam: 'yes' }), (err) => { assert.equal(err.code, 'MISSING_TEAM_OWNERSHIP'); return true; });
});

test('invertRowOwnershipForReconstruction maps isHighSchoolTeam: true to the internal is_our_team: false reconstructGame expects, and discards any caller-supplied travel-ball ownership flag', () => {
  const { service } = setup();
  const mapped = service.invertRowOwnershipForReconstruction({ Player: 'Alice', isHighSchoolTeam: true, is_our_team: true, isOurTeam: true, AB: 3 });
  assert.equal(mapped.is_our_team, false);
  assert.equal(mapped.isHighSchoolTeam, undefined);
  assert.equal(mapped.isOurTeam, undefined);
  assert.equal(mapped.AB, 3);
});

test('invertRowOwnershipForReconstruction maps isHighSchoolTeam: false (the opponent) to is_our_team: true', () => {
  const { service } = setup();
  const mapped = service.invertRowOwnershipForReconstruction({ Player: 'Rival Player', isHighSchoolTeam: false });
  assert.equal(mapped.is_our_team, true);
});

// Asymmetric fixture: the High School team's row and the opponent's row
// have DIFFERENT, distinguishable stat lines. If the ownership mapping
// were accidentally symmetric (e.g. a bug that always inverted both rows
// the same way, or never inverted at all), swapping which row carries
// isHighSchoolTeam: true would silently publish the WRONG team's numbers
// as the school's own -- this proves that swap actually changes the
// persisted result correspondingly, not silently pass either way.
function asymmetricGame({ highSchoolTeamAb, highSchoolTeamH, opponentAb, opponentH }) {
  return {
    boxScore: {
      batting: [
        { Player: 'HS Player', TeamSide: 'away', isHighSchoolTeam: true, AB: highSchoolTeamAb, H: highSchoolTeamH, BB: 0, SO: 0, HBP: 0 },
        { Player: 'Opponent Player', TeamSide: 'home', isHighSchoolTeam: false, AB: opponentAb, H: opponentH, BB: 0, SO: 0, HBP: 0 },
      ],
      pitching: [],
    },
    plays: [],
  };
}

test('recordGameValidation persists the HIGH SCHOOL TEAM\'s own box score numbers, not the opponent\'s, when the two are asymmetric', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: game } = await service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-asym' });
  const capturedGame = asymmetricGame({ highSchoolTeamAb: 4, highSchoolTeamH: 3, opponentAb: 4, opponentH: 0 });
  const { row } = await service.recordGameValidation({ orgId: ORG_ID, importRunId: run.id, importRunGameId: null, hsGameId: game.id, teamId: TEAM_ID, capturedGame });
  assert.equal(row.box_score_batting.ab, 4);
  assert.equal(row.box_score_batting.h, 3, 'must reflect the High School team\'s 3 hits, not the opponent\'s 0');
});

test('swapping which row carries isHighSchoolTeam: true changes the persisted result correspondingly (the mapping is not accidentally symmetric)', async () => {
  const { service: serviceA } = setup();
  const { service: serviceB } = setup();

  const runA = await serviceA.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: gameA } = await serviceA.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-swap-a' });
  const originalGame = asymmetricGame({ highSchoolTeamAb: 4, highSchoolTeamH: 3, opponentAb: 4, opponentH: 1 });
  const { row: rowA } = await serviceA.recordGameValidation({ orgId: ORG_ID, importRunId: runA.id, importRunGameId: null, hsGameId: gameA.id, teamId: TEAM_ID, capturedGame: originalGame });

  const runB = await serviceB.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: gameB } = await serviceB.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-swap-b' });
  const swappedGame = {
    boxScore: {
      batting: originalGame.boxScore.batting.map((row) => ({ ...row, isHighSchoolTeam: !row.isHighSchoolTeam })),
      pitching: [],
    },
    plays: [],
  };
  const { row: rowB } = await serviceB.recordGameValidation({ orgId: ORG_ID, importRunId: runB.id, importRunGameId: null, hsGameId: gameB.id, teamId: TEAM_ID, capturedGame: swappedGame });

  assert.equal(rowA.box_score_batting.h, 3);
  assert.equal(rowB.box_score_batting.h, 1, 'swapping ownership must swap which side\'s numbers get persisted as official');
  assert.notEqual(rowA.box_score_batting.h, rowB.box_score_batting.h);
});

// Same asymmetric-ownership proof as the batting tests above, but for the
// PITCHING box-score bucket -- invertRowOwnershipForReconstruction and
// toReconstructionInput apply the identical row-by-row mapping to
// boxScore.pitching, but nothing above actually exercised that path with
// distinguishable (asymmetric) home/away pitching lines. Without this, a
// bug that inverted batting rows correctly while leaving pitching rows
// un-inverted (or inverted from the wrong flag) would pass every existing
// test in this file.
function asymmetricPitchingGame({ highSchoolTeamEr, highSchoolTeamSo, opponentEr, opponentSo }) {
  return {
    boxScore: {
      batting: [],
      pitching: [
        { Player: 'HS Pitcher', TeamSide: 'away', isHighSchoolTeam: true, BF: 20, ER: highSchoolTeamEr, SO: highSchoolTeamSo, BB: 0, H: 0 },
        { Player: 'Opponent Pitcher', TeamSide: 'home', isHighSchoolTeam: false, BF: 20, ER: opponentEr, SO: opponentSo, BB: 0, H: 0 },
      ],
    },
    plays: [],
  };
}

test('recordGameValidation persists the HIGH SCHOOL TEAM\'s own pitching numbers, not the opponent\'s, when the two are asymmetric', async () => {
  const { service } = setup();
  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: game } = await service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-asym-pitch' });
  const capturedGame = asymmetricPitchingGame({ highSchoolTeamEr: 1, highSchoolTeamSo: 12, opponentEr: 6, opponentSo: 2 });
  const { row } = await service.recordGameValidation({ orgId: ORG_ID, importRunId: run.id, importRunGameId: null, hsGameId: game.id, teamId: TEAM_ID, capturedGame });
  assert.equal(row.box_score_pitching.er, 1, 'must reflect the High School team\'s 1 earned run, not the opponent\'s 6');
  assert.equal(row.box_score_pitching.so, 12, 'must reflect the High School team\'s 12 strikeouts, not the opponent\'s 2');
});

test('swapping which pitching row carries isHighSchoolTeam: true changes the persisted result correspondingly (not accidentally symmetric)', async () => {
  const { service: serviceA } = setup();
  const { service: serviceB } = setup();

  const runA = await serviceA.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: gameA } = await serviceA.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-swap-pitch-a' });
  const originalGame = asymmetricPitchingGame({ highSchoolTeamEr: 1, highSchoolTeamSo: 12, opponentEr: 6, opponentSo: 2 });
  const { row: rowA } = await serviceA.recordGameValidation({ orgId: ORG_ID, importRunId: runA.id, importRunGameId: null, hsGameId: gameA.id, teamId: TEAM_ID, capturedGame: originalGame });

  const runB = await serviceB.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual' });
  const { row: gameB } = await serviceB.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-swap-pitch-b' });
  const swappedGame = {
    boxScore: {
      batting: [],
      pitching: originalGame.boxScore.pitching.map((row) => ({ ...row, isHighSchoolTeam: !row.isHighSchoolTeam })),
    },
    plays: [],
  };
  const { row: rowB } = await serviceB.recordGameValidation({ orgId: ORG_ID, importRunId: runB.id, importRunGameId: null, hsGameId: gameB.id, teamId: TEAM_ID, capturedGame: swappedGame });

  assert.equal(rowA.box_score_pitching.er, 1);
  assert.equal(rowB.box_score_pitching.er, 6, 'swapping ownership must swap which side\'s pitching numbers get persisted as official');
  assert.notEqual(rowA.box_score_pitching.er, rowB.box_score_pitching.er);
});

// ── publishVerifiedTotals ─────────────────────────────────────────────────

test('publishVerifiedTotals rejects an empty games array rather than publishing a meaningless zero-game total', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.publishVerifiedTotals({ ...ctx(), games: [] }),
    (err) => { assert.equal(err.code, 'EMPTY_AGGREGATE'); return true; }
  );
});

test('publishVerifiedTotals requires seasonId (hs_verified_totals.season_id is NOT NULL)', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.publishVerifiedTotals({ orgId: ORG_ID, programId: PROGRAM_ID, teamId: TEAM_ID, seasonId: null, games: [agreeingCapturedGame()] }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
});

test('publishVerifiedTotals computes its aggregate via the real pure reconstructTeamGames function, not a caller-trusted number', async () => {
  const { service, client } = setup();
  const published = await service.publishVerifiedTotals({ ...ctx(), games: [agreeingCapturedGame()] });
  assert.equal(published.games, 1);
  assert.equal(published.is_current, true);
  const rows = client.__getRows('hs_verified_totals');
  assert.equal(rows.length, 1);
});

// ── publication gate: a non-empty games array alone is NOT sufficient ────
//
// Required before merge #1: reject mismatches, missing box-score coverage,
// and unresolved side attribution -- and prove a rejected publish causes
// ZERO database mutation, not a partial write.

test('publishVerifiedTotals REJECTS an aggregate with incomplete box-score coverage, and writes nothing', async () => {
  const { service, client } = setup();
  await assert.rejects(
    () => service.publishVerifiedTotals({ ...ctx(), games: incompleteBoxScoreCoverageGames() }),
    (err) => { assert.equal(err.code, 'INCOMPLETE_BOX_SCORE_COVERAGE'); return true; }
  );
  assert.equal(client.__getRows('hs_verified_totals').length, 0, 'a rejected publish must cause no database mutation at all');
});

test('publishVerifiedTotals REJECTS an aggregate containing even one mismatched game, and writes nothing', async () => {
  const { service, client } = setup();
  await assert.rejects(
    () => service.publishVerifiedTotals({ ...ctx(), games: [agreeingCapturedGame(), mismatchedCapturedGame()] }),
    (err) => { assert.equal(err.code, 'UNRESOLVED_MISMATCH'); return true; }
  );
  assert.equal(client.__getRows('hs_verified_totals').length, 0);
});

test('publishVerifiedTotals REJECTS an aggregate where a game has play-by-play but no resolved scouted side, and writes nothing', async () => {
  const { service, client } = setup();
  const unresolvedSideGame = {
    boxScore: {
      batting: [{ Player: 'Alice Smith', isHighSchoolTeam: true, AB: 1, H: 1, BB: 0, SO: 0, HBP: 0 }], // no TeamSide at all -> side stays unresolved
      pitching: [],
    },
    plays: [{ text: 'Alice Smith singles to left field.', inning: 'Top 1' }],
  };
  await assert.rejects(
    () => service.publishVerifiedTotals({ ...ctx(), games: [unresolvedSideGame] }),
    (err) => { assert.equal(err.code, 'UNRESOLVED_SIDE_ATTRIBUTION'); return true; }
  );
  assert.equal(client.__getRows('hs_verified_totals').length, 0);
});

test('publishVerifiedTotals ACCEPTS a fully box-score-only aggregate (zero play-by-play) -- box score alone is this domain\'s official source of truth', async () => {
  const { service, client } = setup();
  const published = await service.publishVerifiedTotals({ ...ctx(), games: completeBoxScoreOnlyGames() });
  assert.equal(published.is_current, true);
  assert.equal(published.play_by_play_games, 0);
  assert.equal(client.__getRows('hs_verified_totals').length, 1);
});

test('publishVerifiedTotals ACCEPTS a complete, fully-matched aggregate with play-by-play', async () => {
  const { service, client } = setup();
  const published = await service.publishVerifiedTotals({ ...ctx(), games: [agreeingCapturedGame(), agreeingCapturedGame()] });
  assert.equal(published.is_current, true);
  assert.equal(published.mismatch_games, 0);
  assert.equal(client.__getRows('hs_verified_totals').length, 1);
});

// ── item 21: unresolved players cannot receive advanced-stat rows ────────

test('publishPlayerAdvancedStats rejects a null/missing hsPlayerId rather than falling back to name matching', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.publishPlayerAdvancedStats({ ...ctx(), hsPlayerId: null, stats: { games: 1 } }),
    (err) => { assert.equal(err.code, 'UNRESOLVED_PLAYER'); return true; }
  );
});

test('publishPitcherAdvancedStats rejects a null/missing hsPlayerId rather than falling back to name matching', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.publishPitcherAdvancedStats({ ...ctx(), hsPlayerId: undefined, stats: { games: 1 } }),
    (err) => { assert.equal(err.code, 'UNRESOLVED_PLAYER'); return true; }
  );
});

// item 22: pre-resolved player IDs are persisted with full hierarchy context
test('publishPlayerAdvancedStats persists a pre-resolved hsPlayerId with full hierarchy context', async () => {
  const { service } = setup();
  const row = await service.publishPlayerAdvancedStats({ ...ctx(), importRunId: RUN_ID, hsPlayerId: PLAYER_ID, stats: { games: 4, gb: 2, fb: 1 } });
  assert.equal(row.player_id, PLAYER_ID);
  assert.equal(row.org_id, ORG_ID);
  assert.equal(row.team_id, TEAM_ID);
  assert.equal(row.season_id, SEASON_ID);
  assert.equal(row.games, 4);
});

// ── item 6: UUID-backed identifiers are validated consistently everywhere ─
//
// Every uuid-typed identifier the service accepts is now checked with
// requireUuid/optionalUuid, not requireNonEmptyString -- proving a
// malformed identifier is rejected by THIS service, before ever reaching
// the repository or a real database.

test('recordDiscoveredCount rejects a malformed importRunId', async () => {
  const { service } = setup();
  await assert.rejects(() => service.recordDiscoveredCount({ orgId: ORG_ID, importRunId: 'not-a-uuid', count: 3 }), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
});

test('completeImportRun rejects a malformed orgId', async () => {
  const { service } = setup();
  await assert.rejects(() => service.completeImportRun({ orgId: 'not-a-uuid', importRunId: RUN_ID }), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
});

test('failImportRun rejects a malformed importRunId', async () => {
  const { service } = setup();
  await assert.rejects(() => service.failImportRun({ orgId: ORG_ID, importRunId: 'not-a-uuid', rawErrorMessage: 'x' }), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
});

test('recordSourceGame rejects a malformed orgId/importRunId but still allows sourceGameRef to be a non-uuid external id', async () => {
  const { service } = setup();
  await assert.rejects(() => service.recordSourceGame({ orgId: 'not-a-uuid', importRunId: RUN_ID, sourceGameRef: 'gc-123', discoveryStatus: 'discovered' }), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
});

test('updateSourceGameOutcome rejects a malformed runGameId', async () => {
  const { service } = setup();
  await assert.rejects(() => service.updateSourceGameOutcome({ orgId: ORG_ID, runGameId: 'not-a-uuid', discoveryStatus: 'processed' }), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
});

test('captureSnapshot rejects a malformed optional importRunGameId/hsGameId, not just the required orgId/importRunId', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.captureSnapshot({ orgId: ORG_ID, importRunId: RUN_ID, importRunGameId: 'not-a-uuid', snapshotKind: 'box_score', sourceProvider: 'gamechanger', payload: {} }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
  await assert.rejects(
    () => service.captureSnapshot({ orgId: ORG_ID, importRunId: RUN_ID, hsGameId: 'not-a-uuid', snapshotKind: 'box_score', sourceProvider: 'gamechanger', payload: {} }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
});

test('recordGameValidation rejects a malformed hsGameId/teamId/importRunGameId', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.recordGameValidation({ orgId: ORG_ID, importRunId: RUN_ID, hsGameId: 'not-a-uuid', teamId: TEAM_ID, capturedGame: agreeingCapturedGame() }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
  await assert.rejects(
    () => service.recordGameValidation({ orgId: ORG_ID, importRunId: RUN_ID, hsGameId: PLAYER_ID, teamId: 'not-a-uuid', capturedGame: agreeingCapturedGame() }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
});

test('publishPlayerAdvancedStats/publishPitcherAdvancedStats reject a malformed (but non-null) hsPlayerId, not just a missing one', async () => {
  const { service } = setup();
  await assert.rejects(() => service.publishPlayerAdvancedStats({ ...ctx(), hsPlayerId: 'not-a-uuid', stats: {} }), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
  await assert.rejects(() => service.publishPitcherAdvancedStats({ ...ctx(), hsPlayerId: 'not-a-uuid', stats: {} }), (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; });
});

// ── error propagation (item 23) ───────────────────────────────────────────

test('a repository failure during resolveCanonicalGame propagates out of the service rather than being swallowed', async () => {
  const { service, client } = setup();
  const originalFrom = client.from.bind(client);
  client.from = (table) => {
    if (table === 'hs_games') {
      return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'simulated failure' } }) }) }) }) }) };
    }
    return originalFrom(table);
  };
  await assert.rejects(
    () => service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-fail' }),
    (err) => { assert.equal(err.code, 'PERSISTENCE_FAILED'); return true; }
  );
});

// ── full happy-path lifecycle wiring ──────────────────────────────────────

test('a full happy-path lifecycle (start -> record game -> resolve -> snapshot -> validate -> publish totals -> publish stats -> complete) wires correctly end to end', async () => {
  const { service, client } = setup();

  const run = await service.startImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  const { row: runGame } = await service.recordSourceGame({ orgId: ORG_ID, importRunId: run.id, sourceGameRef: 'gc-lifecycle', discoveryStatus: 'discovered' });
  const { row: game } = await service.resolveCanonicalGame({ ...ctx(), sourceProvider: 'gamechanger', sourceGameRef: 'gc-lifecycle', opponentName: 'Rival High', gameDate: '2026-04-15' });
  await service.updateSourceGameOutcome({ orgId: ORG_ID, runGameId: runGame.id, discoveryStatus: 'processed', gameOutcome: 'inserted', hsGameId: game.id });
  await service.captureSnapshot({ orgId: ORG_ID, importRunId: run.id, importRunGameId: runGame.id, hsGameId: game.id, snapshotKind: 'box_score', sourceProvider: 'gamechanger', payload: { raw: true } });
  const { row: validation } = await service.recordGameValidation({ orgId: ORG_ID, importRunId: run.id, importRunGameId: runGame.id, hsGameId: game.id, teamId: TEAM_ID, capturedGame: agreeingCapturedGame() });
  const totals = await service.publishVerifiedTotals({ ...ctx(), importRunId: run.id, games: [agreeingCapturedGame()] });
  const playerStats = await service.publishPlayerAdvancedStats({ ...ctx(), importRunId: run.id, hsPlayerId: PLAYER_ID, stats: { games: 1 } });
  const completed = await service.completeImportRun({ orgId: ORG_ID, importRunId: run.id });

  assert.equal(validation.validation_status, 'validated');
  assert.equal(totals.is_current, true);
  assert.equal(playerStats.is_current, true);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.games_succeeded, 1);
  assert.equal(client.__getRows('hs_games').length, 1);
});

// ── constructor guard ─────────────────────────────────────────────────────

test('createHighSchoolImportService refuses to build without an injected repository', () => {
  assert.throws(() => createHighSchoolImportService({}), (err) => { assert.equal(err.code, 'INVALID_SERVICE_DEPENDENCY'); return true; });
});

// ── items 26, 27: structural guarantees (no client construction, no filesystem access) ─

const SERVICE_SOURCE_FILES = [
  '../src/high-school-import-service.js',
  '../src/high-school-import-repository.js',
  '../src/high-school-import-sanitizer.js',
];

// Strips `//`-prefixed comment lines before scanning -- this module's own
// header comments illustrate the intended PRODUCTION wiring
// (`require('./supabase')`) in prose, which would otherwise false-positive
// against a check meaningful only against actual executable code. Mirrors
// the same statementsOnlyLower convention already used in this repo's
// migration-contract tests.
function codeOnly(source) {
  return source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}

test('no Slice 1A source file constructs a Supabase client or reads process.env directly', () => {
  for (const relativePath of SERVICE_SOURCE_FILES) {
    const code = codeOnly(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));
    assert.doesNotMatch(code, /createClient\s*\(/, `${relativePath} must not call createClient()`);
    assert.doesNotMatch(code, /require\(['"]\.\/supabase['"]\)/, `${relativePath} must not require ./supabase`);
    assert.doesNotMatch(code, /process\.env\.SUPABASE/, `${relativePath} must not read a Supabase env var directly`);
  }
});

test('no Slice 1A source file performs local filesystem access in the in-memory import path', () => {
  for (const relativePath of SERVICE_SOURCE_FILES) {
    const code = codeOnly(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));
    assert.doesNotMatch(code, /require\(['"]fs['"]\)/, `${relativePath} must not require fs`);
    assert.doesNotMatch(code, /require\(['"]node:fs['"]\)/, `${relativePath} must not require node:fs`);
    assert.doesNotMatch(code, /readFileSync|writeFileSync|createReadStream|createWriteStream/, `${relativePath} must not touch the filesystem`);
  }
});

test('no Slice 1A source file launches a browser or references GameChanger network access', () => {
  for (const relativePath of SERVICE_SOURCE_FILES) {
    const code = codeOnly(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));
    assert.doesNotMatch(code, /playwright|puppeteer|chromium/i, `${relativePath} must not reference a browser automation library`);
    assert.doesNotMatch(code, /gamechanger\.com/i, `${relativePath} must not reference a GameChanger URL`);
  }
});

// ── New read-side wrappers (listImportRuns, getImportRunDetail,
// getCapturedGamesForRun, getPublishedStats) ────────────────────────────
// These are thin validating wrappers around the repository's own new read
// functions (see test/high-school-import-repository-read-functions.test.js
// for direct repository-level coverage) -- this block proves the SERVICE
// layer's own job: rejecting malformed/missing identifiers with a typed,
// safe error BEFORE ever reaching the repository/database, exactly the
// same requireUuid discipline every other service function in this file
// already has covered.

test('listImportRuns rejects a non-UUID orgId before ever touching the repository', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.listImportRuns({ orgId: 'not-a-uuid', teamId: TEAM_ID, seasonId: SEASON_ID }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
});

test('listImportRuns returns an empty array (not an error) when no runs exist yet for this team/season', async () => {
  const { service } = setup();
  const runs = await service.listImportRuns({ orgId: ORG_ID, teamId: TEAM_ID, seasonId: SEASON_ID });
  assert.deepEqual(runs, []);
});

test('getImportRunDetail rejects a non-UUID importRunId before ever touching the repository', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.getImportRunDetail({ orgId: ORG_ID, importRunId: 'not-a-uuid' }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
});

test('getImportRunDetail returns the run alongside its games and validations for a real run', async () => {
  const { service, repository } = setup();
  const run = await repository.createImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repository.recordRunGame({ orgId: ORG_ID, importRunId: run.id, sourceGameRef: 'gc-1', discoveryStatus: 'processed', gameOutcome: 'inserted' });
  const detail = await service.getImportRunDetail({ orgId: ORG_ID, importRunId: run.id });
  assert.equal(detail.run.id, run.id);
  assert.equal(detail.games.length, 1);
  assert.deepEqual(detail.validations, []);
});

test('getCapturedGamesForRun rejects a non-UUID importRunId before ever touching the repository', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.getCapturedGamesForRun({ orgId: ORG_ID, importRunId: 'not-a-uuid' }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
});

test('getPublishedStats rejects a non-UUID seasonId before ever touching the repository', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.getPublishedStats({ orgId: ORG_ID, teamId: TEAM_ID, seasonId: 'not-a-uuid' }),
    (err) => { assert.equal(err.code, 'INVALID_FIELD'); return true; }
  );
});

test('getPublishedStats returns null verifiedTotals and empty stat arrays when nothing has been published yet, not an error', async () => {
  const { service } = setup();
  const stats = await service.getPublishedStats({ orgId: ORG_ID, teamId: TEAM_ID, seasonId: SEASON_ID });
  assert.equal(stats.verifiedTotals, null);
  assert.deepEqual(stats.playerAdvancedStats, []);
  assert.deepEqual(stats.pitcherAdvancedStats, []);
});

test('getPublishedStats never returns a foreign organization\'s published totals for the same team/season ids', async () => {
  const { service, repository } = setup();
  const run = await repository.createImportRun({ ...ctx(), sourceProvider: 'gamechanger', triggerKind: 'manual', config: {} });
  await repository.publishVerifiedTotals({
    ...ctx(), importRunId: run.id,
    aggregate: { games: 1, boxScoreGames: 1, playByPlayGames: 0, validatedGames: 0, mismatchGames: 0, confidence: 'low' },
  });
  const FOREIGN_ORG = '99999999-9999-9999-9999-999999999999';
  const stats = await service.getPublishedStats({ orgId: FOREIGN_ORG, teamId: TEAM_ID, seasonId: SEASON_ID });
  assert.equal(stats.verifiedTotals, null);
});
