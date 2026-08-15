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
// publishPitcherAdvancedStats used to document exactly that gap inline
// (a three-step, non-atomic sequence). Slice 1A.1
// (supabase/migrations/20260730170431_add_hs_publish_rpcs.sql) closes it:
// each of the three functions below now makes exactly ONE PostgREST call --
// `adminClient.rpc(...)` against a SECURITY DEFINER Postgres function that
// performs the whole find-current/supersede/insert sequence, plus
// independent org/team/season/player/import-run ownership and lifecycle
// checks, inside a single database transaction. A failure at any point
// leaves the previously published row completely untouched -- there is no
// longer a window where the old row is superseded but no replacement
// exists. See that migration's own header comment for the full
// authorization-model and concurrency rationale.

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
  if (!adminClient || typeof adminClient.from !== 'function' || typeof adminClient.rpc !== 'function') {
    throw importError('INVALID_REPOSITORY_CLIENT', 'createHighSchoolImportRepository requires an injected client exposing .from() and .rpc()', {
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

  // The read-side counterpart of the write functions below -- kept in this
  // same file specifically so every reference to hs_import_runs/
  // hs_import_run_games/hs_game_validation_results/hs_verified_totals/
  // hs_player_advanced_stats/hs_pitcher_advanced_stats stays confined to
  // this one persistence layer (see the existing repo-wide test enforcing
  // exactly that boundary) even for the new GameChanger-ingestion HTTP
  // routes that need to show a coach an import's status/review/results.
  async function listImportRuns({ orgId, teamId, seasonId, limit = 20 }) {
    const { data, error } = await adminClient
      .from('hs_import_runs')
      .select('id, status, source_provider, trigger_kind, started_at, completed_at, games_discovered, games_processed, games_succeeded, games_failed, failure_stage, error_summary, created_at')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('season_id', seasonId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw persistenceFailed('hs_import_runs', error);
    return data || [];
  }

  async function listRunGames({ orgId, importRunId }) {
    const { data, error } = await adminClient
      .from('hs_import_run_games')
      .select('id, source_game_ref, discovery_status, game_outcome, diagnostics, hs_game_id, created_at')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId);
    if (error) throw persistenceFailed('hs_import_run_games', error);
    return data || [];
  }

  // Rebuilds the exact { boxScore, plays } shape publishVerifiedTotals's
  // reconstructTeamGames expects, per successfully-imported game in a run,
  // from the ALREADY-CAPTURED (isHighSchoolTeam-tagged) raw snapshots this
  // run's own ingestion wrote via captureRawSnapshot -- never re-scrapes,
  // never accepts a caller-supplied payload. This is what makes "publish
  // the exact reviewed server-side import" a real guarantee: the publish
  // route has no field in its own request body that can influence any of
  // this data.
  async function getCapturedGamesForRun({ orgId, importRunId }) {
    const { data: runGames, error: gamesError } = await adminClient
      .from('hs_import_run_games')
      .select('id, hs_game_id')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId)
      .eq('game_outcome', 'inserted');
    if (gamesError) throw persistenceFailed('hs_import_run_games', gamesError);

    const eligible = (runGames || []).filter((g) => g.hs_game_id);
    if (eligible.length === 0) return [];

    const { data: snapshots, error: snapError } = await adminClient
      .from('hs_raw_snapshots')
      .select('import_run_game_id, snapshot_kind, payload, captured_at')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId)
      .in('import_run_game_id', eligible.map((g) => g.id))
      .in('snapshot_kind', ['box_score', 'play_by_play'])
      .order('captured_at', { ascending: false });
    if (snapError) throw persistenceFailed('hs_raw_snapshots', snapError);

    // Most-recently-captured snapshot per (run_game, kind) wins -- relevant
    // only if a game was somehow snapshotted more than once within the
    // same run, which normal ingestion never does, but this keeps the read
    // side correct rather than assuming exactly one row exists.
    const latestByGameAndKind = new Map();
    for (const snap of snapshots || []) {
      const key = `${snap.import_run_game_id}:${snap.snapshot_kind}`;
      if (!latestByGameAndKind.has(key)) latestByGameAndKind.set(key, snap.payload);
    }

    return eligible
      .map((g) => ({
        boxScore: latestByGameAndKind.get(`${g.id}:box_score`) || null,
        plays: latestByGameAndKind.get(`${g.id}:play_by_play`)?.plays || [],
      }))
      .filter((g) => g.boxScore);
  }

  async function listGameValidationResults({ orgId, importRunId }) {
    const { data, error } = await adminClient
      .from('hs_game_validation_results')
      .select('hs_game_id, has_box_score, has_play_by_play, batting_matches_box, confidence, validation_status, warnings')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId);
    if (error) throw persistenceFailed('hs_game_validation_results', error);
    return data || [];
  }

  async function getCurrentVerifiedTotals({ orgId, teamId, seasonId }) {
    const { data, error } = await adminClient
      .from('hs_verified_totals')
      .select('*')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('season_id', seasonId)
      .eq('is_current', true)
      .maybeSingle();
    if (error) throw persistenceFailed('hs_verified_totals', error);
    return data;
  }

  async function listCurrentPlayerAdvancedStats({ orgId, teamId, seasonId }) {
    const { data, error } = await adminClient
      .from('hs_player_advanced_stats')
      .select('*')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('season_id', seasonId)
      .eq('is_current', true);
    if (error) throw persistenceFailed('hs_player_advanced_stats', error);
    return data || [];
  }

  async function listCurrentPitcherAdvancedStats({ orgId, teamId, seasonId }) {
    const { data, error } = await adminClient
      .from('hs_pitcher_advanced_stats')
      .select('*')
      .eq('org_id', orgId)
      .eq('team_id', teamId)
      .eq('season_id', seasonId)
      .eq('is_current', true);
    if (error) throw persistenceFailed('hs_pitcher_advanced_stats', error);
    return data || [];
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
  // they can be computed safely.
  //
  // A row counts as TERMINAL only if it has a recorded game_outcome, or a
  // discovery_status that itself represents a terminal, no-outcome-needed
  // stop ('skipped'/'rejected'/'failed'). A row still 'discovered' or
  // 'processing' -- or 'processed' with no game_outcome ever recorded --
  // is NOT terminal: completion is refused outright while any such row
  // remains, rather than silently counting it as "processed" and reporting
  // a falsely-confident 'succeeded' status.
  //
  // Every terminal row is classified into exactly one of
  // succeeded/failed/skipped/rejected (never left uncounted, unlike the
  // earlier version of this function, which silently excluded
  // skipped/rejected outcomes from every bucket). The status enum
  // (hs_import_runs.status) has no distinct "some games were skipped"
  // value, so skipped/rejected counts alone -- with zero failures -- still
  // resolve to 'succeeded' (the run itself did not fail); that nuance is
  // NOT lost, though, because skipped/rejected are still recorded
  // separately in result_summary for anyone inspecting the run.
  function classifyRunGame(row) {
    if (row.game_outcome) {
      if (row.game_outcome === 'inserted' || row.game_outcome === 'replaced') return 'succeeded';
      return row.game_outcome; // 'skipped' | 'rejected' | 'failed'
    }
    if (row.discovery_status === 'skipped' || row.discovery_status === 'rejected' || row.discovery_status === 'failed') {
      return row.discovery_status;
    }
    return null; // not yet terminal
  }

  async function completeImportRun({ orgId, importRunId }) {
    const { data: runGames, error: readError } = await adminClient
      .from('hs_import_run_games')
      .select('discovery_status, game_outcome')
      .eq('org_id', orgId)
      .eq('import_run_id', importRunId);
    if (readError) throw persistenceFailed('hs_import_run_games', readError);

    const rows = runGames || [];
    const stillPending = rows.filter((r) => classifyRunGame(r) === null);
    if (stillPending.length > 0) {
      throw importError(
        'RUN_NOT_READY_TO_COMPLETE',
        `Cannot complete run: ${stillPending.length} of ${rows.length} game(s) are still ${[...new Set(stillPending.map((r) => r.discovery_status))].join('/')} with no recorded outcome`,
        { statusCode: 409, retryable: true, context: { table: 'hs_import_run_games' } }
      );
    }

    const succeeded = rows.filter((r) => classifyRunGame(r) === 'succeeded').length;
    const failed = rows.filter((r) => classifyRunGame(r) === 'failed').length;
    const skipped = rows.filter((r) => classifyRunGame(r) === 'skipped').length;
    const rejected = rows.filter((r) => classifyRunGame(r) === 'rejected').length;
    const processed = rows.length;
    const status = failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial';

    const { data, error } = await adminClient
      .from('hs_import_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
        games_processed: processed,
        games_succeeded: succeeded,
        games_failed: failed,
        result_summary: { processed, succeeded, failed, skipped, rejected },
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

  // ── Shared atomic-publish RPC caller ──────────────────────────────────
  //
  // Every publish* function below makes exactly ONE `adminClient.rpc(...)`
  // call against a SECURITY DEFINER Postgres function
  // (supabase/migrations/20260730170431_add_hs_publish_rpcs.sql) that
  // performs the entire find-current/supersede/insert sequence, plus
  // org/team/season/player/import-run ownership and lifecycle checks,
  // inside one database transaction. There is no longer a client-visible
  // "supersede succeeded, insert failed" state to document or detect --
  // the database guarantees all-or-nothing.
  //
  // PUBLISH_RPC_ERRORS maps the stable, documented error-message PREFIXES
  // each RPC function raises (see the migration's own comments) onto this
  // module's typed error codes -- never a raw Postgres message forwarded
  // as-is. CONCURRENT_PUBLICATION_CONFLICT is intentionally preserved
  // under the same code name Slice 1A used for its own (weaker, detect-
  // after-the-fact) JS-level check: the underlying race is now prevented
  // by row locking rather than merely detected, but a caller who loses a
  // lock-wait race against another publisher for the exact same identity
  // still sees this same, already-documented, retryable error.
  const PUBLISH_RPC_ERRORS = [
    { prefix: 'team_not_found_for_org_program', code: 'TEAM_NOT_FOUND_FOR_ORG', statusCode: 404 },
    { prefix: 'season_not_found_for_org_program', code: 'SEASON_NOT_FOUND_FOR_ORG', statusCode: 404 },
    { prefix: 'player_not_found_for_org_program', code: 'PLAYER_NOT_FOUND_FOR_ORG', statusCode: 404 },
    { prefix: 'import_run_not_found_for_org_team', code: 'IMPORT_RUN_NOT_FOUND_FOR_ORG_TEAM', statusCode: 404 },
    { prefix: 'incomplete_box_score_coverage', code: 'INCOMPLETE_BOX_SCORE_COVERAGE', statusCode: 409 },
    { prefix: 'unresolved_mismatch', code: 'UNRESOLVED_MISMATCH', statusCode: 409 },
    { prefix: 'invalid_verified_totals_counts', code: 'INVALID_VERIFIED_TOTALS_COUNTS', statusCode: 409 },
    { prefix: 'invalid_import_run_state', code: 'INVALID_IMPORT_RUN_STATE', statusCode: 409 },
    { prefix: 'stale_import_run_publication', code: 'STALE_IMPORT_RUN_PUBLICATION', statusCode: 409 },
    { prefix: 'unknown_stat_field', code: 'UNKNOWN_STAT_FIELD', statusCode: 400 },
    { prefix: 'concurrent_publication_conflict', code: 'CONCURRENT_PUBLICATION_CONFLICT', statusCode: 409, retryable: true },
  ];

  async function publishViaRpc(table, rpcName, params) {
    const { data, error } = await adminClient.rpc(rpcName, params);
    if (error) {
      const message = error.message || '';
      const matched = PUBLISH_RPC_ERRORS.find((m) => message.startsWith(m.prefix));
      if (matched) {
        throw importError(matched.code, sanitizeErrorMessage(message) || matched.code, {
          statusCode: matched.statusCode,
          retryable: !!matched.retryable,
          context: { table },
        });
      }
      throw persistenceFailed(table, error);
    }
    return data;
  }

  async function publishVerifiedTotals({ orgId, programId, teamId, seasonId, importRunId, aggregate }) {
    return publishViaRpc('hs_verified_totals', 'publish_hs_verified_totals', {
      p_org_id: orgId,
      p_program_id: programId,
      p_team_id: teamId,
      p_season_id: seasonId,
      p_import_run_id: importRunId ?? null,
      p_games: aggregate.games,
      p_box_score_games: aggregate.boxScoreGames,
      p_play_by_play_games: aggregate.playByPlayGames,
      p_validated_games: aggregate.validatedGames,
      p_mismatch_games: aggregate.mismatchGames,
      p_batting_official: aggregate.officialBatting ?? {},
      p_pitching_official: aggregate.officialPitching ?? {},
      p_batting_reconstructed: aggregate.reconstructedBatting ?? {},
      p_pitching_reconstructed: aggregate.reconstructedPitchingDefense ?? {},
      p_tendencies: aggregate.tendencies ?? {},
      p_warnings: aggregate.warnings ?? [],
      p_confidence: aggregate.confidence,
    });
  }

  // stats is a passthrough map of already-computed hs_player_advanced_stats
  // column values (games, total_pitches, gb, fb, ld, ...) -- Slice 1A does
  // not compute these from raw play data. Unlike Slice 1A's own JS layer
  // (which silently STRIPPED reserved/identity keys out of a caller-
  // supplied stats blob), this is no longer done here: the RPC itself
  // rejects any key that is not a recognized stat column -- including a
  // reserved/identity key like org_id or is_current -- with a distinct
  // UNKNOWN_STAT_FIELD error, rather than silently discarding it. See the
  // migration's own comment for why an explicit rejection is preferable to
  // a silent strip a caller could never observe.
  async function publishPlayerAdvancedStats({ orgId, programId, teamId, seasonId, importRunId, playerId, stats }) {
    return publishViaRpc('hs_player_advanced_stats', 'publish_hs_player_advanced_stats', {
      p_org_id: orgId,
      p_program_id: programId,
      p_team_id: teamId,
      p_season_id: seasonId,
      p_player_id: playerId,
      p_import_run_id: importRunId ?? null,
      p_stats: stats ?? {},
    });
  }

  async function publishPitcherAdvancedStats({ orgId, programId, teamId, seasonId, importRunId, playerId, stats }) {
    return publishViaRpc('hs_pitcher_advanced_stats', 'publish_hs_pitcher_advanced_stats', {
      p_org_id: orgId,
      p_program_id: programId,
      p_team_id: teamId,
      p_season_id: seasonId,
      p_player_id: playerId,
      p_import_run_id: importRunId ?? null,
      p_stats: stats ?? {},
    });
  }

  // Slice 2C complete-generation publication. The mapper has already
  // computed, sanitized, canonically serialized, hashed, and size-checked
  // this DTO. One RPC call is the entire repository contract: Postgres owns
  // every identity upsert, evidence append, generation supersession, and run
  // finalization in one transaction.
  const ENGINE_COLLECTION_RPC_ERRORS = [
    ['malformed_engine_collection', 'INVALID_ENGINE_COLLECTION', 400],
    ['invalid_engine_version', 'INVALID_ENGINE_VERSION', 400],
    ['invalid_collection_digest', 'INVALID_ENGINE_COLLECTION_DIGEST', 400],
    ['engine_collection_payload_too_large', 'HS_ENGINE_COLLECTION_TOO_LARGE', 413],
    ['invalid_source_provider', 'INVALID_SOURCE_PROVIDER', 400],
    ['team_not_found_for_org_program', 'TEAM_NOT_FOUND_FOR_ORG', 404],
    ['season_not_found_for_org_program', 'SEASON_NOT_FOUND_FOR_ORG', 404],
    ['invalid_import_run_state', 'INVALID_IMPORT_RUN_STATE', 409],
    ['idempotency_content_mismatch', 'IDEMPOTENCY_CONTENT_MISMATCH', 409],
    ['player_not_on_roster', 'PLAYER_NOT_ON_ROSTER', 409],
    ['invalid_canonical_player_role', 'INVALID_CANONICAL_PLAYER_ROLE', 400],
  ];

  async function persistEngineCollection(dto) {
    const { data, error } = await adminClient.rpc('persist_hs_engine_collection', { p_dto: dto });
    if (!error) return data;
    const rawMessage = String(error.message || '');
    const match = ENGINE_COLLECTION_RPC_ERRORS.find(([prefix]) => rawMessage.startsWith(prefix));
    if (match) {
      const [prefix, code, statusCode] = match;
      throw importError(code, prefix.replaceAll('_', ' '), {
        statusCode,
        retryable: code === 'INVALID_IMPORT_RUN_STATE',
        context: { table: 'hs_stat_generations' },
      });
    }
    throw persistenceFailed('hs_stat_generations', error);
  }

  return {
    createImportRun,
    getImportRun,
    listImportRuns,
    recordDiscoveredCount,
    completeImportRun,
    failImportRun,
    recordRunGame,
    listRunGames,
    getCapturedGamesForRun,
    updateRunGameOutcome,
    captureRawSnapshot,
    resolveOrCreateGame,
    insertGameValidationResult,
    listGameValidationResults,
    publishVerifiedTotals,
    publishPlayerAdvancedStats,
    publishPitcherAdvancedStats,
    persistEngineCollection,
    getCurrentVerifiedTotals,
    listCurrentPlayerAdvancedStats,
    listCurrentPitcherAdvancedStats,
  };
}

module.exports = { createHighSchoolImportRepository };
