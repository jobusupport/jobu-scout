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
  requireNonEmptyString,
  requireNonNegativeInteger,
  validateImportContext,
  assertNoCredentialLikeKeys,
  assertJsonSerializable,
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
    if (config !== undefined) assertJsonSerializable(config, 'config');
    return repository.createImportRun({
      ...ctx,
      sourceProvider,
      sourceTeamRef: sourceTeamRef ?? null,
      triggerKind,
      config: config ?? {},
    });
  }

  async function recordDiscoveredCount({ orgId, importRunId, count }) {
    requireNonEmptyString(orgId, 'orgId');
    requireNonEmptyString(importRunId, 'importRunId');
    requireNonNegativeInteger(count, 'count');
    return repository.recordDiscoveredCount({ orgId, importRunId, count });
  }

  async function completeImportRun({ orgId, importRunId }) {
    requireNonEmptyString(orgId, 'orgId');
    requireNonEmptyString(importRunId, 'importRunId');
    return repository.completeImportRun({ orgId, importRunId });
  }

  async function failImportRun({ orgId, importRunId, failureStage, rawErrorMessage }) {
    requireNonEmptyString(orgId, 'orgId');
    requireNonEmptyString(importRunId, 'importRunId');
    optionalEnum(failureStage, FAILURE_STAGES, 'failureStage');
    return repository.failImportRun({ orgId, importRunId, failureStage: failureStage ?? null, rawErrorMessage });
  }

  // ── Source-game tracking ────────────────────────────────────────────

  async function recordSourceGame({ orgId, importRunId, sourceGameRef, sourceGameUrl, discoveryStatus, gameOutcome, diagnostics, hsGameId }) {
    requireNonEmptyString(orgId, 'orgId');
    requireNonEmptyString(importRunId, 'importRunId');
    requireNonEmptyString(sourceGameRef, 'sourceGameRef');
    requireEnum(discoveryStatus, DISCOVERY_STATUSES, 'discoveryStatus');
    optionalEnum(gameOutcome, GAME_OUTCOMES, 'gameOutcome');
    if (diagnostics !== undefined) assertJsonSerializable(diagnostics, 'diagnostics');
    return repository.recordRunGame({
      orgId, importRunId, sourceGameRef, sourceGameUrl: sourceGameUrl ?? null,
      discoveryStatus, gameOutcome: gameOutcome ?? null, diagnostics: diagnostics ?? {}, hsGameId: hsGameId ?? null,
    });
  }

  async function updateSourceGameOutcome({ orgId, runGameId, discoveryStatus, gameOutcome, diagnostics, hsGameId }) {
    requireNonEmptyString(orgId, 'orgId');
    requireNonEmptyString(runGameId, 'runGameId');
    if (discoveryStatus !== undefined) requireEnum(discoveryStatus, DISCOVERY_STATUSES, 'discoveryStatus');
    if (gameOutcome !== undefined) optionalEnum(gameOutcome, GAME_OUTCOMES, 'gameOutcome');
    if (diagnostics !== undefined) assertJsonSerializable(diagnostics, 'diagnostics');
    return repository.updateRunGameOutcome({ orgId, runGameId, discoveryStatus, gameOutcome, diagnostics, hsGameId });
  }

  // ── Raw snapshots ────────────────────────────────────────────────────

  async function captureSnapshot({ orgId, importRunId, importRunGameId, hsGameId, snapshotKind, sourceProvider, sourceRef, payload, contentType, schemaVersion, integrityHash, capturedAt }) {
    requireNonEmptyString(orgId, 'orgId');
    requireNonEmptyString(importRunId, 'importRunId');
    requireEnum(snapshotKind, SNAPSHOT_KINDS, 'snapshotKind');
    requireEnum(sourceProvider, SOURCE_PROVIDERS, 'sourceProvider');
    const resolvedContentType = contentType ?? 'json';
    requireEnum(resolvedContentType, CONTENT_TYPES, 'contentType');
    assertJsonSerializable(payload, 'payload');
    assertNoCredentialLikeKeys(payload, '$payload');
    return repository.captureRawSnapshot({
      orgId, importRunId, importRunGameId: importRunGameId ?? null, hsGameId: hsGameId ?? null,
      snapshotKind, sourceProvider, sourceRef: sourceRef ?? null, payload, contentType: resolvedContentType,
      schemaVersion: schemaVersion || 'v1', integrityHash: integrityHash ?? null, capturedAt,
    });
  }

  // ── Canonical game resolution ───────────────────────────────────────

  async function resolveCanonicalGame({ orgId, programId, teamId, seasonId, sourceProvider, sourceGameRef, opponentName, gameDate }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId });
    if (sourceProvider !== undefined && sourceProvider !== null) requireEnum(sourceProvider, SOURCE_PROVIDERS, 'sourceProvider');
    requireNonEmptyString(sourceGameRef, 'sourceGameRef');
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
  // IMPORTANT, non-obvious inherited convention: reconstructGame buckets
  // each box-score row via isScoutedRow(row), which is true when
  // row.is_our_team === false -- the OPPOSITE of what the name might
  // suggest. This mirrors validate-team-stats.js's own existing usage
  // (box_scouted_batting: r.scouted.boxBatting, never r.opponent.*), which
  // this module deliberately matches: hs_game_validation_results is always
  // populated from result.scouted.* (never result.opponent.*, which has no
  // meaning in the High School domain -- hs_players/hs_teams model only
  // one program's own players, never a scouted-opponent roster). Callers
  // building capturedGame for an HS import must therefore mark the
  // imported team's OWN batting/pitching rows with is_our_team: false so
  // they land in the "scouted" bucket this module actually persists.
  //
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
    requireNonEmptyString(orgId, 'orgId');
    requireNonEmptyString(importRunId, 'importRunId');
    requireNonEmptyString(hsGameId, 'hsGameId');
    requireNonEmptyString(teamId, 'teamId');
    if (!capturedGame || typeof capturedGame !== 'object') {
      throw importError('INVALID_FIELD', 'capturedGame is required and must be an object', { statusCode: 400, context: { field: 'capturedGame' } });
    }

    const result = reconstructGame(capturedGame);
    const { confidence, validationStatus } = deriveGameConfidenceAndStatus({
      hasBoxScore: result.hasBoxScore,
      hasPlayByPlay: result.hasPlayByPlay,
      battingMatchesBox: result.scouted.validation.battingMatchesBox,
    });

    return repository.insertGameValidationResult({
      orgId, importRunId, importRunGameId: importRunGameId ?? null, hsGameId, teamId,
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
  // arbitrary caller-supplied number, so "complete, validated aggregate
  // that meets the existing reconstruction contract" is satisfied
  // structurally rather than by trusting the caller's math.
  async function publishVerifiedTotals({ orgId, programId, teamId, seasonId, importRunId, games }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId: seasonId ?? undefined });
    if (!ctx.seasonId) {
      throw importError('INVALID_FIELD', 'seasonId is required to publish verified totals (hs_verified_totals.season_id is NOT NULL)', { statusCode: 400, context: { field: 'seasonId' } });
    }
    if (!Array.isArray(games) || games.length === 0) {
      throw importError('EMPTY_AGGREGATE', 'publishVerifiedTotals requires at least one captured game', { statusCode: 400 });
    }
    const { summary } = reconstructTeamGames(teamId, games);
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
    requireNonEmptyString(hsPlayerId, 'hsPlayerId');
    assertJsonSerializable(stats, 'stats');
    return repository.publishPlayerAdvancedStats({ ...ctx, importRunId: importRunId ?? null, playerId: hsPlayerId, stats: stats ?? {} });
  }

  async function publishPitcherAdvancedStats({ orgId, programId, teamId, seasonId, importRunId, hsPlayerId, stats }) {
    const ctx = validateImportContext({ orgId, programId, teamId, seasonId });
    if (!ctx.seasonId) {
      throw importError('INVALID_FIELD', 'seasonId is required to publish pitcher advanced stats', { statusCode: 400, context: { field: 'seasonId' } });
    }
    if (!hsPlayerId) {
      throw importError('UNRESOLVED_PLAYER', 'publishPitcherAdvancedStats requires an already-resolved hsPlayerId; unresolved players are rejected, not name-matched', { statusCode: 400 });
    }
    requireNonEmptyString(hsPlayerId, 'hsPlayerId');
    assertJsonSerializable(stats, 'stats');
    return repository.publishPitcherAdvancedStats({ ...ctx, importRunId: importRunId ?? null, playerId: hsPlayerId, stats: stats ?? {} });
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
  };
}

module.exports = {
  createHighSchoolImportService,
  createHighSchoolImportRepository,
  IMPORT_RUN_STATUSES,
};
