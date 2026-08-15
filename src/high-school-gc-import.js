'use strict';

// High School GameChanger ingestion adapter.
//
// Bridges licensed, automated GameChanger collection (authorized under the
// Commercial Data Access & Automated Scraping License Agreement effective
// 2026-08-01 -- see the PR description for the authorization summary; the
// signed agreement itself is never stored in this repository) into the
// already-built, already-tested High School import pipeline
// (src/high-school-import-service.js / -repository.js / -sanitizer.js).
//
// Compatibility basis (see PR description for the full write-up): GameChanger's
// page structure -- the AG-Grid box score, the plays feed, the completed-game
// score-badge convention a schedule page uses to mark a finished game -- is
// the same regardless of team type. src/search-gamechanger-teams.js's pure
// DOM-extraction functions (extractGameData, extractBoxScore, extractPlays,
// getVisibleCompletedGameEntries, normalizeTeamUrl) are reused UNMODIFIED
// here (now exported from that file for exactly this purpose). What is NOT
// reused is that file's own orchestration loop
// (captureAllCompletedGamesFromSchedule / processOneCompletedGame /
// processTeam) -- that loop calls straight into Travel's SQLite/Supabase
// persistence layer (src/pipeline.js) mid-scrape, so it cannot be reused for
// a different product's tables without either forking it or accepting a
// hardcoded Travel dependency inside a High School import. This module is a
// NEW, narrow orchestration loop instead: it calls the same pure extraction
// functions, but feeds every result into the High School import service.
//
// Collected fields are limited to the licensed statistical/play-by-play
// scope: game header/date/opponent, box-score rows (player name, jersey
// number, batting/pitching statistical fields), and play-by-play text.
// Nothing else is read from or written about a GameChanger page. No email,
// phone, birthdate, address, or account/session data belonging to any
// GameChanger user is ever requested, stored, or logged by this module --
// the ONLY personal-identifier-shaped fields that ever flow through it are
// on-field identifiers (player name, jersey number) already present in the
// box-score rows this pipeline exists to import, exactly as licensed.
//
// This file is BOTH a library (the exported, injectable orchestration
// function below, fully testable without Playwright or GameChanger) AND a
// CLI entry point (the require.main===module block at the bottom, which
// wires the injectable function to the real Playwright collector and the
// real Supabase-backed import service) -- mirroring
// src/search-gamechanger-teams.js's own dual role, and matching how
// server.js's /api/run/gc-scraper spawns that file as a child process
// (src/high-school-import-routes.js spawns this file the same way).

const policy = require('./gc-collection-policy');
const { matchPlayerCandidates } = require('./high-school-importer-contract');
const { isValidUuid } = require('./report-access');

// Default sleep -- injectable so tests never actually wait.
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Converts one box-score row into the { isHighSchoolTeam } shape
// high-school-import-service.js's recordGameValidation requires, based on
// which schedule side (`meta.ourSide`) the collected game determined to be
// this High School team. Never trusts a caller-supplied is_our_team/
// isOurTeam field on the raw scraped row -- that field does not exist in
// GameChanger's own data at all; it is derived here, once, from the
// already-resolved side, exactly like Travel's own extractGameData already
// determines "ourSide" by matching the configured team's name against the
// schedule page (search-gamechanger-teams.js's own convention, reused
// unchanged).
function tagRowsWithOwnership(rows, side) {
  return (rows || []).map((row) => ({ ...row, isHighSchoolTeam: (row.TeamSide || row.teamSide) === side }));
}

function buildCapturedGame(gameData, ourSide, evidence = {}) {
  if (ourSide !== 'home' && ourSide !== 'away') {
    const err = new Error('Collected game requires an explicit owned side of home or away.');
    err.code = 'MISSING_TEAM_OWNED_SIDE';
    throw err;
  }
  const boxScore = gameData?.boxScore || {};
  return {
    meta: {
      ...(gameData?.meta || {}),
      ourSide,
      ...(evidence.sourceGameRef ? { sourceGameId: evidence.sourceGameRef } : {}),
      ...(evidence.sourceGameUrl ? { sourceGameUrl: evidence.sourceGameUrl } : {}),
      ...(evidence.capturedAt ? { capturedAt: evidence.capturedAt } : {}),
    },
    boxScore: {
      ...boxScore,
      batting: tagRowsWithOwnership(boxScore.batting, ourSide),
      pitching: tagRowsWithOwnership(boxScore.pitching, ourSide),
    },
    plays: gameData?.plays || [],
  };
}

// Resolves each High-School-team batting/pitching row to an existing
// hs_players id via the canonical (and ONLY) matching precedence this
// codebase defines (src/high-school-importer-contract.js). A row that
// resolves to 'ambiguous' or 'create' is never force-matched to a player --
// its stats are simply not published this run and it is surfaced in the
// returned reconciliation summary for a human to resolve on the roster tab.
// This module never auto-creates a player or roster membership from
// scraped data.
function reconcilePlayers(rows, existingPlayers) {
  const matched = [];
  const ambiguous = [];
  const unmatched = [];
  for (const row of rows) {
    const incoming = {
      firstName: (row.Player || row.player_name || row.playerName || '').split(' ')[0] || '',
      lastName: (row.Player || row.player_name || row.playerName || '').split(' ').slice(1).join(' ') || '',
    };
    const result = matchPlayerCandidates({ existingPlayers, incoming });
    if (result.outcome === 'matched') {
      matched.push({ row, playerId: result.playerId, name: `${incoming.firstName} ${incoming.lastName}`.trim() });
    } else if (result.outcome === 'ambiguous') {
      ambiguous.push({ row, candidatePlayerIds: result.candidatePlayerIds, name: `${incoming.firstName} ${incoming.lastName}`.trim() });
    } else {
      unmatched.push({ row, name: `${incoming.firstName} ${incoming.lastName}`.trim() });
    }
  }
  return { matched, ambiguous, unmatched };
}

// The core, injectable orchestration loop. Every I/O boundary (discovery,
// per-game collection, the import service itself, cancellation, sleeping)
// is a parameter, so this function is exercised in tests with zero
// Playwright, zero network, and zero real Supabase involvement -- only the
// small CLI-entry block at the bottom of this file wires it to the real
// things.
async function runHighSchoolImportCollection({
  ctx, // { orgId, programId, teamId, seasonId, importRunId, hsTeamLabel }
  importService,
  existingPlayers, // hs_players rows scoped to this org/program: [{id, normalizedFirstName, normalizedLastName}]
  discoverCompletedGames, // async () => [{ sourceGameRef, sourceGameUrl, opponentName, gameDate }]
  collectGame, // async (gameEntry) => gameData { meta:{ourSide,...}, boxScore, plays }
  useEnginePersistence = false,
  isCancelled = () => false,
  // Defaults to the same live env re-check this always did before -- kept
  // as the default so every pre-existing test (which flips
  // process.env.GC_COLLECTION_ENABLED directly and expects this function to
  // react) keeps working unchanged. In production, the CLI entry point at
  // the bottom of this file overrides this with a predicate wired to a
  // real IPC message pushed by the server's kill-switch watchdog
  // (src/high-school-import-routes.js#killSwitchWatchdogTick) -- NOT this
  // process's own frozen process.env, which can never observe a change
  // made to the server's environment after this child was spawned.
  isKillSwitchTriggered = () => !policy.isCollectionEnabled(),
  onProgress = () => {},
  sleep = defaultSleep,
  now = () => Date.now(),
}) {
  const summary = {
    gamesFound: 0,
    gamesImported: 0,
    gamesSkippedDuplicate: 0,
    gamesFailed: 0,
    matchedPlayers: new Map(),
    ambiguousPlayers: new Map(),
    unmatchedPlayers: new Map(),
    stopped: null, // null | 'kill_switch' | 'cancelled' | 'max_games'
  };
  const engineCapturedGames = [];

  if (isKillSwitchTriggered()) {
    summary.stopped = 'kill_switch';
    onProgress({ type: 'stopped', reason: 'kill_switch' });
    await importService.failImportRun({ orgId: ctx.orgId, importRunId: ctx.importRunId, failureStage: 'discovery', rawErrorMessage: 'Automated GameChanger collection is currently disabled.' });
    return summary;
  }

  let entries;
  try {
    entries = await discoverCompletedGames();
  } catch (err) {
    onProgress({ type: 'error', stage: 'discovery', message: policy.sanitizeCollectionErrorMessage(err?.message) });
    await importService.failImportRun({ orgId: ctx.orgId, importRunId: ctx.importRunId, failureStage: 'discovery', rawErrorMessage: err?.message });
    throw err;
  }

  summary.gamesFound = entries.length;
  const maxGames = policy.getMaxGamesPerRun();
  const boundedEntries = entries.slice(0, maxGames);
  const collectionWasTruncated = entries.length > maxGames;
  if (entries.length > maxGames) {
    onProgress({ type: 'info', message: `Found ${entries.length} completed games; processing the first ${maxGames} per this run's game limit.` });
  }

  for (const entry of boundedEntries) {
    if (isCancelled()) {
      summary.stopped = 'cancelled';
      onProgress({ type: 'stopped', reason: 'cancelled' });
      break;
    }
    if (isKillSwitchTriggered()) {
      summary.stopped = 'kill_switch';
      onProgress({ type: 'stopped', reason: 'kill_switch' });
      break;
    }

    let runGame = null;
    if (!useEnginePersistence) {
      ({ row: runGame } = await importService.recordSourceGame({
        orgId: ctx.orgId,
        importRunId: ctx.importRunId,
        sourceGameRef: entry.sourceGameRef,
        sourceGameUrl: entry.sourceGameUrl || null,
        discoveryStatus: 'discovered',
      }));
    }

    let attempt = 0;
    let gameData = null;
    let lastErr = null;
    while (attempt < policy.getRetryCeiling()) {
      attempt += 1;
      try {
        gameData = await collectGame(entry);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const classification = policy.classifyCollectionFailure(err);
        if (classification === policy.ACCESS_CONTROL_CHALLENGE) {
          // Never retry through or bypass an access-control challenge --
          // stop this game (and the whole run, since GameChanger is
          // signaling it wants collection to slow down or stop, not just
          // this one page) safely, preserving everything captured so far.
          onProgress({ type: 'access_control_challenge', game: entry.sourceGameRef, message: policy.sanitizeCollectionErrorMessage(err?.message) });
          if (runGame) await importService.updateSourceGameOutcome({ orgId: ctx.orgId, runGameId: runGame.id, discoveryStatus: 'failed', gameOutcome: 'failed' });
          summary.gamesFailed += 1;
          summary.stopped = 'kill_switch';
          break;
        }
        if (classification === policy.NON_RETRYABLE || attempt >= policy.getRetryCeiling()) {
          break;
        }
        const delay = policy.computeBackoffDelayMs(attempt);
        onProgress({ type: 'retry', game: entry.sourceGameRef, attempt, delayMs: delay });
        await sleep(delay);
        // Checked after every backoff, not just between games -- a long
        // backoff (up to getBackoffMaxMs()) must not be a window during
        // which a cancel or kill-switch signal goes unnoticed.
        if (isCancelled()) { summary.stopped = 'cancelled'; onProgress({ type: 'stopped', reason: 'cancelled' }); break; }
        if (isKillSwitchTriggered()) { summary.stopped = 'kill_switch'; onProgress({ type: 'stopped', reason: 'kill_switch' }); break; }
      }
    }

    if (summary.stopped === 'kill_switch' || summary.stopped === 'cancelled') {
      // This game's own run-game row would otherwise be left at
      // discovery_status 'discovered' forever (never reached an outcome) --
      // close it out honestly rather than leaving a dangling pending row.
      // (gameData is only ever still null here -- a successful collectGame
      // already broke out of the retry loop above before either of the two
      // new interruption checks could run.)
      if (runGame?.id && !gameData) {
        await importService.updateSourceGameOutcome({ orgId: ctx.orgId, runGameId: runGame.id, discoveryStatus: 'failed', gameOutcome: 'failed' });
      }
      break;
    }

    if (!gameData) {
      if (runGame) await importService.updateSourceGameOutcome({ orgId: ctx.orgId, runGameId: runGame.id, discoveryStatus: 'failed', gameOutcome: 'failed' });
      onProgress({ type: 'game_failed', game: entry.sourceGameRef, message: policy.sanitizeCollectionErrorMessage(lastErr?.message) });
      summary.gamesFailed += 1;
      await sleep(policy.getMinRequestDelayMs());
      continue;
    }

    if (useEnginePersistence) {
      const ourSide = gameData.meta?.ourSide;
      const capturedGame = buildCapturedGame(gameData, ourSide, {
        sourceGameRef: entry.sourceGameRef || null,
        sourceGameUrl: entry.sourceGameUrl || null,
        capturedAt: new Date(now()).toISOString(),
      });
      engineCapturedGames.push(capturedGame);
      summary.gamesImported += 1;
      onProgress({ type: 'game_collected', game: entry.sourceGameRef || null });
      await sleep(policy.getMinRequestDelayMs());
      if (isCancelled()) { summary.stopped = 'cancelled'; onProgress({ type: 'stopped', reason: 'cancelled' }); break; }
      if (isKillSwitchTriggered()) { summary.stopped = 'kill_switch'; onProgress({ type: 'stopped', reason: 'kill_switch' }); break; }
      continue;
    }

    const { row: game, created } = await importService.resolveCanonicalGame({
      orgId: ctx.orgId,
      programId: ctx.programId,
      teamId: ctx.teamId,
      seasonId: ctx.seasonId,
      sourceProvider: 'gamechanger',
      sourceGameRef: entry.sourceGameRef,
      opponentName: gameData.meta?.opponentName || entry.opponentName || null,
      gameDate: gameData.meta?.gameDate || entry.gameDate || null,
    });

    if (!created) {
      // Already resolved on a prior run -- this exact game is a duplicate,
      // not a failure. Still updates this run's own game-outcome row so
      // completion accounting is accurate, but does not re-capture a
      // snapshot or re-run validation for it.
      await importService.updateSourceGameOutcome({ orgId: ctx.orgId, runGameId: runGame.id, discoveryStatus: 'skipped', gameOutcome: 'skipped', hsGameId: game.id });
      summary.gamesSkippedDuplicate += 1;
      onProgress({ type: 'game_skipped_duplicate', game: entry.sourceGameRef });
      await sleep(policy.getMinRequestDelayMs());
      continue;
    }

    const ourSide = gameData.meta?.ourSide;
    const capturedGame = buildCapturedGame(gameData, ourSide, {
      sourceGameRef: entry.sourceGameRef,
      sourceGameUrl: entry.sourceGameUrl || null,
      capturedAt: new Date(now()).toISOString(),
    });

    // The box-score snapshot stores the ALREADY-TAGGED capturedGame.boxScore
    // (isHighSchoolTeam already resolved), not the raw untagged scrape --
    // this is the exact, complete shape a later publish needs to safely
    // recompute the same aggregate from persisted provenance rather than a
    // fresh scrape, satisfying "publish the exact reviewed server-side
    // import" without inventing a second, parallel storage location for
    // side-attribution. It remains within the licensed statistical scope:
    // the only field added beyond the raw scrape is a derived boolean.
    await importService.captureSnapshot({
      orgId: ctx.orgId,
      importRunId: ctx.importRunId,
      importRunGameId: runGame.id,
      hsGameId: game.id,
      snapshotKind: 'box_score',
      sourceProvider: 'gamechanger',
      sourceRef: entry.sourceGameRef,
      payload: capturedGame.boxScore,
    });
    await importService.captureSnapshot({
      orgId: ctx.orgId,
      importRunId: ctx.importRunId,
      importRunGameId: runGame.id,
      hsGameId: game.id,
      snapshotKind: 'play_by_play',
      sourceProvider: 'gamechanger',
      sourceRef: entry.sourceGameRef,
      payload: { plays: capturedGame.plays },
    });

    const { row: validation } = await importService.recordGameValidation({
      orgId: ctx.orgId,
      importRunId: ctx.importRunId,
      importRunGameId: runGame.id,
      hsGameId: game.id,
      teamId: ctx.teamId,
      capturedGame,
    });

    const ourRows = [...capturedGame.boxScore.batting, ...capturedGame.boxScore.pitching].filter((r) => r.isHighSchoolTeam);
    const reconciliation = reconcilePlayers(ourRows, existingPlayers);
    for (const m of reconciliation.matched) summary.matchedPlayers.set(m.playerId, m.name);
    for (const a of reconciliation.ambiguous) summary.ambiguousPlayers.set(a.name, a.candidatePlayerIds);
    for (const u of reconciliation.unmatched) summary.unmatchedPlayers.set(u.name, true);

    // Reconciliation outcomes are persisted onto this run-game's own
    // diagnostics column (already designed for exactly this purpose by the
    // Slice 1A persistence layer) rather than kept only in this
    // process's memory, so a coach reviewing the run minutes (or days)
    // later, from a fresh HTTP request against a since-restarted server,
    // can still see per-game matched/ambiguous/unmatched player detail.
    await importService.updateSourceGameOutcome({
      orgId: ctx.orgId,
      runGameId: runGame.id,
      discoveryStatus: 'processed',
      gameOutcome: 'inserted',
      hsGameId: game.id,
      diagnostics: {
        reconciliation: {
          matched: reconciliation.matched.map((m) => ({ playerId: m.playerId, name: m.name })),
          ambiguous: reconciliation.ambiguous.map((a) => ({ name: a.name, candidatePlayerIds: a.candidatePlayerIds })),
          unmatched: reconciliation.unmatched.map((u) => ({ name: u.name })),
        },
      },
    });

    summary.gamesImported += 1;
    onProgress({ type: 'game_imported', game: entry.sourceGameRef, validationStatus: validation.validation_status, confidence: validation.confidence });

    await sleep(policy.getMinRequestDelayMs());
    // Checked once more, right before the loop would begin a new source
    // request for the next game -- no additional request is ever made
    // after a stop has been observed.
    if (isCancelled()) { summary.stopped = 'cancelled'; onProgress({ type: 'stopped', reason: 'cancelled' }); break; }
    if (isKillSwitchTriggered()) { summary.stopped = 'kill_switch'; onProgress({ type: 'stopped', reason: 'kill_switch' }); break; }
  }

  // An interrupted run (kill switch or user cancel) is never marked
  // succeeded, even if every game actually attempted before the stop
  // happened to succeed -- completeImportRun only knows about games that
  // were actually recorded, so without this branch a run stopped after,
  // say, 2 of 5 discovered games (both successful) would silently report
  // 'succeeded' instead of reflecting that it never finished. Already-
  // captured games/snapshots are untouched either way -- only this run's
  // own terminal status is affected.
  if (summary.stopped === 'kill_switch' || summary.stopped === 'cancelled') {
    await importService.failImportRun({
      orgId: ctx.orgId,
      importRunId: ctx.importRunId,
      failureStage: 'discovery',
      rawErrorMessage: summary.stopped === 'kill_switch'
        ? 'Automated GameChanger collection was disabled while this run was in progress.'
        : 'Cancelled by user.',
    });
  } else if (useEnginePersistence) {
    if (collectionWasTruncated || summary.gamesFailed > 0 || engineCapturedGames.length !== boundedEntries.length) {
      await importService.failImportRun({
        orgId: ctx.orgId,
        importRunId: ctx.importRunId,
        failureStage: 'aggregation',
        rawErrorMessage: 'The complete engine collection was not available; no partial generation was published.',
      });
    } else {
      const published = await importService.persistEngineCollection({
        context: {
          orgId: ctx.orgId,
          programId: ctx.programId,
          teamId: ctx.teamId,
          seasonId: ctx.seasonId,
          importRunId: ctx.importRunId,
          sourceProvider: 'gamechanger',
        },
        capturedGames: engineCapturedGames,
        rosterMemberships: existingPlayers,
      });
      summary.generationId = published.generation?.id || null;
      summary.payloadBytes = published.payloadBytes;
      summary.inputSetHash = published.inputSetHash;
    }
  } else {
    await importService.completeImportRun({ orgId: ctx.orgId, importRunId: ctx.importRunId });
  }
  onProgress({ type: 'complete', summary: summarizeForLog(summary) });
  return summary;
}

// Sanitized, log-safe summary -- Map objects don't serialize meaningfully
// through JSON.stringify, and full row/candidate detail is not appropriate
// for a job log line.
function summarizeForLog(summary) {
  return {
    gamesFound: summary.gamesFound,
    gamesImported: summary.gamesImported,
    gamesSkippedDuplicate: summary.gamesSkippedDuplicate,
    gamesFailed: summary.gamesFailed,
    matchedPlayerCount: summary.matchedPlayers.size,
    ambiguousPlayerCount: summary.ambiguousPlayers.size,
    unmatchedPlayerCount: summary.unmatchedPlayers.size,
    stopped: summary.stopped,
    generationId: summary.generationId || null,
    payloadBytes: summary.payloadBytes || null,
  };
}

// Idempotent cleanup for the CLI entry point's browser instance --
// extracted as its own directly-testable function (rather than left as an
// inline closure only reachable by actually spawning the real CLI
// subprocess) so its idempotency and error-swallowing behavior can be
// proven with a fake browser double, independent of Playwright/Chromium
// ever being involved. `getBrowser` is a function (not a value) because
// the CLI's own `browser` variable is reassigned once chromium.launch()
// resolves, and cleanup can legitimately be invoked (via SIGTERM/SIGINT)
// before that assignment ever happens.
function createIdempotentBrowserCleanup(getBrowser) {
  let cleanedUp = false;
  return async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    const browser = getBrowser();
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already closed, or never fully finished opening -- cleanup must
           never itself throw, or it could mask the original error on
           whichever exit path triggered it. */
      }
    }
  };
}

module.exports = {
  runHighSchoolImportCollection,
  tagRowsWithOwnership,
  buildCapturedGame,
  reconcilePlayers,
  summarizeForLog,
  createIdempotentBrowserCleanup,
};

// ── CLI entry point: wires the injectable loop above to the real
// Playwright collector, the real Supabase-backed import service, and the
// real authorized gamechanger-auth.json session -- spawned as a child
// process by src/high-school-import-routes.js, mirroring exactly how
// server.js spawns src/search-gamechanger-teams.js for Travel's own
// /api/run/gc-scraper. Using an authenticated GameChanger session for this
// licensed collector is authorized and expected; everything below is about
// handling that session safely, not about avoiding it. ──
if (require.main === module) {
  (async () => {
    const { chromium } = require('playwright');
    const { createClient } = require('@supabase/supabase-js');
    const { createHighSchoolImportRepository } = require('./high-school-import-repository');
    const { createHighSchoolImportService } = require('./high-school-import-service');
    const scraper = require('./search-gamechanger-teams');
    const sessionLoader = require('./gc-session-loader');

    const ctx = {
      orgId: process.env.HS_IMPORT_ORG_ID,
      programId: process.env.HS_IMPORT_PROGRAM_ID,
      teamId: process.env.HS_IMPORT_TEAM_ID,
      seasonId: process.env.HS_IMPORT_SEASON_ID,
      importRunId: process.env.HS_IMPORT_RUN_ID,
      hsTeamLabel: process.env.HS_IMPORT_TEAM_LABEL || 'High School Team',
    };
    const gcTeamUrl = process.env.HS_IMPORT_GC_TEAM_URL;
    let existingPlayers = [];
    try {
      existingPlayers = JSON.parse(process.env.HS_IMPORT_EXISTING_PLAYERS_JSON || '[]');
    } catch {
      existingPlayers = [];
    }

    const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const repository = createHighSchoolImportRepository(adminClient);
    const importService = createHighSchoolImportService({ repository });

    // Security Slice T3H: collectGame() below calls straight into
    // search-gamechanger-teams.js#extractGameData(), the same shared
    // DOM-extraction function Travel's own scraper uses -- including its
    // internal getTeamOutputDir() call, which now requires that module's
    // own trusted org-id state to be set first (see setCurrentJobOrgId()
    // in that file). ctx.orgId already comes from
    // src/high-school-import-routes.js's req._orgId (the same
    // server-resolved, authenticated-route value every other High School
    // import operation trusts) -- never from this process's own argv or
    // any value a caller of this spawned process could otherwise control.
    // Re-validated here, independently, before any browser/session work,
    // so a malformed value fails closed instead of surfacing as the
    // generic "organization context was established" internal error deep
    // inside extractGameData().
    if (!isValidUuid(ctx.orgId)) {
      console.error('[hs-gc-import] HS_IMPORT_ORG_ID is not a valid organization id. Refusing to run.');
      await markRunFailedSafely('Invalid organization context.');
      return;
    }
    scraper.setCurrentJobOrgId(ctx.orgId);

    // A fatal error at ANY point below -- before or after the browser ever
    // launches -- must still leave this run in a terminal (not stuck
    // 'running' forever) state. Wrapped in its own try/catch so a SECOND
    // failure here (e.g. Supabase itself unreachable) can never crash the
    // process ungracefully or mask the original error.
    async function markRunFailedSafely(rawErrorMessage) {
      try {
        await importService.failImportRun({ orgId: ctx.orgId, importRunId: ctx.importRunId, failureStage: 'discovery', rawErrorMessage });
      } catch (markErr) {
        console.error('[hs-gc-import] failed to mark run as failed:', policy.sanitizeCollectionErrorMessage(markErr?.message));
      }
    }

    // Registered before anything else so a message sent the instant this
    // process is spawned (or arriving while the browser is still starting)
    // is never missed.
    let cancelled = false;
    let killSwitchTriggered = false;
    process.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'cancel') cancelled = true;
      if (msg.type === 'kill_switch_disabled') killSwitchTriggered = true;
    });
    const isCancelled = () => cancelled;
    const isKillSwitchTriggered = () => killSwitchTriggered || !policy.isCollectionEnabled();

    // Checked before loading any session material or launching a browser
    // at all -- the server already checked this immediately before
    // spawning, but re-checking here closes the (small, honest) race where
    // the switch was disabled in the moment between that check and this
    // process actually starting to run.
    if (isKillSwitchTriggered()) {
      console.log('[hs-gc-import] kill switch disabled before launch; not loading session material or starting a browser.');
      await markRunFailedSafely('Automated GameChanger collection is currently disabled.');
      return;
    }

    let browser = null;
    // Normal completion, cancellation, kill-switch shutdown, a startup
    // failure after launch, and a signal can all race to trigger this;
    // createIdempotentBrowserCleanup guarantees only the first one actually
    // closes anything.
    const cleanup = createIdempotentBrowserCleanup(() => browser);
    process.on('SIGTERM', () => { cleanup().finally(() => process.exit(0)); });
    process.on('SIGINT', () => { cleanup().finally(() => process.exit(0)); });

    try {
      browser = await chromium.launch({ headless: true });

      if (isCancelled() || isKillSwitchTriggered()) {
        await markRunFailedSafely(isCancelled() ? 'Cancelled by user.' : 'Automated GameChanger collection was disabled while this run was starting.');
        return;
      }

      // Validate the session file's existence/readability/shape BEFORE
      // handing it to Playwright -- fails safely, with a fixed generic
      // message, on a missing/unreadable/malformed/empty file rather than
      // surfacing whatever raw error Playwright happens to throw.
      const storageStatePath = sessionLoader.getStorageStatePath();
      sessionLoader.validateStorageStateFile(storageStatePath);

      const context = await browser.newContext({ storageState: storageStatePath });
      const page = await context.newPage();
      page.setDefaultTimeout(policy.getRequestTimeoutMs());

      if (isCancelled() || isKillSwitchTriggered()) {
        await markRunFailedSafely(isCancelled() ? 'Cancelled by user.' : 'Automated GameChanger collection was disabled while this run was starting.');
        return;
      }

      await page.goto(scraper.normalizeTeamUrl(gcTeamUrl.replace(/\/schedule.*$/, '') + '/schedule'));

      // A well-formed session file that has actually expired or been
      // revoked is only detectable once GameChanger itself rejects it --
      // it redirects to a login page rather than returning an error
      // status, so this is a landed-URL check, not a status-code check.
      // Never surfaces the landed URL itself (it can carry query-string
      // tokens) in any message.
      sessionLoader.assertLandedOnAuthenticatedGameChangerPage(page.url());

      const discoverCompletedGames = async () => {
        const entries = await scraper.getVisibleCompletedGameEntries(page);
        return entries.map((e) => ({
          sourceGameRef: e.gameId || null,
          sourceGameUrl: e.href,
          opponentName: e.opponentName || null,
          gameDate: e.gameDate || null,
        }));
      };

      const collectGame = async (entry) => {
        await page.goto(entry.sourceGameUrl);
        const result = await scraper.extractGameData(page, { teamName: ctx.hsTeamLabel }, entry);
        if (!result?.success) throw new Error('Collection failed for this game.');
        return result.gameData;
      };

      await runHighSchoolImportCollection({
        ctx,
        importService,
        existingPlayers,
        discoverCompletedGames,
        collectGame,
        useEnginePersistence: process.env.HS_IMPORT_ENGINE_PERSISTENCE_ENABLED === '1',
        isCancelled,
        isKillSwitchTriggered,
        onProgress: (event) => {
          console.log(`[hs-gc-import] ${JSON.stringify(event)}`);
        },
      });
    } catch (err) {
      console.error('[hs-gc-import] fatal:', policy.sanitizeCollectionErrorMessage(err?.message));
      await markRunFailedSafely(err instanceof sessionLoader.SessionValidationError ? err.message : (err?.message || 'Collection failed.'));
      process.exitCode = 1;
    } finally {
      await cleanup();
    }
  })();
}
