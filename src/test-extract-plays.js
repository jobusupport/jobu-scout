'use strict';
/**
 * src/test-extract-plays.js
 *
 * Verification script for the extractPlays() duplicate-selector fix.
 * Runs extractPlays() against a SINGLE GameChanger game URL and reports
 * play counts plus near-duplicate detection — no database writes, no
 * full team scrape.
 *
 * USAGE (PowerShell, from project root):
 *   node src/test-extract-plays.js "https://web.gc.com/teams/.../schedule/GAME_ID/box-score"
 *
 * Paste ANY page URL from that game (box-score, recap, plays, etc.) —
 * extractPlays() rewrites it to the /plays variant internally.
 *
 * Requires a valid login session first: npm run login
 */

const path = require('path');
const { chromium } = require('playwright');
const { extractPlays } = require('./search-gamechanger-teams');

const STORAGE_STATE = path.join(__dirname, '..', 'gamechanger-auth.json');

async function main() {
  const gameUrl = process.argv[2];

  if (!gameUrl) {
    console.error('Usage: node src/test-extract-plays.js "<any GameChanger game URL>"');
    process.exit(1);
  }

  console.log('[test] Launching Chromium...');
  const browser = await chromium.launch({
    headless: process.env.NODE_ENV === 'production',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: 1440, height: 1000 }
  });

  const page = await context.newPage();

  try {
    console.log(`[test] Navigating to: ${gameUrl}`);
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    console.log('[test] Running extractPlays()...');
    const plays = await extractPlays(page);

    console.log('');
    console.log(`[test] extractPlays() returned ${plays.length} play(s).`);
    console.log('');

    // Check for near-duplicates the fix targets: same normalized text
    // (ignoring a leading inning label) appearing more than once.
    const normalizedCounts = new Map();
    for (const play of plays) {
      const normalized = String(play.text || '')
        .replace(/^(top|bottom|mid|end)\s+\d+\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      normalizedCounts.set(normalized, (normalizedCounts.get(normalized) || 0) + 1);
    }

    const dupes = [...normalizedCounts.entries()].filter(([, count]) => count > 1);

    if (dupes.length === 0) {
      console.log('[test] No near-duplicate plays detected.');
    } else {
      console.log(`[test] Found ${dupes.length} normalized text(s) appearing more than once:`);
      dupes.forEach(([text, count]) => {
        console.log(`    (${count}x) ${text}`);
      });
    }

    console.log('');
    console.log('[test] Full play list:');
    plays.forEach((play, i) => {
      console.log(`  ${String(i + 1).padStart(3, ' ')}. [${play.inning || '?'}] ${play.text}`);
    });

  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[test] Failed:', err.stack || err);
  process.exit(1);
});