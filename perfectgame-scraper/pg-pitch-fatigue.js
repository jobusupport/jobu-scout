'use strict';

/**
 * pg-pitch-fatigue.js
 * Turns structured DiamondKast at-bat/pitch data (see
 * extractDiamondKastPitchByPitch in perfectgame-scraper.js) into two
 * scouting-relevant summaries:
 *
 *   1. analyzePitcherFatigue(atBats, targetTeamName)
 *      Per target-team pitcher, per inning: fastball velocity and
 *      ball/strike-quality ratio, so a coach can see WHEN in the game a
 *      pitcher's velocity and control start to fall off.
 *
 *   2. analyzeStrikeoutSequences(atBats, targetTeamName, opts)
 *      Every at-bat where the TARGET team's batter struck out: the full
 *      pitch sequence (type + speed + call) they saw, in order. Optionally
 *      tagged with game result so losses can be filtered/highlighted.
 *
 * Both take the array returned by extractDiamondKastPitchByPitch() — no DB
 * or Supabase access here, this is pure data transformation so it can be
 * unit-tested against a saved page independent of scraping/storage.
 */

function inningNumber(inningBadge) {
  if (!inningBadge) return null;
  const m = String(inningBadge).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function isBall(play) {
  return /^ball$/i.test(play || '');
}

// Called/swinging strikes AND fouls count toward the "strike-quality" side
// of the ratio — a pitcher losing the zone shows up as a rising ball share
// relative to all of these, not just literal "Ball" calls. Excludes the
// final strikeout pitch itself so it isn't double counted with isStrikeoutFinalPitch.
function isStrikeLike(play) {
  return /strike|foul/i.test(play || '') && !/strike out/i.test(play || '');
}

function isStrikeoutFinalPitch(play) {
  return /strike out/i.test(play || '');
}

function avg(arr) {
  const vals = arr.filter((v) => v != null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

/**
 * @param {Array} atBats - output of extractDiamondKastPitchByPitch
 * @param {string} targetTeamName - the scouted team's name as it appears in
 *   PG's battingTeam field. The target team is PITCHING in any at-bat where
 *   the OPPONENT is batting (battingTeam !== targetTeamName).
 * @returns {Object} keyed by pitcher name
 */
function analyzePitcherFatigue(atBats, targetTeamName) {
  const wanted = String(targetTeamName || '').trim().toLowerCase();
  if (!wanted) return {};

  // pitcher -> inning -> running totals
  const byPitcher = {};

  for (const ab of atBats || []) {
    const battingTeam = String(ab.battingTeam || '').trim().toLowerCase();
    if (!battingTeam || battingTeam === wanted) continue; // target team must be pitching
    if (!ab.pitcher) continue;

    const inn = inningNumber(ab.inning);
    if (inn == null) continue;

    byPitcher[ab.pitcher] = byPitcher[ab.pitcher] || {};
    const perInning = byPitcher[ab.pitcher];
    perInning[inn] = perInning[inn] || {
      fastballSpeeds: [], allSpeeds: [], balls: 0, strikeLike: 0, pitches: 0, strikeouts: 0,
    };
    const bucket = perInning[inn];

    for (const p of ab.pitches || []) {
      if (p.speedMph != null) {
        bucket.allSpeeds.push(p.speedMph);
        if (/fastball/i.test(p.pitchType || '')) bucket.fastballSpeeds.push(p.speedMph);
      }
      if (isBall(p.play)) bucket.balls += 1;
      else if (isStrikeLike(p.play) || isStrikeoutFinalPitch(p.play)) bucket.strikeLike += 1;
      bucket.pitches += 1;
    }

    if (ab.pitches?.length && isStrikeoutFinalPitch(ab.pitches[ab.pitches.length - 1].play)) {
      bucket.strikeouts += 1;
    }
  }

  const result = {};
  for (const [pitcher, perInning] of Object.entries(byPitcher)) {
    const innings = Object.keys(perInning).map(Number).sort((a, b) => a - b);
    const rows = innings.map((inn) => {
      const b = perInning[inn];
      return {
        inning: inn,
        pitches: b.pitches,
        avgFastballMph: avg(b.fastballSpeeds),
        avgAllMph: avg(b.allSpeeds),
        ballPct: b.pitches ? Math.round((b.balls / b.pitches) * 1000) / 10 : null,
        strikePct: b.pitches ? Math.round((b.strikeLike / b.pitches) * 1000) / 10 : null,
        strikeouts: b.strikeouts,
      };
    });

    // Baseline = pitcher's own first two innings with fastball data. Flag the
    // first inning that drifts meaningfully off THEIR OWN baseline — not a
    // fixed league number — since "tiring" is relative to how they started.
    const baselineVelo = avg(rows.slice(0, 2).map((r) => r.avgFastballMph));
    const baselineBallPct = avg(rows.slice(0, 2).map((r) => r.ballPct));

    const veloDrop = baselineVelo != null
      ? rows.find((r) => r.avgFastballMph != null && (baselineVelo - r.avgFastballMph) >= 3)
      : null;
    const controlDrop = baselineBallPct != null
      ? rows.find((r) => r.ballPct != null && (r.ballPct - baselineBallPct) >= 15)
      : null;

    result[pitcher] = {
      byInning: rows,
      baselineFastballMph: baselineVelo,
      baselineBallPct: baselineBallPct,
      veloDropInning: veloDrop ? veloDrop.inning : null,       // first inning fastball fell >=3 MPH off their own baseline
      controlDropInning: controlDrop ? controlDrop.inning : null, // first inning ball% rose >=15 pts off their own baseline
    };
  }

  return result;
}

/**
 * @param {Array} atBats
 * @param {string} targetTeamName
 * @param {Object} [opts]
 * @param {boolean} [opts.gameWasLoss] - tag every returned strikeout with
 *   this so report.js/analyzer.js can filter to losses specifically. This
 *   module doesn't determine W/L itself — pass it in from the game record.
 * @returns {Array} one entry per target-team strikeout, with the full pitch
 *   sequence they saw
 */
function analyzeStrikeoutSequences(atBats, targetTeamName, opts = {}) {
  const wanted = String(targetTeamName || '').trim().toLowerCase();
  if (!wanted) return [];

  const strikeouts = [];

  for (const ab of atBats || []) {
    const battingTeam = String(ab.battingTeam || '').trim().toLowerCase();
    if (battingTeam !== wanted) continue;
    if (!ab.pitches?.length) continue;

    const finalPitch = ab.pitches[ab.pitches.length - 1];
    if (!isStrikeoutFinalPitch(finalPitch.play)) continue;

    strikeouts.push({
      batter: ab.batter,
      pitcher: ab.pitcher,
      inning: ab.inning,
      gameWasLoss: opts.gameWasLoss ?? null,
      pitchSequence: ab.pitches.map((p) => ({
        pitchNumInAB: p.pitchNumInAB,
        type: p.pitchType,
        speedMph: p.speedMph,
        call: p.play,
      })),
      finalPitch: {
        type: finalPitch.pitchType,
        speedMph: finalPitch.speedMph,
        call: finalPitch.play, // "Strike Out Looking" vs "Strike Out Swinging"
      },
    });
  }

  return strikeouts;
}

module.exports = { analyzePitcherFatigue, analyzeStrikeoutSequences };
