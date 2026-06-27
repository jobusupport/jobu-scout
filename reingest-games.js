'use strict';

/**
 * reingest-games.js
 * Voodoo Scout — Re-ingest saved game JSON files into the database
 *
 * Run from gamechanger-scraper root:
 *   node reingest-games.js "FS Bulldogs"
 *   node reingest-games.js --all
 *
 * Reads every game-*.json from output/<TeamName>/ and feeds it
 * through the existing pipeline (normalizer → DB → stats engine).
 *
 * NOTE: isOpponentTeam is always true here because reingest is used
 * exclusively for scouted opponent teams (not Birmingham Stars' own games).
 * This ensures their players land in is_our_team=0, which is what the
 * report queries read for scouting data.
 */

require('dotenv').config();

const fs       = require('fs');
const path     = require('path');
const pipeline = require('./src/pipeline');
const db       = require('./src/db');

const DB_PATH     = path.join(__dirname, 'voodoo-scout.db');
const OUTPUT_ROOT = path.join(__dirname, 'output');

pipeline.init(DB_PATH);

// ── Find team folder by name ──────────────────────────────────────────────────
function findTeamFolders(nameFilter) {
  if (!fs.existsSync(OUTPUT_ROOT)) {
    console.error(`Output folder not found: ${OUTPUT_ROOT}`);
    process.exit(1);
  }
  const folders = fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  if (!nameFilter) return folders;

  const lower = nameFilter.toLowerCase();
  return folders.filter(f => f.toLowerCase().includes(lower));
}

// ── Ingest one team folder ────────────────────────────────────────────────────
function ingestTeamFolder(folderName) {
  const folderPath = path.join(OUTPUT_ROOT, folderName);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Ingesting: ${folderName}`);
  console.log(`Folder: ${folderPath}`);

  // Get or create team in DB
  const existingTeams = db.getAllTeams();
  let team = existingTeams.find(t =>
    t.team_name.toLowerCase().includes(folderName.toLowerCase()) ||
    folderName.toLowerCase().includes(t.team_name.toLowerCase())
  );

  if (!team) {
    console.log(`[ingest] Team not found in DB — creating: ${folderName}`);
    const teamId = db.upsertTeam({ teamName: folderName });
    team = { id: teamId, team_name: folderName };
  }

  console.log(`[ingest] Team ID: ${team.id} — ${team.team_name}`);

  // Find all game JSON files in the folder
  const files = fs.readdirSync(folderPath)
    .filter(f => f.startsWith('game-') && f.endsWith('.json') && !f.includes('box-score'))
    .sort();

  console.log(`[ingest] Found ${files.length} game JSON file(s)`);

  let succeeded = 0;
  let skipped   = 0;
  let failed    = 0;

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    let gameData;

    try {
      gameData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`[ingest] Parse error ${file}: ${err.message}`);
      failed++;
      continue;
    }

    // Inject the file path into meta so recalculateTeamStats can find it later
    if (gameData.meta) {
      gameData.meta.jsonFile = filePath;
    }

    // isOpponentTeam: true — scouted team's players must land in is_our_team=0
    const extractResult = {
      success:        true,
      gameData,
      jsonFile:       filePath,
      isOpponentTeam: true,
    };

    const result = pipeline.processExtractResult(extractResult, team.id);

    if (result.success) {
      console.log(`  ✓ ${file} → game ${result.gameId}`);
      succeeded++;
    } else if (result.error && result.error.includes('UNIQUE')) {
      console.log(`  → ${file} already in DB`);
      skipped++;
    } else {
      console.error(`  ✗ ${file}: ${result.error || 'unknown error'}`);
      failed++;
    }
  }

  console.log(`\n[ingest] ${folderName}: ${succeeded} ingested, ${skipped} skipped, ${failed} failed`);

  // Recalculate advanced stats across ALL games for this team
  if (succeeded > 0 || skipped > 0) {
    console.log(`[ingest] Recalculating advanced stats for ${folderName}...`);
    try {
      pipeline.recalculateTeamStats(team.id, { invertTeamSide: true });
    } catch (err) {
      console.error(`[ingest] Stats recalculation failed: ${err.message}`);
    }
  }

  return { succeeded, skipped, failed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--all') || args.includes('-a')) {
    const folders = findTeamFolders();
    console.log(`\nRe-ingesting all ${folders.length} team folder(s)...`);
    let total = { succeeded: 0, skipped: 0, failed: 0 };
    for (const folder of folders) {
      const r = ingestTeamFolder(folder);
      total.succeeded += r.succeeded;
      total.skipped   += r.skipped;
      total.failed    += r.failed;
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Total: ${total.succeeded} ingested, ${total.skipped} skipped, ${total.failed} failed`);
    return;
  }

  const nameArg = args.join(' ').trim();
  if (!nameArg) {
    console.log('Usage:');
    console.log('  node reingest-games.js "FS Bulldogs"   ← one team');
    console.log('  node reingest-games.js --all           ← all teams');
    process.exit(1);
  }

  const folders = findTeamFolders(nameArg);
  if (!folders.length) {
    console.error(`No output folder found matching: "${nameArg}"`);
    console.error(`Available folders: ${findTeamFolders().join(', ')}`);
    process.exit(1);
  }

  for (const folder of folders) {
    ingestTeamFolder(folder);
  }

  // Final check
  const teams = db.getAllTeams();
  console.log('\n── DB state after ingest ──');
  for (const t of teams) {
    const bundle = require('./src/pipeline').getTeamBundle(t.id);
    console.log(`  [${t.id}] ${t.team_name} — ${bundle.meta.gamesAnalyzed} game(s)`);
  }
}

main();