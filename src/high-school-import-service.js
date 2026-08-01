'use strict';

// Orchestration layer for the High School import persistence core
// (Slice 1A). This is the boundary described in the slice's own diagram:
// it begins with an already-captured, in-memory payload and a resolved
// tenant/program/team/(season) context, and ends with rows recorded in the
// Slice 0B schema. It does NOT scrape GameChanger, does not launch a
// browser, does not read a file, and does not decide how a browser
// extraction works -- see high-school-importer-contract.js's own header
// for where that future work is documented (roster side) and this
// module's PR description for the game/stat side.
//
// ── Dependency injection ─────────────────────────────────────────────────
// createHighSchoolImportService({ repository }) takes an ALREADY-BUILT
// repository (see high-school-import-repository.js's
// createHighSchoolImportRepository(adminClient)) -- this module never
// constructs a Supabase client, reads process.env, or imports
// src/supabase.js. Production wiring is exactly:
//
//   const { adminClient } = require('./supabase');
//   const repository = createHighSchoolImportRepository(adminClient);
//   const importService = createHighSchoolImportService({ repository });
//
// -- explicitly at the call site, so it is obvious and auditable which
// client (service-role) backs a write path, rather than implicit inside
// this module. Nothing here would stop a caller from passing a
// browser/anon-scoped client instead, but every table this module writes
// to has RLS enabled with SELECT-only policies (Slice 0B), so such a
// client could not actually write anything -- the intended, and only
// currently wired, production write path is the service-role adminClient.
//
// ── Reuses pure reconstruction logic, doesn't reimplement it ────────────
// reconstructGame/reconstructTeamGames (src/game-reconstructor.js) are
// used UNMODIFIED. This module's only job on top of them is mapping their
// output shape onto hs_game_validation_results/hs_verified_totals columns
// and enforcing this schema's specific rules (side values constrained to
// home/away, confidence/validation_status vocabularies) that the pure
// reconstruction functions have no reason to know about.

const { createHighSchoolImportRepository } = require('./high-school-import-repository');
const { reconstructGame, reconstructTeamGames } = require('./game-reconstructor');
const {
  importError,
  requireEnum,
  optionalEnum,
  requireUuid,
  optionalUuid,
  requireNonEmptyString,
  requireNonNegativeInteger,
  validateImportContext,
  sanitizeJsonPayload,
  IMPORT_RUN_STATUSES,
  TRIGGER_KINDS,
  SOURCE_PROVIDERS,
  FAILURE_STAGES,
  DISCOVERY_STATUSES,
  GAME_OUTCOMES,
  SNAPSHOT_KINDS,
  CONTENT_TYPES,
  SIDES,
} = require('./high-school-import-sanitizer');

function createHighSchoolImportService({ repository }) {
  if (!repository) {
    throw importError('INVALID_SERVICE_DEPENDENCY', 'createHighSchoolImportService requires an injected repository', { statusCode: 500 });
  }

  // ── Import-run lifecycle ────────────────────────────────────────────

  async function startImportRun({ orgId, programId, teamId, seasonId, sourceProvider, sourceTeamRef, triggerKind, config }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId });
    requireEnum(sourceProvider, SOURCE_PROVIDERS, 'sourceProvider');
    requireEnum(triggerKind, TRIGGER_KINDS, 'triggerKind');
    const sanitizedConfig = config !== undefined ? sanitizeJsonPayload(config, 'config') : {};
    return repository.createImportRun({
      ...ctx,
      sourceProvider,
      sourceTeamRef: sourceTeamRef ?? null,
      triggerKind,
      config: sanitizedConfig,
    });
  }

  async function recordDiscoveredCount({ orgId, importRunId, count }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    requireNonNegativeInteger(count, 'count');
    return repository.recordDiscoveredCount({ orgId, importRunId, count });
  }

  // ── Read-side: import status/review, used by the GameChanger-ingestion
  // HTTP routes so those routes never query hs_import_runs/
  // hs_import_run_games/hs_game_validation_results/hs_verified_totals/
  // hs_player_advanced_stats/hs_pitcher_advanced_stats directly -- every
  // reference to those tables stays inside this service+repository pair. ──

  async function listImportRuns({ orgId, teamId, seasonId }) {
    requireUuid(orgId, 'orgId');
    requireUuid(teamId, 'teamId');
    requireUuid(seasonId, 'seasonId');
    return repository.listImportRuns({ orgId, teamId, seasonId });
  }

  async function getImportRunDetail({ orgId, importRunId }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    const [run, games, validations] = await Promise.all([
      repository.getImportRun({ orgId, importRunId }),
      repository.listRunGames({ orgId, importRunId }),
      repository.listGameValidationResults({ orgId, importRunId }),
    ]);
    return { run, games, validations };
  }

  async function getCapturedGamesForRun({ orgId, importRunId }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    return repository.getCapturedGamesForRun({ orgId, importRunId });
  }

  async function getPublishedStats({ orgId, teamId, seasonId }) {
    requireUuid(orgId, 'orgId');
    requireUuid(teamId, 'teamId');
    requireUuid(seasonId, 'seasonId');
    const [verifiedTotals, playerAdvancedStats, pitcherAdvancedStats] = await Promise.all([
      repository.getCurrentVerifiedTotals({ orgId, teamId, seasonId }),
      repository.listCurrentPlayerAdvancedStats({ orgId, teamId, seasonId }),
      repository.listCurrentPitcherAdvancedStats({ orgId, teamId, seasonId }),
    ]);
    return { verifiedTotals, playerAdvancedStats, pitcherAdvancedStats };
  }

  async function completeImportRun({ orgId, importRunId }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    return repository.completeImportRun({ orgId, importRunId });
  }

  async function failImportRun({ orgId, importRunId, failureStage, rawErrorMessage }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    optionalEnum(failureStage, FAILURE_STAGES, 'failureStage');
    return repository.failImportRun({ orgId, importRunId, failureStage: failureStage ?? null, rawErrorMessage });
  }

  // ── Source-game tracking ────────────────────────────────────────────

  async function recordSourceGame({ orgId, importRunId, sourceGameRef, sourceGameUrl, discoveryStatus, gameOutcome, diagnostics, hsGameId }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    requireNonEmptyString(sourceGameRef, 'sourceGameRef'); // external provider id, not a uuid column
    requireEnum(discoveryStatus, DISCOVERY_STATUSES, 'discoveryStatus');
    optionalEnum(gameOutcome, GAME_OUTCOMES, 'gameOutcome');
    const sanitizedDiagnostics = diagnostics !== undefined ? sanitizeJsonPayload(diagnostics, 'diagnostics') : {};
    const resolvedHsGameId = optionalUuid(hsGameId, 'hsGameId');
    return repository.recordRunGame({
      orgId, importRunId, sourceGameRef, sourceGameUrl: sourceGameUrl ?? null,
      discoveryStatus, gameOutcome: gameOutcome ?? null, diagnostics: sanitizedDiagnostics, hsGameId: resolvedHsGameId,
    });
  }

  async function updateSourceGameOutcome({ orgId, runGameId, discoveryStatus, gameOutcome, diagnostics, hsGameId }) {
    requireUuid(orgId, 'orgId');
    requireUuid(runGameId, 'runGameId');
    if (discoveryStatus !== undefined) requireEnum(discoveryStatus, DISCOVERY_STATUSES, 'discoveryStatus');
    if (gameOutcome !== undefined) optionalEnum(gameOutcome, GAME_OUTCOMES, 'gameOutcome');
    const sanitizedDiagnostics = diagnostics !== undefined ? sanitizeJsonPayload(diagnostics, 'diagnostics') : undefined;
    const resolvedHsGameId = hsGameId !== undefined ? optionalUuid(hsGameId, 'hsGameId') : undefined;
    return repository.updateRunGameOutcome({ orgId, runGameId, discoveryStatus, gameOutcome, diagnostics: sanitizedDiagnostics, hsGameId: resolvedHsGameId });
  }

  // ── Raw snapshots ────────────────────────────────────────────────────

  async function captureSnapshot({ orgId, importRunId, importRunGameId, hsGameId, snapshotKind, sourceProvider, sourceRef, payload, contentType, schemaVersion, integrityHash, capturedAt }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    const resolvedImportRunGameId = optionalUuid(importRunGameId, 'importRunGameId');
    const resolvedHsGameId = optionalUuid(hsGameId, 'hsGameId');
    requireEnum(snapshotKind, SNAPSHOT_KINDS, 'snapshotKind');
    requireEnum(sourceProvider, SOURCE_PROVIDERS, 'sourceProvider');
    const resolvedContentType = contentType ?? 'json';
    requireEnum(resolvedContentType, CONTENT_TYPES, 'contentType');
    const sanitizedPayload = sanitizeJsonPayload(payload, 'payload');
    return repository.captureRawSnapshot({
      orgId, importRunId, importRunGameId: resolvedImportRunGameId, hsGameId: resolvedHsGameId,
      snapshotKind, sourceProvider, sourceRef: sourceRef ?? null, payload: sanitizedPayload, contentType: resolvedContentType,
      schemaVersion: schemaVersion || 'v1', integrityHash: integrityHash ?? null, capturedAt,
    });
  }

  // ── Canonical game resolution ───────────────────────────────────────

  async function resolveCanonicalGame({ orgId, programId, teamId, seasonId, sourceProvider, sourceGameRef, opponentName, gameDate }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId });
    if (sourceProvider !== undefined && sourceProvider !== null) requireEnum(sourceProvider, SOURCE_PROVIDERS, 'sourceProvider');
    requireNonEmptyString(sourceGameRef, 'sourceGameRef'); // external provider id, not a uuid column
    return repository.resolveOrCreateGame({
      ...ctx, sourceProvider: sourceProvider ?? null, sourceGameRef,
      opponentName: opponentName ?? null, gameDate: gameDate ?? null,
    });
  }

  // ── Reconstruction + validation persistence ─────────────────────────
  //
  // capturedGame must be shaped for game-reconstructor.js's reconstructGame
  // (boxScore.batting/pitching rows, plays[]) -- this function does not
  // reinterpret or reshape raw scraped HTML itself, it only maps the pure
  // reconstruction OUTPUT onto this schema's columns.
  //
  // ── High School team ownership: adapted, never falsified by the caller ──
  // reconstructGame buckets each box-score row via isScoutedRow(row), which
  // is true when row.is_our_team === false -- the OPPOSITE of what the name
  // suggests, because that travel-ball function's "scouted" bucket means
  // "the opponent being scouted," not "our own team." Requiring every
  // caller of THIS module to know and correctly invert that convention
  // (pass is_our_team: false to mean "this IS the High School team") is
  // exactly the kind of brittle, easy-to-get-backwards contract that can
  // silently publish an opponent's totals as the school's own. This module
  // therefore exposes its OWN, non-inverted public field --
  // `isHighSchoolTeam: true` on a row means precisely what it says, "this
  // row belongs to the High School team this import is for" -- and
  // toReconstructionInput() below is the ONE place, tested in isolation,
  // that performs the inversion before handing data to reconstructGame.
  // Every batting/pitching row MUST carry an explicit isHighSchoolTeam
  // boolean; a row with neither is_our_team nor isHighSchoolTeam set is
  // rejected rather than silently defaulted to either side.
  function invertRowOwnershipForReconstruction(row) {
    if (!row || typeof row !== 'object') return row;
    if (!Object.prototype.hasOwnProperty.call(row, 'isHighSchoolTeam')) {
      throw importError('MISSING_TEAM_OWNERSHIP', 'Every boxScore batting/pitching row must carry an explicit isHighSchoolTeam boolean; ownership is never guessed or defaulted', { statusCode: 400 });
    }
    const { isHighSchoolTeam, is_our_team, isOurTeam, ...rest } = row;
    if (typeof isHighSchoolTeam !== 'boolean') {
      throw importError('MISSING_TEAM_OWNERSHIP', 'isHighSchoolTeam must be a boolean (true for the High School team\'s own row, false for the opponent\'s)', { statusCode: 400 });
    }
    void is_our_team;
    void isOurTeam; // any caller-supplied travel-ball-shaped ownership flag is discarded, never trusted alongside isHighSchoolTeam
    return { ...rest, is_our_team: !isHighSchoolTeam };
  }

  function toReconstructionInput(capturedGame) {
    return {
      ...capturedGame,
      boxScore: {
        batting: (capturedGame?.boxScore?.batting || []).map(invertRowOwnershipForReconstruction),
        pitching: (capturedGame?.boxScore?.pitching || []).map(invertRowOwnershipForReconstruction),
      },
    };
  }

  // scoutedSide/opponentSide are constrained by the schema to exactly
  // 'home'/'away'; reconstructGame's own side detection can legitimately
  // produce null (ambiguous/unknown side) but never anything else, so no
  // silent-drop mapping is needed here beyond passing through valid values
  // and rejecting the (should-be-impossible) case of anything else.
  //
  // confidence/validation_status are this module's own derivation --
  // reconstructGame has no per-game confidence concept (only
  // summarizeTeamValidation computes an aggregate, run-level confidence
  // from validation/coverage RATES that only exist once many games are
  // known) so a distinct, explicit per-game rule is defined here:
  //   - no box score at all            -> confidence 'low',  status 'pending'
  //   - box score, no play-by-play     -> confidence 'medium', status 'validated'
  //   - box score + play-by-play,
  //     reconstruction matches box     -> confidence 'high',  status 'validated'
  //   - box score + play-by-play,
  //     reconstruction MISMATCHES box  -> confidence 'medium', status 'mismatched'
  // A mismatch is never silently reported as 'validated' merely because
  // play-by-play existed -- see the last case above.
  function deriveGameConfidenceAndStatus({ hasBoxScore, hasPlayByPlay, battingMatchesBox }) {
    if (!hasBoxScore) return { confidence: 'low', validationStatus: 'pending' };
    if (!hasPlayByPlay) return { confidence: 'medium', validationStatus: 'validated' };
    if (battingMatchesBox) return { confidence: 'high', validationStatus: 'validated' };
    return { confidence: 'medium', validationStatus: 'mismatched' };
  }

  function sideOrNull(value) {
    return SIDES.includes(value) ? value : null;
  }

  async function recordGameValidation({ orgId, importRunId, importRunGameId, hsGameId, teamId, capturedGame }) {
    requireUuid(orgId, 'orgId');
    requireUuid(importRunId, 'importRunId');
    requireUuid(hsGameId, 'hsGameId');
    requireUuid(teamId, 'teamId');
    const resolvedImportRunGameId = optionalUuid(importRunGameId, 'importRunGameId');
    if (!capturedGame || typeof capturedGame !== 'object') {
      throw importError('INVALID_FIELD', 'capturedGame is required and must be an object', { statusCode: 400, context: { field: 'capturedGame' } });
    }

    const result = reconstructGame(toReconstructionInput(capturedGame));
    const { confidence, validationStatus } = deriveGameConfidenceAndStatus({
      hasBoxScore: result.hasBoxScore,
      hasPlayByPlay: result.hasPlayByPlay,
      battingMatchesBox: result.scouted.validation.battingMatchesBox,
    });

    return repository.insertGameValidationResult({
      orgId, importRunId, importRunGameId: resolvedImportRunGameId, hsGameId, teamId,
      hasBoxScore: result.hasBoxScore,
      hasPlayByPlay: result.hasPlayByPlay,
      scoutedSide: sideOrNull(result.scoutedSide),
      opponentSide: sideOrNull(result.opponentSide),
      boxScoreBatting: result.scouted.boxBatting,
      boxScorePitching: result.scouted.boxPitching,
      reconstructedBatting: result.scouted.reconstructedBatting,
      reconstructedPitching: result.scouted.reconstructedPitchingDefense,
      deltas: result.scouted.validation.battingDelta,
      battingMatchesBox: result.scouted.validation.battingMatchesBox,
      quality: {
        parsedPlateAppearances: result.parsedPlateAppearances,
        skippedPlays: result.skippedPlays,
        duplicateSkips: result.duplicateSkips,
        unmatchedBatters: result.unmatchedBatters,
        unmatchedPitchers: result.unmatchedPitchers,
      },
      warnings: result.warnings,
      confidence,
      validationStatus,
    });
  }

  // ── Verified totals ──────────────────────────────────────────────────
  //
  // `games` must be the actual in-memory captured-game objects, not a
  // caller-precomputed summary -- the aggregate published here is always
  // the direct output of reconstructTeamGames (pure, unmodified), never an
  // arbitrary caller-supplied number.
  //
  // ── Publication gate ─────────────────────────────────────────────────
  // A non-empty games array alone is NOT sufficient to become the current
  // row -- this domain's own stated philosophy (see game-reconstructor.js's
  // header: "Box score totals are the official source... Play-by-play is
  // used for advanced tendencies only when it can be side-attributed and
  // measured against the box score") is applied here as three explicit,
  // independently-checked requirements, none of which trust the caller's
  // own math:
  //   1. COMPLETE box-score coverage -- every game must have a box score.
  //      Box score is this domain's required, official data; a total
  //      published from partial coverage would silently understate a
  //      real season. (Play-by-play coverage is deliberately NOT required
  //      here -- a fully box-score-only aggregate is legitimately
  //      publishable per this domain's own stated philosophy; PBP is
  //      supplementary validation, not a prerequisite.)
  //   2. ZERO mismatched games -- any game whose play-by-play reconstruction
  //      contradicts its own box score blocks the whole publish. A
  //      "verified" total can never include even one game with an
  //      admitted, unresolved contradiction.
  //   3. RESOLVED side attribution wherever play-by-play exists -- a game
  //      with play-by-play but no confidently-resolved scoutedSide means
  //      reconstruction could not tell which side's events were even
  //      being counted; that game's numbers cannot be trusted enough to
  //      fold into a published total.
  // Any violation throws BEFORE repository.publishVerifiedTotals is ever
  // called -- see this module's own tests for proof that a rejected
  // publish causes zero database mutation.
  function assertVerifiedTotalsPublishable(summary, gameResults) {
    if (summary.boxScoreGames !== summary.games) {
      throw importError('INCOMPLETE_BOX_SCORE_COVERAGE', `Cannot publish verified totals: ${summary.games - summary.boxScoreGames} of ${summary.games} game(s) are missing a box score`, { statusCode: 409 });
    }
    if (summary.mismatchGames > 0) {
      throw importError('UNRESOLVED_MISMATCH', `Cannot publish verified totals: ${summary.mismatchGames} game(s) have an unresolved play-by-play/box-score mismatch`, { statusCode: 409 });
    }
    const unresolvedSideGames = (gameResults || []).filter((r) => r.hasPlayByPlay && !sideOrNull(r.scoutedSide));
    if (unresolvedSideGames.length > 0) {
      throw importError('UNRESOLVED_SIDE_ATTRIBUTION', `Cannot publish verified totals: ${unresolvedSideGames.length} game(s) have play-by-play but no resolved scouted side`, { statusCode: 409 });
    }
  }

  async function publishVerifiedTotals({ orgId, programId, teamId, seasonId, importRunId, games }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId: seasonId ?? undefined });
    if (!ctx.seasonId) {
      throw importError('INVALID_FIELD', 'seasonId is required to publish verified totals (hs_verified_totals.season_id is NOT NULL)', { statusCode: 400, context: { field: 'seasonId' } });
    }
    if (!Array.isArray(games) || games.length === 0) {
      throw importError('EMPTY_AGGREGATE', 'publishVerifiedTotals requires at least one captured game', { statusCode: 400 });
    }
    const { summary, gameResults } = reconstructTeamGames(teamId, games.map(toReconstructionInput));
    assertVerifiedTotalsPublishable(summary, gameResults);
    return repository.publishVerifiedTotals({ ...ctx, importRunId: importRunId ?? null, aggregate: summary });
  }

  // ── Player / pitcher advanced stats ─────────────────────────────────
  //
  // hsPlayerId must already be a resolved canonical hs_players id. Slice
  // 1A does not implement player resolution (fuzzy/name-based matching is
  // explicitly out of scope) -- an unresolved player is rejected outright,
  // never silently matched by name.

  async function publishPlayerAdvancedStats({ orgId, programId, teamId, seasonId, importRunId, hsPlayerId, stats }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId });
    if (!ctx.seasonId) {
      throw importError('INVALID_FIELD', 'seasonId is required to publish player advanced stats', { statusCode: 400, context: { field: 'seasonId' } });
    }
    if (!hsPlayerId) {
      throw importError('UNRESOLVED_PLAYER', 'publishPlayerAdvancedStats requires an already-resolved hsPlayerId; unresolved players are rejected, not name-matched', { statusCode: 400 });
    }
    requireUuid(hsPlayerId, 'hsPlayerId');
    const resolvedImportRunId = optionalUuid(importRunId, 'importRunId');
    const sanitizedStats = sanitizeJsonPayload(stats ?? {}, 'stats');
    return repository.publishPlayerAdvancedStats({ ...ctx, importRunId: resolvedImportRunId, playerId: hsPlayerId, stats: sanitizedStats });
  }

  async function publishPitcherAdvancedStats({ orgId, programId, teamId, seasonId, importRunId, hsPlayerId, stats }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId });
    if (!ctx.seasonId) {
      throw importError('INVALID_FIELD', 'seasonId is required to publish pitcher advanced stats', { statusCode: 400, context: { field: 'seasonId' } });
    }
    if (!hsPlayerId) {
      throw importError('UNRESOLVED_PLAYER', 'publishPitcherAdvancedStats requires an already-resolved hsPlayerId; unresolved players are rejected, not name-matched', { statusCode: 400 });
    }
    requireUuid(hsPlayerId, 'hsPlayerId');
    const resolvedImportRunId = optionalUuid(importRunId, 'importRunId');
    const sanitizedStats = sanitizeJsonPayload(stats ?? {}, 'stats');
    return repository.publishPitcherAdvancedStats({ ...ctx, importRunId: resolvedImportRunId, playerId: hsPlayerId, stats: sanitizedStats });
  }

  return {
    startImportRun,
    recordDiscoveredCount,
    completeImportRun,
    failImportRun,
    recordSourceGame,
    updateSourceGameOutcome,
    captureSnapshot,
    resolveCanonicalGame,
    recordGameValidation,
    publishVerifiedTotals,
    publishPlayerAdvancedStats,
    publishPitcherAdvancedStats,
    deriveGameConfidenceAndStatus,
    invertRowOwnershipForReconstruction,
    toReconstructionInput,
    assertVerifiedTotalsPublishable,
    listImportRuns,
    getImportRunDetail,
    getCapturedGamesForRun,
    getPublishedStats,
  };
}

module.exports = {
  createHighSchoolImportService,
  createHighSchoolImportRepository,
  IMPORT_RUN_STATUSES,
};
