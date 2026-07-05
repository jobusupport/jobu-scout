'use strict';

/**
 * defensive-alignment.js
 * Classifies an opponent hitter into one of four validated defensive
 * alignment templates, driven entirely by real spray/batted-ball data
 * already stored on player_advanced_stats (no handedness field exists
 * anywhere in the schema, so this is field-side, not pull/oppo-relative).
 */

const SHIFT_THRESHOLD  = 8;  // pct-point gap between sides to call a shift
const CENTER_THRESHOLD = 40; // spray_cf_pct needed to call a true CF hitter
const MIN_BATTED_BALLS = 8;  // below this, sample is too thin to shift on

// Codes ending in "+" mark the hitter's primary shift zone (used by
// report.js to apply the blue highlight). Codes are the four already-
// validated templates — do not invent new codes per player.
const TEMPLATES = {
  LEFT: {   // spray skews toward the LF/3B/SS side of the field
    '1B': ['PULL', 'PULL'], '2B': ['PULL', 'PULL'], '3B': ['PULL', 'PULL'], 'SS': ['PULL', 'PULL'],
    'LF': ['SU+', 'SO'],    'CF': ['SP+', 'SO'],    'RF': ['SU', 'SU'],
  },
  RIGHT: {  // spray skews toward the RF/1B/2B side of the field
    '1B': ['PULL', 'PULL'], '2B': ['PULL', 'PULL'], '3B': ['SP', 'SP'], 'SS': ['SP', 'SP'],
    'LF': ['SO', 'SO'],     'CF': ['SU', 'SO'],     'RF': ['SU+', 'SO'],
  },
  CENTER: { // strong straightaway plurality
    '1B': ['SP', 'SP'], '2B': ['SP', 'SP'], '3B': ['SP', 'SP'], 'SS': ['SP', 'SP'],
    'LF': ['SO', 'SO'], 'CF': ['SU+', 'SU'], 'RF': ['SO', 'SO'],
  },
  STD: {    // balanced spray, or insufficient sample — no shift
    '1B': ['SP', 'SP'], '2B': ['SP', 'SP'], '3B': ['SU', 'SU'], 'SS': ['SU', 'SU'],
    'LF': ['SU', 'SO'], 'CF': ['SU', 'SO'], 'RF': ['SU', 'SO'],
  },
};

/**
 * classifyHitter(stats) -> { template, grid, confidence, reason }
 * `stats` = one row from player_advanced_stats for this hitter
 * (i.e. what report.js's getAdv(playerName) returns from a._playerAdvanced).
 */
function classifyHitter(stats = {}) {
  const battedBalls = stats.batted_balls ?? ((stats.gb ?? 0) + (stats.fb ?? 0) + (stats.ld ?? 0));

  if (!battedBalls || battedBalls < MIN_BATTED_BALLS) {
    return {
      template: 'STD',
      grid: TEMPLATES.STD,
      confidence: 'low',
      reason: `Only ${battedBalls || 0} batted balls tracked — sample too small to shift confidently.`,
    };
  }

  const lf = stats.spray_lf_pct ?? 0;
  const cf = stats.spray_cf_pct ?? 0;
  const rf = stats.spray_rf_pct ?? 0;
  const b3 = stats.spray_3b_pct ?? 0;
  const ss = stats.spray_ss_pct ?? 0;
  const b2 = stats.spray_2b_pct ?? 0;
  const b1 = stats.spray_1b_pct ?? 0;

  // SS sits between 3B and 2B, split its share evenly across both sides.
  const leftShare  = lf + b3 + ss * 0.5;
  const rightShare = rf + b1 + b2 + ss * 0.5;

  if (cf >= CENTER_THRESHOLD && cf >= leftShare && cf >= rightShare) {
    return {
      template: 'CENTER', grid: TEMPLATES.CENTER, confidence: 'high',
      reason: `${cf.toFixed(1)}% of batted balls to straightaway CF.`,
    };
  }

  const gap = leftShare - rightShare;

  if (gap >= SHIFT_THRESHOLD) {
    return {
      template: 'LEFT', grid: TEMPLATES.LEFT,
      confidence: gap >= SHIFT_THRESHOLD * 2 ? 'high' : 'medium',
      reason: `${leftShare.toFixed(1)}% left side vs ${rightShare.toFixed(1)}% right side.`,
    };
  }

  if (-gap >= SHIFT_THRESHOLD) {
    return {
      template: 'RIGHT', grid: TEMPLATES.RIGHT,
      confidence: -gap >= SHIFT_THRESHOLD * 2 ? 'high' : 'medium',
      reason: `${rightShare.toFixed(1)}% right side vs ${leftShare.toFixed(1)}% left side.`,
    };
  }

  return {
    template: 'STD', grid: TEMPLATES.STD, confidence: 'medium',
    reason: `Balanced spray (${leftShare.toFixed(1)}% L / ${rightShare.toFixed(1)}% R) — no shift.`,
  };
}

module.exports = { classifyHitter, TEMPLATES };
