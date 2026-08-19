'use strict';

// High School Slice 2D opponent-game collection adapter.
//
// Sibling of src/high-school-gc-import.js (own-team collection), deliberately
// factored the same way and reusing the same pieces rather than duplicating
// them:
//
//   * src/gc-collection-policy.js supplies the kill switch, rate limiting,
//     retry/backoff, failure classification and error sanitisation. None of
//     that is reimplemented here.
//   * DOM extraction stays in src/search-gamechanger-teams.js and is reached
//     through the injected `discoverScheduleEntries` / `collectGame` seam. This
//     module contains no selectors and no scraping. That module gained a second
//     explicit extraction mode for opponent monitoring
//     (SCHEDULE_EXTRACTION_MODES.ALL_SCHEDULE_ENTRIES); its existing
//     completed-games-only path is untouched and still serves Travel and
//     own-team import.
//   * Reconstruction and statistics go through the import service's
//     ingestOpponentGameCollection, which uses the characterized Slice 2B
//     engine. There is no second statistics algorithm here.
//
// What is genuinely different from the own-team collector: the subject is a
// monitored hs_opponent_teams row rather than one of our own teams, there is no
// roster reconciliation (opponent players stay noncanonical -- HS 2F's job), and
// a schedule may legitimately contain games that have not been played yet.
//
// ── The completeness contract ────────────────────────────────────────────
// A partially collected schedule must never be published. If discovery finds
// five completed games and only four can be captured, publishing the four would
// silently look like "this opponent played four games", and -- worse -- would
// replace a previously verified generation that had all five. So a failure to
// capture ANY discovered completed game fails the whole run closed, before the
// publication boundary is touched. The database enforces the same rule
// independently (see the completeness-regression gate in
// 20260819031729_add_hs_opponent_publication_state_and_regression_gate.sql).

const policy = require('./gc-collection-policy');
const { OPPONENT_INGEST_STATES } = require('./high-school-import-service');

const FINAL_STATUS = 'final';
const COLLECTABLE_STATUSES = new Set([FINAL_STATUS]);
const KNOWN_STATUSES = new Set([
  'scheduled', 'in_progress', 'final', 'postponed', 'cancelled', 'suspended', 'unknown',
]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(value) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return 'unknown';
  return KNOWN_STATUSES.has(raw) ? raw : 'unknown';
}

// A game the source has not played yet still belongs in the schedule, but it has
// no box score and no plays. It is recorded as an observation so the schedule is
// preserved, and contributes nothing to statistics.
function buildScheduleOnlyCapturedGame(entry, capturedAt) {
  return {
    meta: {
      gameDate: entry.gameDate || null,
      homeTeam: entry.counterpartyName || null,
      awayTeam: entry.counterpartyName || null,
      ourSide: 'home',
      gameStatus: entry.gameStatus,
      capturedAt,
      ...(entry.startTime ? { startTime: entry.startTime } : {}),
      ...(entry.venue ? { venue: entry.venue } : {}),
      ...(Number.isFinite(entry.gameNumber) ? { gameNumber: entry.gameNumber } : {}),
      ...(entry.sourceGameRef ? { sourceGameId: entry.sourceGameRef } : {}),
      ...(entry.sourceGameUrl ? { sourceGameUrl: entry.sourceGameUrl } : {}),
    },
    boxScore: { batting: [], pitching: [] },
    plays: [],
  };
}

// Mirrors high-school-gc-import.js#buildCapturedGame, but tags rows against the
// MONITORED OPPONENT's side rather than one of our own teams. As there, the
// ownership boolean is derived here from the already-resolved side and is never
// trusted from the scraped row.
function buildOpponentCapturedGame(gameData, entry, capturedAt) {
  const side = gameData?.meta?.ourSide;
  if (side !== 'home' && side !== 'away') {
    const err = new Error('Collected opponent game requires an explicit subject side of home or away.');
    err.code = 'MISSING_TEAM_OWNED_SIDE';
    throw err;
  }
  const tag = (rows) => (rows || []).map((row) => ({
    ...row,
    isHighSchoolTeam: (row.TeamSide || row.teamSide) === side,
    own: (row.TeamSide || row.teamSide) === side,
  }));
  const boxScore = gameData?.boxScore || {};
  return {
    meta: {
      ...(gameData?.meta || {}),
      ourSide: side,
      gameStatus: entry.gameStatus,
      capturedAt,
      ...(entry.startTime ? { startTime: entry.startTime } : {}),
      ...(entry.venue ? { venue: entry.venue } : {}),
      ...(Number.isFinite(entry.gameNumber) ? { gameNumber: entry.gameNumber } : {}),
      ...(entry.sourceGameRef ? { sourceGameId: entry.sourceGameRef } : {}),
      ...(entry.sourceGameUrl ? { sourceGameUrl: entry.sourceGameUrl } : {}),
    },
    boxScore: {
      ...boxScore,
      batting: tag(boxScore.batting),
      pitching: tag(boxScore.pitching),
    },
    plays: gameData?.plays || [],
  };
}

// Normalizes one row from the shared schedule extractor into the entry shape
// this adapter consumes. Nothing is invented: a field the source did not
// express stays null, and the extractor's own status classification is carried
// through rather than re-derived here.
//
// startTime, venue and gameNumber are carried because they are the deterministic
// discriminators the identity layer uses to keep two same-day games apart when
// the source supplies no distinct upstream id. visibleIndex is deliberately NOT
// carried: DOM row order is provenance, never canonical identity.
function toOpponentScheduleEntry(row) {
  return {
    sourceGameRef: row.gameId || null,
    sourceGameUrl: row.href || null,
    counterpartyName: row.counterpartyName || null,
    gameDate: row.gameDate || null,
    gameStatus: normalizeStatus(row.status),
    startTime: row.scheduledTimeText || null,
    timezoneKnown: row.timezoneKnown === true,
    homeAway: row.homeAway || null,
    venue: row.venue || null,
    gameNumber: Number.isFinite(row.gameNumber) ? row.gameNumber : null,
    rawStatusText: row.rawStatusText || null,
  };
}

function summarizeForLog(summary) {
  return {
    state: summary.state,
    gamesDiscovered: summary.gamesDiscovered,
    finalGamesDiscovered: summary.finalGamesDiscovered,
    gamesCaptured: summary.gamesCaptured,
    gamesFailed: summary.gamesFailed,
    scheduleCaptured: summary.scheduleCaptured,
    eligibleForVerifiedPublication: summary.eligibleForVerifiedPublication,
    verifiedGenerationPublished: summary.verifiedGenerationPublished,
    priorVerifiedGenerationPreserved: summary.priorVerifiedGenerationPreserved,
    manualReconciliationRequired: summary.manualReconciliationRequired,
    generationId: summary.generationId || null,
    publicationState: summary.publicationState || null,
    stopped: summary.stopped,
  };
}

async function runOpponentImportCollection({
  ctx, // { orgId, programId, opponentTeamId, seasonId, opponentImportRunId, opponentLabel }
  importService,
  discoverScheduleEntries, // async () => [{ sourceGameRef, sourceGameUrl, counterpartyName, gameDate, gameStatus }]
  collectGame, // async (entry) => gameData { meta:{ourSide,...}, boxScore, plays }
  isCancelled = () => false,
  isKillSwitchTriggered = () => !policy.isCollectionEnabled(),
  onProgress = () => {},
  sleep = defaultSleep,
  now = () => Date.now(),
}) {
  const summary = {
    state: OPPONENT_INGEST_STATES.FAILED,
    gamesDiscovered: 0,
    finalGamesDiscovered: 0,
    gamesCaptured: 0,
    gamesFailed: 0,
    scheduleCaptured: false,
    eligibleForVerifiedPublication: false,
    verifiedGenerationPublished: false,
    priorVerifiedGenerationPreserved: false,
    manualReconciliationRequired: false,
    generationId: null,
    publicationState: null,
    stopped: null,
    failureReason: null,
  };

  const failRun = async (stage, message) => {
    try {
      await importService.failOpponentImportRun({
        orgId: ctx.orgId,
        opponentImportRunId: ctx.opponentImportRunId,
        failureStage: stage,
        errorSummary: policy.sanitizeCollectionErrorMessage(message),
      });
    } catch { /* the run row may already be gone; never mask the original failure */ }
  };

  if (isKillSwitchTriggered()) {
    summary.stopped = 'kill_switch';
    summary.failureReason = 'collection_disabled';
    onProgress({ type: 'stopped', reason: 'kill_switch' });
    await failRun('discovery', 'Automated GameChanger collection is currently disabled.');
    return summary;
  }

  let entries;
  try {
    entries = await discoverScheduleEntries();
  } catch (err) {
    summary.failureReason = 'discovery_failed';
    onProgress({ type: 'error', stage: 'discovery', message: policy.sanitizeCollectionErrorMessage(err?.message) });
    await failRun('discovery', err?.message);
    return summary;
  }

  const normalized = (Array.isArray(entries) ? entries : []).map((entry) => ({
    sourceGameRef: entry?.sourceGameRef || null,
    sourceGameUrl: entry?.sourceGameUrl || null,
    counterpartyName: entry?.counterpartyName || entry?.opponentName || null,
    gameDate: entry?.gameDate || null,
    gameStatus: normalizeStatus(entry?.gameStatus),
    // Deterministic discriminators for two same-day games that share an
    // opponent and carry no distinct upstream id. Absent evidence stays absent,
    // which is what leaves such a pair ambiguous rather than merged.
    startTime: entry?.startTime || null,
    venue: entry?.venue || null,
    gameNumber: Number.isFinite(entry?.gameNumber) ? entry.gameNumber : null,
    homeAway: entry?.homeAway || null,
    rawStatusText: entry?.rawStatusText || null,
  }));
  summary.gamesDiscovered = normalized.length;
  summary.finalGamesDiscovered = normalized.filter((e) => COLLECTABLE_STATUSES.has(e.gameStatus)).length;
  onProgress({ type: 'discovered', count: summary.gamesDiscovered, finals: summary.finalGamesDiscovered });

  const capturedGames = [];
  for (const entry of normalized) {
    if (isCancelled()) { summary.stopped = 'cancelled'; onProgress({ type: 'stopped', reason: 'cancelled' }); break; }
    if (isKillSwitchTriggered()) { summary.stopped = 'kill_switch'; onProgress({ type: 'stopped', reason: 'kill_switch' }); break; }

    const capturedAt = new Date(now()).toISOString();

    if (!COLLECTABLE_STATUSES.has(entry.gameStatus)) {
      capturedGames.push(buildScheduleOnlyCapturedGame(entry, capturedAt));
      onProgress({ type: 'schedule_entry', game: entry.sourceGameRef, status: entry.gameStatus });
      continue;
    }

    let gameData = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= policy.getRetryCeiling(); attempt += 1) {
      try {
        gameData = await collectGame(entry);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const classification = policy.classifyCollectionFailure(err);
        if (classification === policy.ACCESS_CONTROL_CHALLENGE) {
          // Never retry through or bypass an access-control challenge.
          onProgress({ type: 'access_control_challenge', game: entry.sourceGameRef, message: policy.sanitizeCollectionErrorMessage(err?.message) });
          summary.stopped = 'kill_switch';
          break;
        }
        if (classification === policy.NON_RETRYABLE || attempt >= policy.getRetryCeiling()) break;
        const delay = policy.computeBackoffDelayMs(attempt);
        onProgress({ type: 'retry', game: entry.sourceGameRef, attempt, delayMs: delay });
        await sleep(delay);
        if (isCancelled()) { summary.stopped = 'cancelled'; break; }
        if (isKillSwitchTriggered()) { summary.stopped = 'kill_switch'; break; }
      }
    }

    if (summary.stopped) break;

    if (!gameData) {
      summary.gamesFailed += 1;
      onProgress({ type: 'game_failed', game: entry.sourceGameRef, message: policy.sanitizeCollectionErrorMessage(lastErr?.message) });
      break;
    }

    try {
      capturedGames.push(buildOpponentCapturedGame(gameData, entry, capturedAt));
    } catch (err) {
      summary.gamesFailed += 1;
      onProgress({ type: 'game_failed', game: entry.sourceGameRef, message: policy.sanitizeCollectionErrorMessage(err?.message) });
      break;
    }
    summary.gamesCaptured += 1;
    onProgress({ type: 'game_collected', game: entry.sourceGameRef });
    await sleep(policy.getMinRequestDelayMs());
  }

  // An interrupted or partial collection is never published. Publishing a
  // subset would understate the opponent's season and could retire a
  // previously verified generation that was complete.
  if (summary.stopped) {
    summary.failureReason = summary.stopped === 'cancelled' ? 'cancelled' : 'collection_disabled';
    await failRun('discovery', summary.stopped === 'cancelled'
      ? 'Cancelled by user.'
      : 'Automated GameChanger collection was disabled while this run was in progress.');
    return summary;
  }
  if (summary.gamesFailed > 0 || summary.gamesCaptured !== summary.finalGamesDiscovered) {
    summary.failureReason = 'incomplete_collection';
    summary.manualReconciliationRequired = true;
    onProgress({ type: 'incomplete', captured: summary.gamesCaptured, expected: summary.finalGamesDiscovered });
    await failRun('aggregation', 'The complete opponent collection was not available; no generation was published.');
    return summary;
  }

  summary.scheduleCaptured = true;
  summary.eligibleForVerifiedPublication = summary.finalGamesDiscovered > 0;
  summary.state = OPPONENT_INGEST_STATES.CAPTURED;

  let published;
  try {
    published = await importService.ingestOpponentGameCollection({
      orgId: ctx.orgId,
      programId: ctx.programId,
      seasonId: ctx.seasonId,
      opponentTeamId: ctx.opponentTeamId,
      opponentImportRunId: ctx.opponentImportRunId,
      capturedGames,
    });
  } catch (err) {
    summary.state = OPPONENT_INGEST_STATES.FAILED;
    summary.failureReason = err?.code || 'publication_failed';
    // Every publication failure path is atomic, so whatever verified
    // generation existed before is still the current one.
    summary.priorVerifiedGenerationPreserved = true;
    summary.manualReconciliationRequired = err?.code === 'OPPONENT_COMPLETENESS_REGRESSION'
      || err?.code === 'OPPONENT_IDENTITY_UNRESOLVED'
      || err?.code === 'OPPONENT_SOURCE_LINK_NOT_LINKED';
    onProgress({ type: 'publication_failed', code: summary.failureReason });
    await failRun('publication', err?.message);
    return summary;
  }

  summary.state = published.state;
  summary.publicationState = published.publicationState;
  summary.generationId = published.generation?.id || null;
  summary.verifiedGenerationPublished = published.verifiedGenerationPublished === true;
  summary.finalGameCount = published.finalGameCount;
  onProgress({ type: 'complete', summary: summarizeForLog(summary) });
  return summary;
}

module.exports = {
  runOpponentImportCollection,
  toOpponentScheduleEntry,
  buildOpponentCapturedGame,
  buildScheduleOnlyCapturedGame,
  normalizeStatus,
  summarizeForLog,
  OPPONENT_INGEST_STATES,
};

// ── CLI entry point ────────────────────────────────────────────────────
//
// Wires the injectable loop above to the real Playwright collector, the real
// Supabase-backed import service, and the real authorized GameChanger session --
// spawned as a child process by src/high-school-import-routes.js, mirroring
// exactly how that module already spawns src/high-school-gc-import.js for the
// own-team importer. Every DOM function used here comes from
// src/search-gamechanger-teams.js unchanged; nothing is scraped in this file.
if (require.main === module) {
  (async () => {
    const { chromium } = require('playwright');
    const { createClient } = require('@supabase/supabase-js');
    const { createHighSchoolImportRepository } = require('./high-school-import-repository');
    const { createHighSchoolImportService } = require('./high-school-import-service');
    const scraper = require('./search-gamechanger-teams');
    const sessionLoader = require('./gc-session-loader');

    const ctx = {
      orgId: process.env.HS_OPP_IMPORT_ORG_ID,
      programId: process.env.HS_OPP_IMPORT_PROGRAM_ID,
      opponentTeamId: process.env.HS_OPP_IMPORT_OPPONENT_TEAM_ID,
      seasonId: process.env.HS_OPP_IMPORT_SEASON_ID,
      opponentImportRunId: process.env.HS_OPP_IMPORT_RUN_ID,
      opponentLabel: process.env.HS_OPP_IMPORT_OPPONENT_LABEL || null,
    };
    const sourceTeamUrl = process.env.HS_OPP_IMPORT_SOURCE_TEAM_URL;

    const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const repository = createHighSchoolImportRepository(adminClient);
    const importService = createHighSchoolImportService({ repository });

    const markRunFailedSafely = async (message) => {
      try {
        await importService.failOpponentImportRun({
          orgId: ctx.orgId,
          opponentImportRunId: ctx.opponentImportRunId,
          failureStage: 'discovery',
          errorSummary: policy.sanitizeCollectionErrorMessage(message),
        });
      } catch { /* never mask the original failure */ }
    };

    // A cancel message pushed by the server's job machinery, and the
    // kill-switch signal it forwards, are both observed here rather than by
    // polling this child's own frozen copy of process.env.
    let cancelled = false;
    let killSwitchOff = false;
    process.on('message', (message) => {
      if (message?.type === 'cancel') cancelled = true;
      if (message?.type === 'kill_switch_disabled') killSwitchOff = true;
    });
    const isCancelled = () => cancelled;
    const isKillSwitchTriggered = () => killSwitchOff || !policy.isCollectionEnabled();

    let browser = null;
    try {
      if (!sourceTeamUrl) throw new Error('No linked GameChanger source team URL was supplied.');
      if (isKillSwitchTriggered()) {
        await markRunFailedSafely('Automated GameChanger collection is currently disabled.');
        return;
      }

      const storageStatePath = sessionLoader.getStorageStatePath();
      sessionLoader.validateStorageStateFile(storageStatePath);

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ storageState: storageStatePath });
      const page = await context.newPage();
      page.setDefaultTimeout(policy.getRequestTimeoutMs());

      await page.goto(scraper.normalizeTeamUrl(String(sourceTeamUrl).replace(/\/schedule.*$/, '') + '/schedule'));
      sessionLoader.assertLandedOnAuthenticatedGameChangerPage(page.url());

      // Opponent monitoring needs the WHOLE schedule -- a future game, a
      // postponement, a cancellation and a doubleheader entry all matter before
      // either half is final -- so the shared extractor is asked explicitly for
      // every schedule row rather than completed games only. Own-team import
      // continues to ask for COMPLETED_ONLY and is unaffected.
      const discoverScheduleEntries = async () => {
        const entries = await scraper.getVisibleScheduleEntries(page, {
          mode: scraper.SCHEDULE_EXTRACTION_MODES.ALL_SCHEDULE_ENTRIES,
        });
        return entries.map(toOpponentScheduleEntry);
      };

      const collectGame = async (entry) => {
        await page.goto(entry.sourceGameUrl);
        const result = await scraper.extractGameData(page, { teamName: ctx.opponentLabel }, entry);
        if (!result?.success) throw new Error('Collection failed for this opponent game.');
        return result.gameData;
      };

      const summary = await runOpponentImportCollection({
        ctx,
        importService,
        discoverScheduleEntries,
        collectGame,
        isCancelled,
        isKillSwitchTriggered,
        onProgress: (event) => console.log(`[hs-opponent-gc-import] ${JSON.stringify(event)}`),
      });
      if (summary.state === OPPONENT_INGEST_STATES.FAILED) process.exitCode = 1;
    } catch (err) {
      console.error('[hs-opponent-gc-import] fatal:', policy.sanitizeCollectionErrorMessage(err?.message));
      await markRunFailedSafely(err instanceof sessionLoader.SessionValidationError ? err.message : (err?.message || 'Collection failed.'));
      process.exitCode = 1;
    } finally {
      if (browser) { try { await browser.close(); } catch { /* already closed */ } }
    }
  })();
}
