'use strict';

/**
 * scrape-handedness-cli.js
 *
 * Standalone runner for capturing one opponent team's roster handedness.
 * Does NOT touch the main game-scraping pipeline in search-gamechanger-teams.js —
 * run it separately, before or after scouting a team's games.
 *
 * Usage (PowerShell):
 *   $env:USE_SUPABASE="true"; node src/scrape-handedness-cli.js `
 *     --teamId 42 `
 *     --opponentName "USA Prime Southeast Scout 14U" `
 *     --myTeamGcUrl "https://web.gc.com/teams/xxxxxxxx"
 *
 * Add --forceRefresh to re-capture every player instead of only new ones.
 * Add --debugHtml to dump roster/modal HTML to output/_handedness-debug/
 * for selector verification (equivalent to setting GC_HANDEDNESS_DEBUG_HTML=true).
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { captureTeamHandedness } = require('./scrape-handedness');
const db = require('./db');

const STORAGE_STATE = path.join(__dirname, '..', 'storage', 'gamechanger-auth.json');
const DB_PATH = path.join(__dirname, '..', 'voodoo-scout.db');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
    args[key] = value;
    if (value !== 'true') i++;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.debugHtml === 'true') process.env.GC_HANDEDNESS_DEBUG_HTML = 'true';

  const teamId = args.teamId;
  const opponentName = args.opponentName;
  const myTeamGcUrl = args.myTeamGcUrl;
  const forceRefresh = args.forceRefresh === 'true';

  if (!teamId || !opponentName || !myTeamGcUrl) {
    console.error('Usage: node src/scrape-handedness-cli.js --teamId <id> --opponentName "<name>" --myTeamGcUrl "<url>" [--forceRefresh] [--debugHtml]');
    process.exit(1);
  }

  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(teamId));
  if (looksLikeUuid && String(process.env.USE_SUPABASE || '').toLowerCase() !== 'true') {
    console.warn('[handedness] WARNING: teamId looks like a Supabase UUID, but USE_SUPABASE is not true.');
    console.warn('[handedness] For production data, run this first in PowerShell: $env:USE_SUPABASE="true"');
  }

  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(`Missing auth file: ${STORAGE_STATE}. Run npm run login first.`);
  }

  db.init(DB_PATH);

  console.log('[browser] Launching Chromium...');
  const browser = await chromium.launch({
    headless: process.env.NODE_ENV === 'production',
    slowMo: process.env.NODE_ENV === 'production' ? 0 : 75,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true
  });

  const page = await context.newPage();

  try {
    const result = await captureTeamHandedness({
      page,
      myTeamGcUrl,
      opponentTeamName: opponentName,
      teamId,
      db,
      forceRefresh
    });
    console.log('[handedness] Result:', result);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Handedness scrape failed:');
  console.error(error.message);
  console.error(error.stack);
  process.exit(1);
});
