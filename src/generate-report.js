require('dotenv').config();

/**
 * generate-report.js
 * Voodoo Scout — Report Generation CLI
 *
 * Usage:
 *   node src/generate-report.js "James Clemens"                ← opponent report
 *   node src/generate-report.js --all                           ← opponent reports, all teams
 *   node src/generate-report.js --list                          ← list teams
 *   node src/generate-report.js --self-scout                    ← self-scout report for OUR_TEAM_ID
 *   node src/generate-report.js --matchup "James Clemens"       ← matchup: OUR_TEAM_ID vs named opponent
 *
 * Optional env vars (all reports):
 *   GAME_LOCATION="Huntsville, AL"    ← enables weather + field conditions
 *   GAME_DATE="2026-06-20"            ← defaults to today if not set
 *   GAME_TIME="6:00 PM"               ← scheduled first-pitch time, passed to Claude
 *   HUMAN_OBSERVATIONS="..."          ← coach's own scouting notes, treated as ground truth
 *   CUSTOM_PROMPT="..."               ← one-off ask for this specific report
 *   GAME_SCOPE="opponent|self|matchup" ← informational; --self-scout/--matchup flags drive behavior
 *
 * Self-scout / matchup only:
 *   OUR_TEAM_ID="<uuid>"              ← defaults to VBA National 14U (489f5656-205a-49a5-a3de-d1c8c3f226b6),
 *                                        the team flagged teams.is_our_team=true in Supabase
 *   GAME_INVERT_TEAM_SIDE="true"      ← only set true if OUR_TEAM_ID was scraped with an inverted pipeline;
 *                                        every team ingested so far (including VBA National 14U) was NOT,
 *                                        so leave this unset/false unless you know otherwise
 */

const path     = require('path');
const db       = require('./db');
const analyzer = require('./analyzer');
const report   = require('./report');
const { isValidUuid, resolveReportOutputDir } = require('./report-access');
const { requireJobOrgContext } = require('./job-org-context');
const { resolveTeamMatch, formatTeamListLine, formatAmbiguousMatchLine } = require('./report-team-selection');

const DB_PATH     = path.join(__dirname, '..', 'voodoo-scout.db');
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, '..', 'reports');
const OUR_TEAM_ID = process.env.OUR_TEAM_ID || '489f5656-205a-49a5-a3de-d1c8c3f226b6';

// Security Slice T3D: resolved and validated before ANY database access
// (including db.init() below) -- this is the single trusted organization
// every team lookup in this file is scoped to. Fails closed (throws
// OrgContextRequiredError, an uncaught exception that exits the process
// non-zero) if the server (or a trusted operator, for a bare CLI run) did
// not set JOBU_JOB_ORG_ID. There is no fallback to "the only
// organization," a client-supplied value, or a team-derived guess -- see
// src/job-org-context.js and reingest-games.js, which establish this same
// contract for the reingestion job.
const JOB_ORG_ID = requireJobOrgContext();
if (!isValidUuid(JOB_ORG_ID)) {
  console.error('[report] JOBU_JOB_ORG_ID is not a valid organization id. Refusing to run.');
  process.exit(1);
}

// Security Slice T3B: when this process is spawned by a server.js HTTP
// route, JOBU_USAGE_ORG_ID / JOBU_USAGE_REPORT_ID are already set (see
// server.js#buildUsageEnv) -- pre-existing plumbing that, until now, was
// only used to attribute AI usage events. This reuses that SAME
// already-trusted org context (never anything derived from team
// resolution) for two purposes:
//   1. Write each report into a per-organization, per-report-id
//      directory (src/report-access.js#resolveReportOutputDir), so two
//      organizations can never collide on the same output filename
//      (previously: <REPORTS_DIR>/scout-<team>-<date>.*, a shared flat
//      directory with no org/report component at all).
//   2. Record the resulting storage_path back onto the report's own
//      `reports` row, so the authenticated download route in server.js
//      has a reliable, database-backed report-id -> file mapping --
//      never a filename-based lookup.
// A bare CLI operator invocation (no HTTP job) has neither env var set:
// it keeps writing to the flat REPORTS_DIR exactly as before, and there
// is no `reports` row to update in that case either, so the DB update is
// skipped entirely rather than attempted-and-failed. Kept as a separate
// USAGE_ORG_ID (distinct from the JOB_ORG_ID team-scoping context above,
// which T3D introduces) -- these two ids are populated by server.js from
// the same trusted getRequestOrgId(req)/quota.orgId source and are
// expected to always agree for an HTTP-spawned job, but this file never
// assumes that; each is used only for its own, already-established
// purpose.
function normalizeUuid(value) {
  return isValidUuid(value) ? value : null;
}

const USAGE_ORG_ID  = normalizeUuid(process.env.JOBU_USAGE_ORG_ID);
const JOB_REPORT_ID = normalizeUuid(process.env.JOBU_USAGE_REPORT_ID);

const OUTPUT_DIR = resolveReportOutputDir(REPORTS_DIR, USAGE_ORG_ID, JOB_REPORT_ID) || REPORTS_DIR;

// Records the outcome of a report generation attempt onto the report's
// own `reports` row (status/storage_path/generated_at on success,
// status/error_message on failure) -- a no-op when there is no HTTP job
// context (bare CLI) or in SQLite/local-dev mode (no `reports` table).
// A bookkeeping failure here is logged but never allowed to crash an
// otherwise-successful (or already-failed) report run.
async function recordReportOutcome({ status, pdfPath, errorMessage }) {
  if (!USAGE_ORG_ID || !JOB_REPORT_ID) return;
  if (typeof db.useSupabase !== 'function' || !db.useSupabase()) return;

  const patch = { status };
  if (status === 'ready') {
    patch.storage_path = pdfPath
      ? path.relative(REPORTS_DIR, pdfPath).split(path.sep).join('/')
      : null;
    patch.generated_at = new Date().toISOString();
  } else if (status === 'failed') {
    patch.error_message = String(errorMessage || 'Report generation failed').slice(0, 500);
  }

  try {
    const { error } = await db.getDb()
      .from('reports')
      .update(patch)
      .eq('id', JOB_REPORT_ID)
      .eq('org_id', USAGE_ORG_ID);
    if (error) console.error('[report] Failed to record report outcome:', error.message);
  } catch (err) {
    console.error('[report] Failed to record report outcome:', err.message);
  }
}

// Options passed through to analyzer
const analyzerOptions = {
  gameLocation: process.env.GAME_LOCATION || null,
  gameDate:     process.env.GAME_DATE     || new Date().toISOString().slice(0, 10),
  gameTime:            process.env.GAME_TIME            || null,
  humanObservations:   process.env.HUMAN_OBSERVATIONS    || null,
  customPrompt:        process.env.CUSTOM_PROMPT         || null,
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
if (analyzerOptions.gameTime)          console.log(`[report] Game time: ${analyzerOptions.gameTime}`);
if (analyzerOptions.humanObservations) console.log(`[report] Coach observations provided (${analyzerOptions.humanObservations.length} chars)`);
if (analyzerOptions.customPrompt)      console.log(`[report] Custom prompt provided (${analyzerOptions.customPrompt.length} chars)`);

db.init(DB_PATH);

// Security Slice T3D: both team-discovery call sites below (and the
// --all branch in main()) resolve teams exclusively through the
// tenant-scoped listTeamsForOrg query (see src/db-supabase.js), the
// scoped counterpart to the previously-used unscoped global team query --
// so a report job for one organization can never resolve, list, or
// process a different organization's team, whether by exact id, exact
// name, partial name, or ambiguous-match/list output. Matching and
// formatting logic itself lives in the pure, independently tested
// src/report-team-selection.js so no inline duplicate predicate or log
// template exists in this file.

async function listTeams() {
  const teams = await db.listTeamsForOrg(JOB_ORG_ID);

  if (!Array.isArray(teams) || !teams.length) {
    console.log('\nNo teams in database yet. Run team analysis first.\n');
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

    console.log(formatTeamListLine(t, games));
  }

  console.log('');
}

async function findTeam(nameFragment) {
  const teams = await db.listTeamsForOrg(JOB_ORG_ID);

  if (!Array.isArray(teams)) {
    throw new Error(`db.listTeamsForOrg() did not return an array. Got: ${typeof teams}`);
  }

  const { team, matches } = resolveTeamMatch(teams, nameFragment);
  if (team) return team;

  if (matches.length > 1) {
    console.log(`\nMultiple teams match "${nameFragment}":`);
    for (const m of matches) {
      console.log(formatAmbiguousMatchLine(m));
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
    paths = await report.generateReport(analysis, OUTPUT_DIR);
  } catch (err) {
    console.error('[report] FULL ERROR:', err);
    await recordReportOutcome({ status: 'failed', errorMessage: err.message });
    throw err;
  }
  await recordReportOutcome({ status: 'ready', pdfPath: paths.pdf });

  console.log(`\n✓ Report complete for: ${team.team_name}`);
  console.log(`  Word: ${paths.docx}`);
  console.log(`  PDF:  ${paths.pdf}`);

  return paths;
}

async function runSelfScout() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Generating self-scout report — OUR_TEAM_ID=${OUR_TEAM_ID}`);
  console.log('='.repeat(60));

  const analysis = await analyzer.analyzeSelfScout(OUR_TEAM_ID, analyzerOptions);

  let paths;
  try {
    paths = await report.generateReport(analysis, OUTPUT_DIR);
  } catch (err) {
    console.error('[report] FULL ERROR:', err);
    await recordReportOutcome({ status: 'failed', errorMessage: err.message });
    throw err;
  }
  await recordReportOutcome({ status: 'ready', pdfPath: paths.pdf });

  console.log(`\n✓ Self-scout report complete`);
  console.log(`  Word: ${paths.docx}`);
  console.log(`  PDF:  ${paths.pdf}`);
  return paths;
}

async function runMatchup(opponentNameOrId) {
  const opponent = await findTeam(opponentNameOrId);
  if (!opponent) {
    console.log(`\nNo opponent team found matching: "${opponentNameOrId}"`);
    await listTeams();
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Generating matchup report: JoBu vs ${opponent.team_name}`);
  console.log('='.repeat(60));

  const analysis = await analyzer.analyzeMatchup(OUR_TEAM_ID, opponent.id, analyzerOptions);

  let paths;
  try {
    paths = await report.generateReport(analysis, OUTPUT_DIR);
  } catch (err) {
    console.error('[report] FULL ERROR:', err);
    await recordReportOutcome({ status: 'failed', errorMessage: err.message });
    throw err;
  }
  await recordReportOutcome({ status: 'ready', pdfPath: paths.pdf });

  console.log(`\n✓ Matchup report complete: JoBu vs ${opponent.team_name}`);
  console.log(`  Word: ${paths.docx}`);
  console.log(`  PDF:  ${paths.pdf}`);
  return paths;
}

async function main() {
  const rawArgs = process.argv.slice(2).filter(a => a !== '--skip-recalc');

  if (rawArgs.includes('--self-scout')) {
    await runSelfScout();
    console.log(`\nReports saved to: ${REPORTS_DIR}`);
    return;
  }

  const matchupIdx = rawArgs.indexOf('--matchup');
  if (matchupIdx !== -1) {
    const opponentNameOrId = rawArgs.slice(matchupIdx + 1).join(' ');
    if (!opponentNameOrId) {
      console.log('\n--matchup requires an opponent team name or id, e.g.:');
      console.log('  node src/generate-report.js --matchup "James Clemens"\n');
      process.exit(1);
    }
    await runMatchup(opponentNameOrId);
    console.log(`\nReports saved to: ${REPORTS_DIR}`);
    return;
  }

  const args = rawArgs;

  if (args.includes('--list') || args.includes('-l')) {
    await listTeams();
    return;
  }

  if (args.includes('--all') || args.includes('-a')) {
    const teams = await db.listTeamsForOrg(JOB_ORG_ID);

    if (!Array.isArray(teams) || !teams.length) {
      console.log('\nNo teams in database. Run team analysis first.\n');
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
  console.log('  node src/generate-report.js "Team Name"           ← opponent report for one team');
  console.log('  node src/generate-report.js --all                  ← opponent reports, all teams');
  console.log('  node src/generate-report.js --list                 ← list teams in DB');
  console.log('  node src/generate-report.js --self-scout           ← self-scout report (OUR_TEAM_ID)');
  console.log('  node src/generate-report.js --matchup "Team Name"  ← matchup report (OUR_TEAM_ID vs Team Name)\n');
}

main().catch(err => {
  console.error('\nReport generation failed:');
  console.error(err.stack || err);
  process.exit(1);
});