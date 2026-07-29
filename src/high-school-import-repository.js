'use strict';

// Database access layer for the High School import persistence core
// (Slice 1A). Every function here does exactly one well-defined operation
// against exactly one Slice 0B table (hs_import_runs, hs_import_run_games,
// hs_raw_snapshots, hs_games, hs_game_validation_results,
// hs_verified_totals, hs_player_advanced_stats, hs_pitcher_advanced_stats).
//
// ── Dependency injection, not construction ───────────────────────────────
// createHighSchoolImportRepository(adminClient) takes an ALREADY-BUILT
// Supabase client and returns bound methods over it -- this module never
// calls createClient() or reads process.env itself (unlike src/supabase.js,
// which is the one place in this codebase that legitimately does). That
// keeps every function here testable with an in-memory fake client (see
// test/helpers/fake-supabase-client.js) with zero network access, and
// keeps the choice of "which client" (service-role for a background
// import job vs. a caller mistakenly passing a browser/user client) a
// decision made once by whoever wires this repository up, not something
// buried inside it. This module has no opinion on and does not enforce
// which client it is handed -- see src/high-school-import-service.js's own
// header comment for why that boundary is drawn at the caller, not here.
//
// ── Why a factory, not flat exported functions ───────────────────────────
// high-school-roster-service.js's functions each take `adminClient` as a
// per-call parameter because every one of its callers (the Express routes
// in high-school-api.js) already has that client in scope per-request.
// This module's callers (high-school-import-service.js) instead hold a
// repository reference across MANY calls within a single import run, so a
// factory that closes over the client once is less repetitive at the call
// site and is what makes a clean repository-shaped test double possible
// (see fake-supabase-client.js's own comment).
//
// ── Idempotency pattern used throughout ──────────────────────────────────
// Every insert that must be idempotent (recordRunGame, resolveOrCreateGame,
// captureRawSnapshot, insertGameValidationResult) follows the SAME
// insert-then-on-conflict-reselect shape: attempt the insert; if it fails
// with Postgres unique-violation 23505, re-select the row the database's
// OWN unique index says already exists and return it instead of throwing.
// This uses the schema's actual constraints as the source of truth for
// what counts as "the same" -- never a parallel, weaker identity rule
// invented in application code.
//
// ── Errors never carry raw provider detail ───────────────────────────────
// error.message from Supabase/PostgREST is passed through
// sanitizeErrorMessage (credential-scrubbed, length-bounded) before it is
// ever embedded in a thrown error; error.details/error.hint (which can
// echo back raw column values) are never forwarded at all.
//
// ── Transactionality ──────────────────────────────────────────────────────
// A single PostgREST call is atomic; a SEQUENCE of calls (e.g. "select the
// current row, update it to superseded, insert the new current row") is
// NOT. publishVerifiedTotals/publishPlayerAdvancedStats/
// publishPitcherAdvancedStats each document their own specific gap inline
// below -- see the "NOT ATOMIC" comments -- rather than pretending the
// three-step sequence is a transaction.

const {
  importError,
  sanitizeErrorMessage,
} = require('./high-school-import-sanitizer');

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error) {
  return error?.code === UNIQUE_VIOLATION;
}

function persistenceFailed(table, error) {
  return importError('PERSISTENCE_FAILED', sanitizeErrorMessage(error?.message) || `Write to ${table} failed`, {
    statusCode: 502,
    retryable: true,
    context: { table },
  });
}

function createHighSchoolImportRepository(adminClient) {
  if (!adminClient || typeof adminClient.from !== 'function') {
    throw importError('INVALID_REPOSITORY_CLIENT', 'createHighSchoolImportRepository requires an injected client exposing .from()', {
      statusCode: 500,
    });
  }

  // ── hs_import_runs ───────────────────────────────────────────────────

  async function createImportRun({ orgId, programId, teamId, seasonId, sourceProvider, sourceTeamRef, triggerKind, config }) {
    const { data, error } = await adminClient
      .from('hs_import_runs')
      .insert({
        org_id: orgId,
        program_id: programId,
        team_id: teamId,
        season_id: seasonId ?? null,
        source_provider: sourceProvider,
        source_team_ref: sourceTeamRef ?? null,
        trigger_kind: triggerKind,
        status: 'running',
        started_at: new Date().toISOString(),
        config: config ?? {},
      })
      .select('*')
      .single();
    if (error) throw persistenceFailed('hs_import_runs', error);
    return data;
  }

  async function getImportRun({ orgId, importRunId }) {
    const { data, error } = await adminClient
      .from('hs_import_runs')
      .select('*')
      .eq('org_id', orgId)
      .eq('id', importRunId)
      .maybeSingle();
    if (error) throw persistenceFailed('hs_import_runs', error);
    return data;
  }

  async function recordDiscoveredCount({ orgId, importRunId, count }) {
    const { data, error } = await adminClient
      .from('hs_import_runs')
      .update({ games_discovered: count })
      .eq('org_id', orgId)
      .eq('id', importRunId)
      .select('*')
      .single();
    if (error) throw persistenceFailed('hs_import_runs', error);
    return data;
  }

  // games_processed/succeeded/failed are DERIVED from hs_import_run_games
  // rather than trusted from a caller-supplied number -- see this slice's
  // own instruction not to trust caller-supplied derived counters when
  // they can be computed safely. A run with zero games processed and zero
  // failures is 'succeeded' (nothing to fail); any failure alongside at
  // least one success is 'partial'; every game failing is 'failed'.
  async function completeImportRun({ orgId, importRunId }) {
    const { data: runGames, error: readError } = await adminClient
      .from('hs_import_run_games')
      .select('discovery_status, game_outcome')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId);
    if (readError) throw persistenceFailed('hs_import_run_games', readError);

    const rows = runGames || [];
    const failed = rows.filter((r) => r.discovery_status === 'failed' || r.game_outcome === 'failed').length;
    const succeeded = rows.filter((r) => r.game_outcome === 'inserted' || r.game_outcome === 'replaced').length;
    const processed = rows.length;
    const status = processed === 0 || failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial';

    const { data, error } = await adminClient
      .from('hs_import_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
        games_processed: processed,
        games_succeeded: succeeded,
        games_failed: failed,
        result_summary: { processed, succeeded, failed },
      })
      .eq('org_id', orgId)
      .eq('id', importRunId)
      .select('*')
      .single();
    if (error) throw persistenceFailed('hs_import_runs', error);
    return data;
  }

  async function failImportRun({ orgId, importRunId, failureStage, rawErrorMessage }) {
    const { data, error } = await adminClient
      .from('hs_import_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        failure_stage: failureStage ?? null,
        error_summary: sanitizeErrorMessage(rawErrorMessage),
      })
      .eq('org_id', orgId)
      .eq('id', importRunId)
      .select('*')
      .single();
    if (error) throw persistenceFailed('hs_import_runs', error);
    return data;
  }

  // ── hs_import_run_games ──────────────────────────────────────────────
  //
  // Idempotent on (import_run_id, source_game_ref) -- the schema's own
  // unique constraint. A retried/duplicate call for the same source game
  // within the same run returns the EXISTING row (created: false) rather
  // than throwing or creating a second row.
  async function recordRunGame({ orgId, importRunId, sourceGameRef, sourceGameUrl, discoveryStatus, gameOutcome, diagnostics, hsGameId }) {
    const { data, error } = await adminClient
      .from('hs_import_run_games')
      .insert({
        org_id: orgId,
        import_run_id: importRunId,
        hs_game_id: hsGameId ?? null,
        source_game_ref: sourceGameRef,
        source_game_url: sourceGameUrl ?? null,
        discovery_status: discoveryStatus,
        game_outcome: gameOutcome ?? null,
        diagnostics: diagnostics ?? {},
      })
      .select('*')
      .single();
    if (!error) return { row: data, created: true };
    if (!isUniqueViolation(error)) throw persistenceFailed('hs_import_run_games', error);

    const { data: existing, error: selectError } = await adminClient
      .from('hs_import_run_games')
      .select('*')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId)
      .eq('source_game_ref', sourceGameRef)
      .maybeSingle();
    if (selectError) throw persistenceFailed('hs_import_run_games', selectError);
    return { row: existing, created: false };
  }

  async function updateRunGameOutcome({ orgId, runGameId, discoveryStatus, gameOutcome, diagnostics, hsGameId }) {
    const patch = {};
    if (discoveryStatus !== undefined) patch.discovery_status = discoveryStatus;
    if (gameOutcome !== undefined) patch.game_outcome = gameOutcome;
    if (diagnostics !== undefined) patch.diagnostics = diagnostics;
    if (hsGameId !== undefined) patch.hs_game_id = hsGameId;

    const { data, error } = await adminClient
      .from('hs_import_run_games')
      .update(patch)
      .eq('org_id', orgId)
      .eq('id', runGameId)
      .select('*')
      .single();
    if (error) throw persistenceFailed('hs_import_run_games', error);
    return data;
  }

  // ── hs_raw_snapshots ──────────────────────────────────────────────────
  //
  // Idempotent per the schema's own two partial unique indexes (split on
  // whether import_run_game_id is present). A duplicate write at the exact
  // same (association, snapshot_kind, captured_at) returns the existing
  // row rather than throwing -- see this module's header comment on the
  // shared idempotency pattern.
  async function captureRawSnapshot({
    orgId, importRunId, importRunGameId, hsGameId, snapshotKind, sourceProvider,
    sourceRef, payload, contentType, schemaVersion, integrityHash, capturedAt,
  }) {
    const capturedAtIso = capturedAt || new Date().toISOString();
    const { data, error } = await adminClient
      .from('hs_raw_snapshots')
      .insert({
        org_id: orgId,
        import_run_id: importRunId,
        import_run_game_id: importRunGameId ?? null,
        hs_game_id: hsGameId ?? null,
        snapshot_kind: snapshotKind,
        source_provider: sourceProvider,
        source_ref: sourceRef ?? null,
        captured_at: capturedAtIso,
        payload: payload ?? {},
        content_type: contentType,
        schema_version: schemaVersion || 'v1',
        integrity_hash: integrityHash ?? null,
      })
      .select('*')
      .single();
    if (!error) return { row: data, created: true };
    if (!isUniqueViolation(error)) throw persistenceFailed('hs_raw_snapshots', error);

    let query = adminClient
      .from('hs_raw_snapshots')
      .select('*')
      .eq('org_id', orgId)
      .eq('snapshot_kind', snapshotKind)
      .eq('captured_at', capturedAtIso);
    query = importRunGameId
      ? query.eq('import_run_game_id', importRunGameId)
      : query.eq('import_run_id', importRunId).is('import_run_game_id', null);
    const { data: existing, error: selectError } = await query.maybeSingle();
    if (selectError) throw persistenceFailed('hs_raw_snapshots', selectError);
    return { row: existing, created: false };
  }

  // ── hs_games (canonical game resolution) ─────────────────────────────
  //
  // Requires a real sourceGameRef -- there is no code path here that
  // creates a game without one, because doing so would mean guessing
  // canonical identity from opponent name/date alone (explicitly
  // forbidden). A caller that cannot yet supply one simply does not call
  // this operation, leaving hs_import_run_games.hs_game_id null, which
  // the schema is designed to support.
  async function resolveOrCreateGame({ orgId, programId, teamId, seasonId, sourceProvider, sourceGameRef, opponentName, gameDate }) {
    if (!sourceGameRef) {
      throw importError('CANNOT_RESOLVE_GAME_IDENTITY', 'resolveOrCreateGame requires a non-empty sourceGameRef and will not guess canonical game identity', {
        statusCode: 400,
      });
    }

    const { data: existing, error: selectError } = await adminClient
      .from('hs_games')
      .select('*')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('source_game_ref', sourceGameRef)
      .maybeSingle();
    if (selectError) throw persistenceFailed('hs_games', selectError);
    if (existing) return { row: existing, created: false };

    const { data, error } = await adminClient
      .from('hs_games')
      .insert({
        org_id: orgId,
        program_id: programId,
        team_id: teamId,
        season_id: seasonId ?? null,
        opponent_name: opponentName ?? null,
        game_date: gameDate ?? null,
        source_provider: sourceProvider ?? null,
        source_game_ref: sourceGameRef,
      })
      .select('*')
      .single();
    if (!error) return { row: data, created: true };
    if (!isUniqueViolation(error)) throw persistenceFailed('hs_games', error);

    const { data: raced, error: reselectError } = await adminClient
      .from('hs_games')
      .select('*')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('source_game_ref', sourceGameRef)
      .maybeSingle();
    if (reselectError) throw persistenceFailed('hs_games', reselectError);
    return { row: raced, created: false };
  }

  // ── hs_game_validation_results ───────────────────────────────────────
  //
  // One row per (import_run_id, hs_game_id) -- the schema's own unique
  // constraint. A retried call for the same run+game returns the existing
  // row instead of creating a second, ambiguous one.
  async function insertGameValidationResult(fields) {
    const { orgId, importRunId, importRunGameId, hsGameId, teamId } = fields;
    const { data, error } = await adminClient
      .from('hs_game_validation_results')
      .insert({
        org_id: orgId,
        import_run_id: importRunId,
        import_run_game_id: importRunGameId ?? null,
        hs_game_id: hsGameId,
        team_id: teamId,
        has_box_score: fields.hasBoxScore,
        has_play_by_play: fields.hasPlayByPlay,
        scouted_side: fields.scoutedSide ?? null,
        opponent_side: fields.opponentSide ?? null,
        box_score_batting: fields.boxScoreBatting ?? {},
        box_score_pitching: fields.boxScorePitching ?? {},
        reconstructed_batting: fields.reconstructedBatting ?? {},
        reconstructed_pitching: fields.reconstructedPitching ?? {},
        deltas: fields.deltas ?? {},
        batting_matches_box: fields.battingMatchesBox,
        quality: fields.quality ?? {},
        warnings: fields.warnings ?? [],
        confidence: fields.confidence,
        validation_status: fields.validationStatus,
      })
      .select('*')
      .single();
    if (!error) return { row: data, created: true };
    if (!isUniqueViolation(error)) throw persistenceFailed('hs_game_validation_results', error);

    const { data: existing, error: selectError } = await adminClient
      .from('hs_game_validation_results')
      .select('*')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId)
      .eq('hs_game_id', hsGameId)
      .maybeSingle();
    if (selectError) throw persistenceFailed('hs_game_validation_results', selectError);
    return { row: existing, created: false };
  }

  // ── Shared current/superseded publication pattern ────────────────────
  //
  // NOT ATOMIC. Three separate PostgREST calls: (1) find the current row
  // for this identity, if any; (2) update it to is_current=false,
  // superseded_at=now(); (3) insert the new row as current. Step (2) must
  // happen BEFORE step (3) -- the schema's own partial unique index
  // (`... where is_current`) would otherwise reject the new row outright
  // while the old one is still current, which is the correctness property
  // that makes "at most one current row" real. But that ordering means a
  // crash or error between (2) and (3) leaves ZERO current rows for this
  // identity, not two -- the migration's own current/superseded index
  // makes "two current rows" structurally impossible, but does not (and,
  // via a plain client, cannot) make this whole sequence atomic. If step
  // (3) fails after step (2) already succeeded, this throws a distinctly
  // coded error rather than pretending nothing happened; closing this gap
  // for real requires a database-side function (e.g. a
  // publish_hs_verified_totals-shaped RPC) that this slice is explicitly
  // NOT authorized to add. See this repository's PR description for the
  // recommendation to build one in a later slice.
  async function publishCurrentRow({ table, currentLookup, newRow }) {
    let query = adminClient.from(table).select('id').eq('is_current', true);
    for (const [column, value] of Object.entries(currentLookup)) query = query.eq(column, value);
    const { data: existingCurrent, error: selectError } = await query.maybeSingle();
    if (selectError) throw persistenceFailed(table, selectError);

    if (existingCurrent) {
      const { error: supersedeError } = await adminClient
        .from(table)
        .update({ is_current: false, superseded_at: new Date().toISOString() })
        .eq('id', existingCurrent.id);
      if (supersedeError) throw persistenceFailed(table, supersedeError);
    }

    const { data: inserted, error: insertError } = await adminClient
      .from(table)
      .insert({ ...newRow, is_current: true, superseded_at: null })
      .select('*')
      .single();
    if (insertError) {
      throw importError(
        'CURRENT_ROW_SUPERSESSION_INCOMPLETE',
        existingCurrent
          ? `Superseded the previous current row in ${table} but failed to insert its replacement; no current row now exists for this identity and it must be republished`
          : sanitizeErrorMessage(insertError.message) || `Insert into ${table} failed`,
        { statusCode: 502, retryable: true, context: { table } }
      );
    }
    return inserted;
  }

  async function publishVerifiedTotals({ orgId, programId, teamId, seasonId, importRunId, aggregate }) {
    return publishCurrentRow({
      table: 'hs_verified_totals',
      currentLookup: { team_id: teamId, season_id: seasonId },
      newRow: {
        org_id: orgId,
        program_id: programId,
        team_id: teamId,
        season_id: seasonId,
        import_run_id: importRunId ?? null,
        games: aggregate.games,
        box_score_games: aggregate.boxScoreGames,
        play_by_play_games: aggregate.playByPlayGames,
        validated_games: aggregate.validatedGames,
        mismatch_games: aggregate.mismatchGames,
        batting_official: aggregate.officialBatting ?? {},
        pitching_official: aggregate.officialPitching ?? {},
        batting_reconstructed: aggregate.reconstructedBatting ?? {},
        pitching_reconstructed: aggregate.reconstructedPitchingDefense ?? {},
        tendencies: aggregate.tendencies ?? {},
        warnings: aggregate.warnings ?? [],
        confidence: aggregate.confidence,
      },
    });
  }

  // stats is a passthrough map of already-computed hs_player_advanced_stats
  // column values (games, total_pitches, gb, fb, ld, ...) -- Slice 1A does
  // not compute these from raw play data (see this module's own PR
  // description); reserved/identity columns are stripped so a caller can
  // never use the stats blob to smuggle in a different org/player/current
  // flag than the one explicitly passed as playerId/hierarchy context.
  const RESERVED_STAT_COLUMNS = ['id', 'org_id', 'program_id', 'team_id', 'season_id', 'player_id', 'import_run_id', 'is_current', 'superseded_at', 'created_at', 'updated_at'];
  function stripReservedColumns(stats) {
    const clean = { ...(stats || {}) };
    for (const key of RESERVED_STAT_COLUMNS) delete clean[key];
    return clean;
  }

  async function publishPlayerAdvancedStats({ orgId, programId, teamId, seasonId, importRunId, playerId, stats }) {
    return publishCurrentRow({
      table: 'hs_player_advanced_stats',
      currentLookup: { player_id: playerId, team_id: teamId, season_id: seasonId },
      newRow: {
        org_id: orgId,
        program_id: programId,
        team_id: teamId,
        season_id: seasonId,
        player_id: playerId,
        import_run_id: importRunId ?? null,
        generated_at: new Date().toISOString(),
        ...stripReservedColumns(stats),
      },
    });
  }

  async function publishPitcherAdvancedStats({ orgId, programId, teamId, seasonId, importRunId, playerId, stats }) {
    return publishCurrentRow({
      table: 'hs_pitcher_advanced_stats',
      currentLookup: { player_id: playerId, team_id: teamId, season_id: seasonId },
      newRow: {
        org_id: orgId,
        program_id: programId,
        team_id: teamId,
        season_id: seasonId,
        player_id: playerId,
        import_run_id: importRunId ?? null,
        generated_at: new Date().toISOString(),
        ...stripReservedColumns(stats),
      },
    });
  }

  return {
    createImportRun,
    getImportRun,
    recordDiscoveredCount,
    completeImportRun,
    failImportRun,
    recordRunGame,
    updateRunGameOutcome,
    captureRawSnapshot,
    resolveOrCreateGame,
    insertGameValidationResult,
    publishVerifiedTotals,
    publishPlayerAdvancedStats,
    publishPitcherAdvancedStats,
  };
}

module.exports = { createHighSchoolImportRepository };
