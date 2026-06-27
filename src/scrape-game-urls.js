'use strict';

/**
 * scrape-game-urls.js
 * Scrapes individual GameChanger game box score URLs for a team that does
 * not maintain their own GC page (opponent-scored games).
 *
 * Usage: node src/scrape-game-urls.js <teamName>
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
const Database     = require('better-sqlite3');
const pipeline     = require('./pipeline');

const STORAGE_STATE = path.join(__dirname, '..', 'storage', 'gamechanger-auth.json');
const DB_PATH       = path.join(__dirname, '..', 'voodoo-scout.db');
const OUTPUT_DIR    = path.join(__dirname, '..', 'output');

const teamNameArg = (process.argv[2] || '').replace(/^"|"$/g, '').trim();
if (!teamNameArg) {
  console.error('Usage: node src/scrape-game-urls.js <teamName>');
  process.exit(1);
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function getGameUrls(teamName) {
  const db = new Database(DB_PATH);

  // Try exact match first, then starts-with match to handle minor name differences
  let team = db.prepare(
    `SELECT id FROM teams WHERE LOWER(TRIM(team_name)) = LOWER(TRIM(?))`
  ).get(teamName);

  if (!team) {
    // Try stripping record suffix from DB names
    const cleanArg = teamName.replace(/\(\d[\d-]*\s+in\s+\d{4}\)/gi, '').trim();
    team = db.prepare(
      `SELECT id FROM teams WHERE LOWER(TRIM(team_name)) = LOWER(TRIM(?))`
    ).get(cleanArg);
  }

  if (!team) {
    db.close();
    console.log(`No team found in DB matching: "${teamName}"`);
    return null;
  }

  const urls = db.prepare(
    `SELECT * FROM team_game_urls WHERE team_id = ? ORDER BY created_at`
  ).all(team.id);

  db.close();
  return { teamId: team.id, urls };
}

function markProcessed(urlId) {
  const db = new Database(DB_PATH);
  db.prepare(`UPDATE team_game_urls SET processed_at = datetime('now') WHERE id = ?`).run(urlId);
  db.close();
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
(async () => {
  const result = getGameUrls(teamNameArg);
  if (!result || !result.urls || !result.urls.length) {
    console.log(`No game URLs found for team: ${teamNameArg}`);
    process.exit(0);
  }

  const { teamId, urls } = result;
  console.log(`Found ${urls.length} game URL(s) for: ${teamNameArg}`);

  // Initialize pipeline/DB
  pipeline.init(DB_PATH);

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

      markProcessed(row.id);
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