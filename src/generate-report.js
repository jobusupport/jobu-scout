require('dotenv').config();

/**
 * generate-report.js
 * Voodoo Scout — Report Generation CLI
 *
 * Usage:
 *   node src/generate-report.js "James Clemens"
 *   node src/generate-report.js --all
 *   node src/generate-report.js --list
 *
 * Optional env vars:
 *   GAME_LOCATION="Huntsville, AL"   ← enables weather + field conditions
 *   GAME_DATE="2026-06-20"           ← defaults to today if not set
 */

const path     = require('path');
const db       = require('./db');
const analyzer = require('./analyzer');
const report   = require('./report');

const DB_PATH     = path.join(__dirname, '..', 'voodoo-scout.db');
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, '..', 'reports');

// Options passed through to analyzer
const analyzerOptions = {
  gameLocation: process.env.GAME_LOCATION || null,
  gameDate:     process.env.GAME_DATE     || new Date().toISOString().slice(0, 10),
  // Advanced stats (player_advanced_stats / pitcher_advanced_stats) are now
  // recalculated automatically at the start of every report (see
  // analyzer.js:analyzeTeam). Pass --skip-recalc on the CLI, or set
  // ANALYZER_SKIP_RECALC=true, to bypass this when iterating quickly and
  // you're confident advanced stats are already current.
  skipRecalculate: process.argv.slice(2).includes('--skip-recalc'),
  // Almost every team in this DB is a scouted opponent (is_our_team=false),
  // which is why recalculate-all-teams.js has always used invertTeamSide:
  // false. If you are ever generating a report for JoBu 14U itself (or any
  // other team ingested in self-scout mode), pass GAME_INVERT_TEAM_SIDE=true
  // so the recalculation direction matches how that team was ingested.
  invertTeamSide: process.env.GAME_INVERT_TEAM_SIDE === 'true',
};

if (analyzerOptions.skipRecalculate) {
  console.log('[report] Skipping automatic advanced-stats recalculation (--skip-recalc).');
}

if (analyzerOptions.gameLocation) {
  console.log(`[report] Game location: ${analyzerOptions.gameLocation}`);
  console.log(`[report] Game date: ${analyzerOptions.gameDate}`);
}

db.init(DB_PATH);

function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

async function listTeams() {
  const teams = await db.getAllTeams();

  if (!Array.isArray(teams) || !teams.length) {
    console.log('\nNo teams in database yet. Run the scraper first.\n');
    return;
  }

  console.log('\nTeams in Voodoo Scout DB:');
  console.log('─'.repeat(60));

  for (const t of teams) {
    let games = 0;

    try {
      const bundle = await db.getTeamAnalysisBundle(t.id);
      games = bundle?.meta?.gamesAnalyzed ?? 0;
    } catch (err) {
      console.warn(`  [${t.id}] ${t.team_name} — could not load game count: ${err.message}`);
      continue;
    }

    console.log(`  [${t.id}] ${t.team_name} — ${games} game${games !== 1 ? 's' : ''}`);
  }

  console.log('');
}

async function findTeam(nameFragment) {
  const teams = await db.getAllTeams();

  if (!Array.isArray(teams)) {
    throw new Error(`db.getAllTeams() did not return an array. Got: ${typeof teams}`);
  }

  const lower = normalize(nameFragment);

  const byId = teams.find(t => normalize(t.id) === lower);
  if (byId) return byId;

  const exactMatches = teams.filter(t =>
    normalize(t.team_name) === lower ||
    normalize(t.raw_team_name) === lower
  );

  if (exactMatches.length === 1) return exactMatches[0];

  const partialMatches = teams.filter(t =>
    normalize(t.team_name).includes(lower) ||
    normalize(t.raw_team_name).includes(lower)
  );

  const matches = exactMatches.length ? exactMatches : partialMatches;

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    console.log(`\nMultiple teams match "${nameFragment}":`);
    for (const m of matches) {
      console.log(`  [${m.id}] ${m.team_name}`);
    }
    console.log('\nBe more specific or use the team ID.\n');
    process.exit(1);
  }

  return null;
}

async function runForTeam(team) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Generating report: ${team.team_name}`);
  console.log('='.repeat(60));

  const analysis = await analyzer.analyzeTeam(team.id, analyzerOptions);

  let paths;
  try {
    paths = await report.generateReport(analysis, REPORTS_DIR);
  } catch (err) {
    console.error('[report] FULL ERROR:', err);
    throw err;
  }

  console.log(`\n✓ Report complete for: ${team.team_name}`);
  console.log(`  Word: ${paths.docx}`);
  console.log(`  PDF:  ${paths.pdf}`);

  return paths;
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--skip-recalc');

  if (args.includes('--list') || args.includes('-l')) {
    await listTeams();
    return;
  }

  if (args.includes('--all') || args.includes('-a')) {
    const teams = await db.getAllTeams();

    if (!Array.isArray(teams) || !teams.length) {
      console.log('\nNo teams in database. Run the scraper first.\n');
      return;
    }

    console.log(`\nGenerating reports for ${teams.length} team(s)...`);

    let succeeded = 0;
    let failed = 0;

    for (const team of teams) {
      try {
        await runForTeam(team);
        succeeded++;
      } catch (err) {
        console.error(`\n✗ Failed for ${team.team_name}: ${err.message}`);
        failed++;
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Done. ${succeeded} succeeded, ${failed} failed.`);
    console.log(`Reports saved to: ${REPORTS_DIR}`);
    return;
  }

  if (args.length > 0) {
    const nameOrId = args.join(' ');
    const team = await findTeam(nameOrId);

    if (!team) {
      console.log(`\nNo team found matching: "${nameOrId}"`);
      await listTeams();
      process.exit(1);
    }

    await runForTeam(team);
    console.log(`\nReports saved to: ${REPORTS_DIR}`);
    return;
  }

  await listTeams();
  console.log('Usage:');
  console.log('  node src/generate-report.js "Team Name"   ← generate for one team');
  console.log('  node src/generate-report.js --all          ← generate for all teams');
  console.log('  node src/generate-report.js --list         ← list teams in DB\n');
}

main().catch(err => {
  console.error('\nReport generation failed:');
  console.error(err.stack || err);
  process.exit(1);
});