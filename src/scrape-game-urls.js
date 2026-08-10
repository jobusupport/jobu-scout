'use strict';

/**
 * scrape-game-urls.js
 * Scrapes individual GameChanger game box score URLs for a team that does
 * not maintain their own GC page (opponent-scored games).
 *
 * Usage: node src/scrape-game-urls.js <teamName>
 *
 * Required env var:
 *   JOBU_JOB_ORG_ID  <uuid>  ← the trusted organization this run acts as.
 *                                Set by server.js when this script is
 *                                spawned from an authenticated route; a
 *                                trusted operator must set it explicitly
 *                                for a bare CLI run. Refuses to run
 *                                without it (Security Slice T3G).
 *
 * Reads game URLs from DB table: team_game_urls
 * Each row: gc_game_url, label, box_side ('away'|'home')
 *   'away' = left side of box score
 *   'home' = right side of box score
 */

require('dotenv').config();

const { chromium } = require('@playwright/test');
const path         = require('path');
const fs           = require('fs');
const db           = require('./db');
const pipeline     = require('./pipeline');
const { getStorageStatePath } = require('./gc-session-loader');
const { requireJobOrgContext } = require('./job-org-context');
const { isValidUuid } = require('./report-access');

// Resolved through the single shared helper (src/gc-session-loader.js) every
// other GameChanger session producer/consumer uses -- GC_AUTH_FILE_PATH is a
// real, end-to-end configurable location, not a value only some callers
// understand. Defaults to the exact same repo-relative path this constant
// always resolved to, so existing deployments (including server.js's own
// POST /api/run/gc-scraper spawnJob call, which invokes this exact file)
// are unaffected. No separate fallback constant is maintained here.
const STORAGE_STATE = getStorageStatePath();
const DB_PATH       = path.join(__dirname, '..', 'voodoo-scout.db');
const OUTPUT_DIR    = path.join(__dirname, '..', 'output');

// ── DB helpers ────────────────────────────────────────────────────────────────
// Security Slice T3G: previously opened voodoo-scout.db directly with a
// raw, unscoped `WHERE team_id = ?` query -- team_game_urls has no org_id
// column, so that query (and the equally unscoped UPDATE in markProcessed
// below) could read or update ANY organization's rows, and never even
// went through src/db.js's T3F database-mode gate. Now routed through the
// shared repository (src/db.js -> src/db-supabase.js in Supabase mode),
// the same db.listTeamsForOrg(orgId) tenant-scoped team lookup
// src/reingest-helpers.js and src/report-team-selection.js already use
// (fuzzy name matching happens here, in JS, same as before -- but against
// an already org-scoped team list, never a global one), and the new
// db.getGameUrlsForTeamInOrg/markGameUrlProcessedForOrg methods, which
// re-verify team ownership against orgId at query time before touching
// team_game_urls (see src/db-supabase.js for the exact query shape).
function normalizeTeamNameForMatch(value) {
  return String(value || '').trim().toLowerCase();
}

async function getGameUrls(orgId, teamName) {
  const teams = await Promise.resolve(db.listTeamsForOrg(orgId));

  const needle = normalizeTeamNameForMatch(teamName);
  let team = teams.find((t) => normalizeTeamNameForMatch(t.team_name) === needle);

  if (!team) {
    // Try stripping record suffix from DB names (e.g. "(12-3 in 2026)")
    const cleanArg = teamName.replace(/\(\d[\d-]*\s+in\s+\d{4}\)/gi, '').trim();
    const cleanNeedle = normalizeTeamNameForMatch(cleanArg);
    team = teams.find((t) => normalizeTeamNameForMatch(t.team_name) === cleanNeedle);
  }

  if (!team) {
    console.log(`No team found in DB matching: "${teamName}"`);
    return null;
  }

  const urls = await Promise.resolve(db.getGameUrlsForTeamInOrg(orgId, team.id));
  return { teamId: team.id, urls };
}

async function markProcessed(orgId, urlId, teamId) {
  await Promise.resolve(db.markGameUrlProcessedForOrg(orgId, urlId, teamId));
}

// ── Re-tag game data rows with the user-specified side ────────────────────────
// extractGameData auto-detects ourSide by name matching, but for No-GC teams
// the team name won't match either side. We override with the user's selection.
function overrideSide(gameData, forcedSide, teamName) {
  if (!gameData) return gameData;

  const originalSide = gameData.meta?.ourSide;
  if (originalSide === forcedSide) return gameData; // already correct

  console.log(`  Side override: auto-detected "${originalSide}" → forced "${forcedSide}"`);

  // Re-tag all batting/pitching rows
  const tag = (rows, side) =>
    (rows || []).map(r => ({ ...r, isOurTeam: side === forcedSide }));

  const bs = gameData.boxScore || {};

  gameData.meta.ourSide      = forcedSide;
  gameData.meta.teamName     = teamName;
  gameData.meta.opponentName = forcedSide === 'away'
    ? (bs.homeTeam || gameData.meta.opponentName || '')
    : (bs.awayTeam || gameData.meta.opponentName || '');

  gameData.boxScore.batting = [
    ...tag(bs.awayBatting  || [], 'away'),
    ...tag(bs.homeBatting  || [], 'home'),
  ];
  gameData.boxScore.pitching = [
    ...tag(bs.awayPitching || [], 'away'),
    ...tag(bs.homePitching || [], 'home'),
  ];

  return gameData;
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Guarded by require.main===module (the same convention
// src/search-gamechanger-teams.js already uses for its own CLI entry
// point) so this file can be safely require()'d as a module -- e.g. by a
// test proving STORAGE_STATE resolution -- without launching a real
// browser, touching the real Travel SQLite database, or contacting
// GameChanger. Production behavior is unchanged: server.js's own
// spawnJob call always runs this file via `node src/scrape-game-urls.js
// <teamName>`, which is always require.main === module.
if (require.main === module) {
  const teamNameArg = (process.argv[2] || '').replace(/^"|"$/g, '').trim();
  if (!teamNameArg) {
    console.error('Usage: node src/scrape-game-urls.js <teamName>');
    process.exit(1);
  }

  // Security Slice T3G: resolved and validated before ANY database access
  // (including pipeline.init() below) -- the same fail-closed contract
  // src/reingest-games.js and src/generate-report.js already established.
  // This job is spawned by server.js's authenticated /api/run/gc-scraper,
  // /api/run/full-pipeline, and /api/run/all-gc routes on behalf of a
  // real, already-verified organization; JOBU_JOB_ORG_ID carries that
  // trusted value. There is no fallback to "the only organization" or any
  // other inference.
  const JOB_ORG_ID = requireJobOrgContext();
  if (!isValidUuid(JOB_ORG_ID)) {
    console.error('[scrape-game-urls] JOBU_JOB_ORG_ID is not a valid organization id. Refusing to run.');
    process.exit(1);
  }

  (async () => {
    // Initialize pipeline/DB first -- getGameUrls() below needs db.js
    // initialized (this is also where T3F's resolveDatabaseMode() gate
    // runs, before any team or team_game_urls query).
    pipeline.init(DB_PATH);

    const result = await getGameUrls(JOB_ORG_ID, teamNameArg);
    if (!result || !result.urls || !result.urls.length) {
      console.log(`No game URLs found for team: ${teamNameArg}`);
      process.exit(0);
    }

    const { teamId, urls } = result;
    console.log(`Found ${urls.length} game URL(s) for: ${teamNameArg}`);

    // Ensure output dir exists
    const teamOutputDir = path.join(OUTPUT_DIR, teamNameArg.replace(/[<>:"/\\|?*]/g, ''));
    if (!fs.existsSync(teamOutputDir)) fs.mkdirSync(teamOutputDir, { recursive: true });

    // Import extractGameData from the main scraper
    // It handles all HTML extraction — we just override the side assignment after
    let extractGameData;
    try {
      const mainScraper = require('./search-gamechanger-teams');
      extractGameData   = mainScraper.extractGameData;
      if (typeof extractGameData !== 'function') throw new Error('extractGameData not exported');
    } catch (err) {
      console.error(`Cannot import extractGameData: ${err.message}`);
      console.error(`Make sure search-gamechanger-teams.js exports: module.exports = { extractGameData }`);
      process.exit(1);
    }

    if (!fs.existsSync(STORAGE_STATE)) {
      throw new Error(`Missing auth file: ${STORAGE_STATE}. Run npm run login first.`);
    }

    const browser = await chromium.launch({ headless: true });
    const context  = await browser.newContext({ storageState: STORAGE_STATE });
    const page     = await context.newPage();

    let successCount = 0;
    let failCount    = 0;

    for (const row of urls) {
      console.log(`\n── Processing: ${row.label || row.gc_game_url} ──`);
      console.log(`  URL:  ${row.gc_game_url}`);
      console.log(`  Side: ${row.box_side} (${row.box_side === 'away' ? 'Left / Away' : 'Right / Home'})`);

      if (!row.gc_game_url || !row.gc_game_url.startsWith('http')) {
        console.error(`  ✗ Invalid URL — skipping`);
        failCount++;
        continue;
      }

      try {
        await page.goto(row.gc_game_url, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(2000);

        // Pass a synthetic team object — extractGameData will auto-detect side by name
        // then we override with the user's explicit selection
        const fakeTeam = {
          teamName:    teamNameArg,
          rawTeamName: teamNameArg,
        };

        const captureResult = await extractGameData(page, fakeTeam);

        if (!captureResult || !captureResult.success) {
          throw new Error('extractGameData returned failure');
        }

        // Override the side assignment with user's explicit selection
        const correctedData = overrideSide(captureResult.gameData, row.box_side, teamNameArg);

        // Update the saved JSON with corrected side data
        if (captureResult.jsonFile && correctedData) {
          fs.writeFileSync(captureResult.jsonFile, JSON.stringify(correctedData, null, 2), 'utf8');
          console.log(`  Side corrected and saved: ${captureResult.jsonFile}`);
        }

        // Process through normalizer → DB
        pipeline.processExtractResult(captureResult, teamId);

        await markProcessed(JOB_ORG_ID, row.id, teamId);
        console.log(`  ✓ Processed successfully`);
        successCount++;

      } catch (err) {
        console.error(`  ✗ Failed: ${err.message}`);
        failCount++;
      }
    }

    await browser.close();

    console.log(`\n── Summary ──`);
    console.log(`  ✓ ${successCount} game(s) processed`);
    if (failCount) console.log(`  ✗ ${failCount} game(s) failed`);

    process.exit(failCount > 0 && successCount === 0 ? 1 : 0);
  })();
}

module.exports = { STORAGE_STATE };