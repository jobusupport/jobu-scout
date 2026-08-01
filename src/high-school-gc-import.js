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

function buildCapturedGame(gameData, ourSide) {
  const boxScore = gameData?.boxScore || {};
  return {
    boxScore: {
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
  isCancelled = () => false,
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

  if (!policy.isCollectionEnabled()) {
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
  if (entries.length > maxGames) {
    onProgress({ type: 'info', message: `Found ${entries.length} completed games; processing the first ${maxGames} per this run's game limit.` });
  }

  for (const entry of boundedEntries) {
    if (isCancelled()) {
      summary.stopped = 'cancelled';
      onProgress({ type: 'stopped', reason: 'cancelled' });
      break;
    }
    if (!policy.isCollectionEnabled()) {
      summary.stopped = 'kill_switch';
      onProgress({ type: 'stopped', reason: 'kill_switch' });
      break;
    }

    const { row: runGame } = await importService.recordSourceGame({
      orgId: ctx.orgId,
      importRunId: ctx.importRunId,
      sourceGameRef: entry.sourceGameRef,
      sourceGameUrl: entry.sourceGameUrl || null,
      discoveryStatus: 'discovered',
    });

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
          await importService.updateSourceGameOutcome({ orgId: ctx.orgId, runGameId: runGame.id, discoveryStatus: 'failed', gameOutcome: 'failed' });
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
      }
    }

    if (summary.stopped === 'kill_switch') break;

    if (!gameData) {
      await importService.updateSourceGameOutcome({ orgId: ctx.orgId, runGameId: runGame.id, discoveryStatus: 'failed', gameOutcome: 'failed' });
      onProgress({ type: 'game_failed', game: entry.sourceGameRef, message: policy.sanitizeCollectionErrorMessage(lastErr?.message) });
      summary.gamesFailed += 1;
      await sleep(policy.getMinRequestDelayMs());
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

    const ourSide = gameData.meta?.ourSide || 'home';
    const capturedGame = buildCapturedGame(gameData, ourSide);

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
  }

  await importService.completeImportRun({ orgId: ctx.orgId, importRunId: ctx.importRunId });
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
  };
}

module.exports = {
  runHighSchoolImportCollection,
  tagRowsWithOwnership,
  buildCapturedGame,
  reconcilePlayers,
  summarizeForLog,
};

// ── CLI entry point: wires the injectable loop above to the real
// Playwright collector, the real Supabase-backed import service, and the
// real gamechanger-auth.json session -- spawned as a child process by
// src/high-school-import-routes.js, mirroring exactly how server.js spawns
// src/search-gamechanger-teams.js for Travel's own /api/run/gc-scraper. ──
if (require.main === module) {
  (async () => {
    const path = require('path');
    const { chromium } = require('playwright');
    const { createClient } = require('@supabase/supabase-js');
    const { createHighSchoolImportRepository } = require('./high-school-import-repository');
    const { createHighSchoolImportService } = require('./high-school-import-service');
    const scraper = require('./search-gamechanger-teams');

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

    const STORAGE_STATE = path.join(__dirname, '..', 'storage', 'gamechanger-auth.json');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await context.newPage();
    page.setDefaultTimeout(policy.getRequestTimeoutMs());

    let cancelled = false;
    process.on('message', (msg) => {
      if (msg === 'cancel') cancelled = true;
    });

    try {
      await page.goto(scraper.normalizeTeamUrl(gcTeamUrl.replace(/\/schedule.*$/, '') + '/schedule'));

      const discoverCompletedGames = async () => {
        const entries = await scraper.getVisibleCompletedGameEntries(page);
        return entries.map((e) => ({
          sourceGameRef: e.gameId || e.href,
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
        isCancelled: () => cancelled,
        onProgress: (event) => {
          console.log(`[hs-gc-import] ${JSON.stringify(event)}`);
        },
      });
    } catch (err) {
      console.error('[hs-gc-import] fatal:', policy.sanitizeCollectionErrorMessage(err?.message));
      process.exitCode = 1;
    } finally {
      await browser.close();
    }
  })();
}
