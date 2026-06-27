'use strict';

/**
 * rebuild-team-from-json.js
 *
 * Cleanly rebuilds ONE team's database rows from saved output/<Team>/game-*.json.
 * This is the repair tool for databases that were polluted by old + corrected
 * side flags being appended under the same games.
 *
 * Run from gamechanger-scraper root:
 *   node rebuild-team-from-json.js "FS Bulldogs 2030 (Black)"
 *
 * Default behavior treats the folder as a scouted opponent team's own GC page,
 * so that the scouted team's players land in is_our_team=0. Add --own-team only
 * if you are rebuilding your own team's GC page and intentionally want normal
 * is_our_team behavior.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pipeline = require('./src/pipeline');
const db = require('./src/db');

const DB_PATH = path.join(__dirname, 'voodoo-scout.db');
const OUTPUT_ROOT = path.join(__dirname, 'output');

pipeline.init(DB_PATH);

function usage() {
  console.log('Usage:');
  console.log('  node rebuild-team-from-json.js "FS Bulldogs 2030 (Black)"');
  console.log('  node rebuild-team-from-json.js "FS Bulldogs" --own-team');
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTeam(nameFilter) {
  const teams = db.getAllTeams();
  const needle = normalizeName(nameFilter);
  const exact = teams.find(t => normalizeName(t.team_name) === needle);
  if (exact) return exact;

  const matches = teams.filter(t => {
    const n = normalizeName(t.team_name);
    const raw = normalizeName(t.raw_team_name || '');
    return n.includes(needle) || needle.includes(n) || raw.includes(needle);
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log(`\nMultiple DB teams match "${nameFilter}":`);
    for (const t of matches) console.log(`  [${t.id}] ${t.team_name}`);
    throw new Error('Use the exact team name or DB id.');
  }

  const byId = teams.find(t => String(t.id) === String(nameFilter).trim());
  if (byId) return byId;

  throw new Error(`No DB team found matching: ${nameFilter}`);
}

function findOutputFolder(team, nameFilter) {
  if (!fs.existsSync(OUTPUT_ROOT)) throw new Error(`Output root not found: ${OUTPUT_ROOT}`);

  const folders = fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const candidates = [team.team_name, team.raw_team_name, nameFilter].filter(Boolean).map(normalizeName);
  const exact = folders.find(f => candidates.includes(normalizeName(f)));
  if (exact) return path.join(OUTPUT_ROOT, exact);

  const matches = folders.filter(f => {
    const nf = normalizeName(f);
    return candidates.some(c => c && (nf.includes(c) || c.includes(nf)));
  });

  if (matches.length === 1) return path.join(OUTPUT_ROOT, matches[0]);
  if (matches.length > 1) {
    console.log(`\nMultiple output folders match "${nameFilter}":`);
    for (const f of matches) console.log(`  ${f}`);
    throw new Error('Use the exact folder/team name.');
  }

  throw new Error(`No output folder found for: ${team.team_name}`);
}

function deleteExistingTeamRows(teamId) {
  const d = db.getDb();
  const gameIds = d.prepare('SELECT id FROM games WHERE team_id = ?').all(teamId).map(r => r.id);

  const tx = d.transaction(() => {
    d.prepare('DELETE FROM batting_lines WHERE team_id = ?').run(teamId);
    d.prepare('DELETE FROM pitching_lines WHERE team_id = ?').run(teamId);
    d.prepare('DELETE FROM play_events WHERE team_id = ?').run(teamId);
    d.prepare('DELETE FROM player_advanced_stats WHERE team_id = ?').run(teamId);
    d.prepare('DELETE FROM pitcher_advanced_stats WHERE team_id = ?').run(teamId);
    d.prepare('DELETE FROM games WHERE team_id = ?').run(teamId);
  });

  tx();
  console.log(`[rebuild] Cleared ${gameIds.length} existing game(s) and all derived rows for team ${teamId}.`);
}

function printSideCounts(teamId) {
  const d = db.getDb();
  for (const table of ['batting_lines', 'pitching_lines', 'player_advanced_stats', 'pitcher_advanced_stats']) {
    const rows = d.prepare(`
      SELECT is_our_team, COUNT(*) AS rows, COUNT(DISTINCT player_name) AS players
      FROM ${table}
      WHERE team_id = ?
      GROUP BY is_our_team
      ORDER BY is_our_team
    `).all(teamId);
    const summary = rows.map(r => `side ${r.is_our_team}: ${r.players} players / ${r.rows} rows`).join(' | ') || 'no rows';
    console.log(`[rebuild] ${table}: ${summary}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const ownTeam = args.includes('--own-team');
  const nameArg = args.filter(a => a !== '--own-team').join(' ').trim();

  if (!nameArg) {
    usage();
    process.exit(1);
  }

  const team = findTeam(nameArg);
  const folder = findOutputFolder(team, nameArg);
  const files = fs.readdirSync(folder)
    .filter(f => f.startsWith('game-') && f.endsWith('.json') && !f.includes('box-score'))
    .sort();

  if (!files.length) throw new Error(`No game-*.json files found in: ${folder}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Rebuilding team: [${team.id}] ${team.team_name}`);
  console.log(`Folder: ${folder}`);
  console.log(`Game JSON files: ${files.length}`);
  console.log(`Side mode: ${ownTeam ? 'own team / no inversion' : 'scouted opponent / invertTeamSide=true'}`);
  console.log(`${'='.repeat(60)}\n`);

  deleteExistingTeamRows(team.id);

  let succeeded = 0;
  let failed = 0;
  const isOpponentTeam = !ownTeam;

  for (const file of files) {
    const filePath = path.join(folder, file);
    let gameData;
    try {
      gameData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (gameData.meta) gameData.meta.jsonFile = filePath;

      const result = pipeline.processExtractResult({
        success: true,
        gameData,
        jsonFile: filePath,
        isOpponentTeam,
      }, team.id);

      if (result.success) {
        succeeded++;
        console.log(`  ✓ ${file}`);
      } else {
        failed++;
        console.error(`  ✗ ${file}: ${result.error || 'unknown error'}`);
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ ${file}: ${err.message}`);
    }
  }

  console.log(`\n[rebuild] Recalculating advanced stats across all ${succeeded} successful game(s)...`);
  pipeline.recalculateTeamStats(team.id, { invertTeamSide: isOpponentTeam });

  console.log('\n[rebuild] Final DB side counts:');
  printSideCounts(team.id);

  console.log(`\n✓ Rebuild complete. Succeeded: ${succeeded}, Failed: ${failed}`);
  console.log('Next: node src/generate-report.js "' + team.team_name + '"');
}

try {
  main();
} catch (err) {
  console.error(`\nRebuild failed: ${err.message}`);
  process.exit(1);
}
