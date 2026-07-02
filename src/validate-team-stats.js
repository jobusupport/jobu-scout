'use strict';

/**
 * validate-team-stats.js
 *
 * Reconstructs team totals from play-by-play, compares them to box score
 * totals, and stores a report-safe verified facts row for the analyzer.
 *
 * Usage:
 *   railway run node src/validate-team-stats.js "VBA National"
 *   railway run node src/validate-team-stats.js --all
 *   railway run node src/validate-team-stats.js "VBA National" --dry-run
 */

require('dotenv').config();
const path = require('path');
const db = require('./db');
const { reconstructTeamGames } = require('./game-reconstructor');

const DB_PATH = path.join(__dirname, '..', 'voodoo-scout.db');

db.init(DB_PATH);

function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

function pct(num, den) {
  return den > 0 ? Number((num / den * 100).toFixed(1)) : null;
}

function fmt(obj) {
  return JSON.stringify(obj, null, 2);
}

async function findTeam(nameFragment) {
  const teams = await Promise.resolve(db.getAllTeams());
  const lower = normalize(nameFragment);

  const byId = teams.find(t => normalize(t.id) === lower);
  if (byId) return byId;

  const exact = teams.filter(t => normalize(t.team_name) === lower || normalize(t.raw_team_name) === lower);
  if (exact.length === 1) return exact[0];

  const partial = teams.filter(t => normalize(t.team_name).includes(lower) || normalize(t.raw_team_name).includes(lower));
  if (partial.length === 1) return partial[0];

  if (partial.length > 1) {
    console.log(`Multiple teams match "${nameFragment}":`);
    for (const t of partial) console.log(`  [${t.id}] ${t.team_name}`);
    throw new Error('Be more specific or use the team ID.');
  }

  throw new Error(`No team matched "${nameFragment}".`);
}

async function writeValidationToSupabase(team, validation) {
  if (process.env.USE_SUPABASE !== 'true') {
    console.log('[validate] USE_SUPABASE is not true; validation was not written to Supabase tables.');
    return null;
  }

  const sb = db.getDb();
  const summary = validation.summary;

  const runPayload = {
    team_id: summary.teamId,
    status: 'complete',
    games_total: summary.games,
    games_with_box_score: summary.boxScoreGames,
    games_with_play_by_play: summary.playByPlayGames,
    games_validated: summary.validatedGames,
    games_mismatched: summary.mismatchGames,
    official_batting: summary.officialBatting,
    official_pitching: summary.officialPitching,
    reconstructed_batting: summary.reconstructedBatting,
    reconstructed_pitching_defense: summary.reconstructedPitchingDefense,
    deltas: summary.deltas,
    side_specific_tendencies: summary.tendencies,
    warnings: summary.warnings,
    confidence: summary.confidence,
  };

  const { data: run, error: runError } = await sb
    .from('stat_validation_runs')
    .insert(runPayload)
    .select('id')
    .single();

  if (runError) throw new Error(`[validate] Could not insert stat_validation_runs. Did you run the SQL migration? ${runError.message}`);

  const gameRows = validation.gameResults.map(r => ({
    run_id: run.id,
    team_id: summary.teamId,
    game_id: r.gameId,
    game_date: r.gameDate,
    opponent_name: r.opponentName,
    has_box_score: r.hasBoxScore,
    has_play_by_play: r.hasPlayByPlay,
    scouted_side: r.scoutedSide,
    opponent_side: r.opponentSide,
    box_scouted_batting: r.scouted.boxBatting,
    reconstructed_scouted_batting: r.scouted.reconstructedBatting,
    box_scouted_pitching: r.scouted.boxPitching,
    reconstructed_scouted_pitching_defense: r.scouted.reconstructedPitchingDefense,
    deltas: r.scouted.validation.battingDelta,
    batting_matches_box: r.scouted.validation.battingMatchesBox,
    quality: {
      parsedPlateAppearances: r.parsedPlateAppearances,
      skippedPlays: r.skippedPlays,
      duplicateSkips: r.duplicateSkips,
      unmatchedBatters: r.unmatchedBatters,
      unmatchedPitchers: r.unmatchedPitchers,
      warnings: r.warnings,
    },
  }));

  for (let i = 0; i < gameRows.length; i += 500) {
    const chunk = gameRows.slice(i, i + 500);
    const { error } = await sb.from('game_stat_validation_results').insert(chunk);
    if (error) throw new Error(`[validate] Could not insert game_stat_validation_results: ${error.message}`);
  }

  const verifiedPayload = {
    team_id: summary.teamId,
    run_id: run.id,
    games: summary.games,
    box_score_games: summary.boxScoreGames,
    play_by_play_games: summary.playByPlayGames,
    validated_games: summary.validatedGames,
    mismatch_games: summary.mismatchGames,
    batting_official: summary.officialBatting,
    pitching_official: summary.officialPitching,
    batting_reconstructed: summary.reconstructedBatting,
    pitching_reconstructed: summary.reconstructedPitchingDefense,
    tendencies: summary.tendencies,
    warnings: summary.warnings,
    confidence: summary.confidence,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertError } = await sb
    .from('derived_team_verified_totals')
    .upsert(verifiedPayload, { onConflict: 'team_id' });

  if (upsertError) throw new Error(`[validate] Could not upsert derived_team_verified_totals: ${upsertError.message}`);

  return run.id;
}

async function validateTeam(team, options = {}) {
  console.log('\n' + '='.repeat(70));
  console.log(`${team.team_name} (${team.id})`);
  console.log('='.repeat(70));

  if (typeof db.getGameDataForStatsEngine !== 'function') {
    throw new Error('db.getGameDataForStatsEngine is unavailable. Use the patched db-supabase.js.');
  }

  const games = await Promise.resolve(db.getGameDataForStatsEngine(team.id));
  console.log(`[validate] Loaded ${games.length} reconstructed game object(s).`);

  const validation = reconstructTeamGames(team.id, games);
  const s = validation.summary;

  console.log(`[validate] Box-score games: ${s.boxScoreGames}/${s.games}`);
  console.log(`[validate] Play-by-play games: ${s.playByPlayGames}/${s.games}`);
  console.log(`[validate] Validated games: ${s.validatedGames}/${s.playByPlayGames}`);
  console.log(`[validate] Mismatch games: ${s.mismatchGames}`);
  console.log(`[validate] Confidence: ${s.confidence.toUpperCase()}`);

  console.log('\n[validate] OFFICIAL SCOUTED TEAM BATTING TOTALS, BOX SCORE SOURCE OF TRUTH');
  console.log(`  PA ${s.officialBatting.pa} | AB ${s.officialBatting.ab} | H ${s.officialBatting.h} | BB ${s.officialBatting.bb} | SO ${s.officialBatting.so} | HBP ${s.officialBatting.hbp} | SB ${s.officialBatting.sb}`);

  console.log('\n[validate] PLAY-BY-PLAY RECONSTRUCTED SCOUTED TEAM BATTING');
  console.log(`  PA ${s.reconstructedBatting.pa} | AB ${s.reconstructedBatting.ab} | H ${s.reconstructedBatting.h} | BB ${s.reconstructedBatting.bb} | SO ${s.reconstructedBatting.so} | HBP ${s.reconstructedBatting.hbp}`);
  console.log(`[validate] Deltas reconstructed - box: ${fmt(s.deltas)}`);

  console.log('\n[validate] SIDE-ATTRIBUTED DEFENSIVE/PITCHING EVENTS FROM PLAY-BY-PLAY');
  console.log(`  WP ${s.reconstructedPitchingDefense.wp} | PB ${s.reconstructedPitchingDefense.pb} | Pickoffs ${s.reconstructedPitchingDefense.pickoff}`);

  if (s.warnings.length) {
    console.log('\n[validate] Warnings:');
    for (const warning of s.warnings) console.log(`  - ${warning}`);
  }

  if (!options.dryRun) {
    const runId = await writeValidationToSupabase(team, validation);
    if (runId) console.log(`\n[validate] Saved validation run: ${runId}`);
  } else {
    console.log('\n[validate] Dry run only; nothing written.');
  }

  return validation;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all') || args.includes('-a');
  const cleanArgs = args.filter(a => !['--dry-run', '--all', '-a'].includes(a));

  if (all) {
    const teams = await Promise.resolve(db.getAllTeams());
    for (const team of teams) {
      try {
        await validateTeam(team, { dryRun });
      } catch (err) {
        console.error(`[validate] FAILED for ${team.team_name}: ${err.message}`);
      }
    }
    return;
  }

  if (!cleanArgs.length) {
    console.log('Usage: node src/validate-team-stats.js "Team Name" [--dry-run]');
    console.log('   or: node src/validate-team-stats.js --all');
    process.exit(1);
  }

  const team = await findTeam(cleanArgs.join(' '));
  await validateTeam(team, { dryRun });
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
