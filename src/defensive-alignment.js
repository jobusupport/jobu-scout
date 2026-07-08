'use strict';

/**
 * defensive-alignment.js
 * Voodoo Scout — Defensive Alignment Grid
 *
 * Classifies each scouted-team hitter's O (early-count) and 2K (two-strike)
 * shading INDEPENDENTLY, each from real batted-ball location data:
 *
 *   O  <- player_advanced_stats.spray_by_count.early  (contact made before 2 strikes)
 *   2K <- player_advanced_stats.spray_by_count.twoStrike (contact made at 2 strikes)
 *
 * Both come from stats-engine.js's sprayByCount tracking, which buckets each
 * batted ball using the actual ball-strike count of the in-play pitch — real
 * measured location, not inferred from swing behavior or a fixed rule.
 *
 * Two-strike batted-ball samples are inherently smaller than early-count
 * ones (a lot of 2-strike PAs end in a strikeout or walk rather than a ball
 * in play), so there's a fallback ladder for the 2K column specifically:
 *
 *   1. MEASURED SPRAY  — enough 2K batted balls to classify directly. Best.
 *   2. SWING-DECISION PROXY — too few 2K batted balls, but enough swing_pct
 *      sample (swing_decisions) to tell whether this hitter's approach
 *      changes at two strikes, and ease the O shift accordingly.
 *   3. DEFAULT EASE — neither is available; ease fully to standard as a
 *      safe default rather than guess.
 *
 * IMPORTANT: we do not track batter handedness anywhere in the schema
 * (normalizer.js / db.js), so "pull side" cannot be expressed relative to
 * the hitter — only as an absolute field side. Templates are named LEFT /
 * RIGHT / CENTER / STD rather than PULL / OPPO for that reason.
 */

const SHIFT_THRESHOLD  = 8;  // pct-point gap between sides needed to call a shift
const CENTER_THRESHOLD = 40; // spray_cf_pct needed to call a true CF hitter
const MIN_EARLY_BALLS      = 8; // min early-count batted balls to classify O directly
const MIN_TWOSTRIKE_BALLS  = 5; // min 2K batted balls to classify 2K directly (smaller sample expected)

// Two-strike swing-expansion thresholds (percentage points, 2K swing% minus
// early-count swing%), used only as the fallback proxy when measured 2K
// spray sample is too small.
const FULL_EASE_DELTA = 15;
const NO_EASE_DELTA   = 5;
const MIN_SWING_SAMPLE = 15;

const POSITIONS = ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
const OUTFIELD_POSITIONS = ['LF', 'CF', 'RF'];

const EARLY_COUNTS = ['0-0', '1-0', '2-0', '3-0', '0-1', '1-1', '2-1', '3-1'];
const TWO_STRIKE_COUNTS = ['0-2', '1-2', '2-2', '3-2'];

// Each template's "O" column is what we shade toward when this hitter's
// spray share points that direction. The same table doubles as the
// standard/eased fallback (its own O value is used verbatim as the eased
// 2K code in the swing-decision-proxy and default paths).
const TEMPLATES = {
  LEFT: {   // shade toward LF / 3B / SS gap
    '1B': 'PULL', '2B': 'PULL', '3B': 'PULL', 'SS': 'PULL',
    'LF': 'SU+',  'CF': 'SP+',  'RF': 'SU',
  },
  RIGHT: {  // shade toward RF / 1B / 2B gap
    '1B': 'PULL', '2B': 'PULL', '3B': 'SP', 'SS': 'SP',
    'LF': 'SO',   'CF': 'SU',   'RF': 'SU+',
  },
  CENTER: { // true straightaway hitter
    '1B': 'SP', '2B': 'SP', '3B': 'SP', 'SS': 'SP',
    'LF': 'SO', 'CF': 'SU+', 'RF': 'SO',
  },
  STD: {    // balanced spray, or sample too small to trust a shift
    '1B': 'SP', '2B': 'SP', '3B': 'SU', 'SS': 'SU',
    'LF': 'SU', 'CF': 'SU', 'RF': 'SU',
  },
};

// The "eased toward standard" outfield code for each template — used when
// we fall back to the swing-decision proxy or the safe default, rather than
// a directly-measured 2K classification.
const EASED_OUTFIELD = {
  LEFT:   { LF: 'SO', CF: 'SO', RF: 'SU' },
  RIGHT:  { LF: 'SO', CF: 'SO', RF: 'SO' },
  CENTER: { LF: 'SO', CF: 'SU', RF: 'SO' },
  STD:    { LF: 'SO', CF: 'SO', RF: 'SU' },
};

// One notch back from the O code — used for "partial" easing in the
// swing-decision-proxy path.
const DEINTENSIFY = {
  'SU+': 'SU', 'SP+': 'SP', 'SU': 'SU', 'SP': 'SP', 'SO': 'SO', 'PULL': 'PULL',
};

const HIGHLIGHT_ZONES = {
  LEFT:   ['3B'],
  RIGHT:  ['1B'],
  CENTER: ['CF'],
  STD:    [],
};

const CODE_LEGEND = {
  PULL: 'Shift hard toward that side',
  SP:   'Standard position, no shift',
  SU:   'Standard, shade up the middle',
  SO:   'Standard, ease toward the opposite side',
  'SU+': 'Standard, shade up the middle (deeper)',
  'SP+': 'Standard position (deeper)',
};

function parseJsonField(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * classifySprayShare(pct, battedBalls, minBalls) -> { template, confidence, reason }
 * Shared logic for classifying a side-of-field lean from a spray_*_pct
 * object, used for both the O bucket and (when sample allows) the 2K bucket.
 */
function classifySprayShare(pct = {}, battedBalls, minBalls) {
  if (!battedBalls || battedBalls < minBalls) {
    return {
      template: 'STD', confidence: 'low',
      reason: `Only ${battedBalls || 0} batted ball(s) in this bucket — sample too small to shift confidently.`,
    };
  }

  const lf = pct.LF ?? 0, cf = pct.CF ?? 0, rf = pct.RF ?? 0;
  const b3 = pct['3B'] ?? 0, ss = pct.SS ?? 0, b2 = pct['2B'] ?? 0, b1 = pct['1B'] ?? 0;

  // SS sits between 3B and 2B, so split its share evenly across both sides.
  const leftShare  = lf + b3 + ss * 0.5;
  const rightShare = rf + b1 + b2 + ss * 0.5;

  if (cf >= CENTER_THRESHOLD && cf >= leftShare && cf >= rightShare) {
    return { template: 'CENTER', confidence: 'high', reason: `${cf.toFixed(1)}% to straightaway CF.` };
  }

  const gap = leftShare - rightShare;

  if (gap >= SHIFT_THRESHOLD) {
    return {
      template: 'LEFT',
      confidence: gap >= SHIFT_THRESHOLD * 2 ? 'high' : 'medium',
      reason: `${leftShare.toFixed(1)}% left side vs ${rightShare.toFixed(1)}% right side.`,
    };
  }
  if (-gap >= SHIFT_THRESHOLD) {
    return {
      template: 'RIGHT',
      confidence: -gap >= SHIFT_THRESHOLD * 2 ? 'high' : 'medium',
      reason: `${rightShare.toFixed(1)}% right side vs ${leftShare.toFixed(1)}% left side.`,
    };
  }
  return {
    template: 'STD', confidence: 'medium',
    reason: `Balanced spray (${leftShare.toFixed(1)}% L / ${rightShare.toFixed(1)}% R) — no shift.`,
  };
}

/**
 * computeTwoStrikeEasing(swingDecisions) — fallback proxy, only used when
 * measured 2K spray sample is too small. See module doc for the ladder.
 */
function computeTwoStrikeEasing(swingDecisionsRaw) {
  const sd = parseJsonField(swingDecisionsRaw);

  if (!sd) {
    return { level: 'full', delta: null, sampleSize: 0, reason: 'No swing-decision data — defaulting to standard two-strike easing.' };
  }

  let earlyWeighted = 0, earlyN = 0;
  for (const count of EARLY_COUNTS) {
    const c = sd[count];
    if (!c || !c.n) continue;
    earlyWeighted += (c.swing_pct ?? 0) * c.n;
    earlyN += c.n;
  }
  let twoKWeighted = 0, twoKN = 0;
  for (const count of TWO_STRIKE_COUNTS) {
    const c = sd[count];
    if (!c || !c.n) continue;
    twoKWeighted += (c.swing_pct ?? 0) * c.n;
    twoKN += c.n;
  }

  const sampleSize = earlyN + twoKN;
  if (!earlyN || !twoKN || sampleSize < MIN_SWING_SAMPLE) {
    return {
      level: 'full', delta: null, sampleSize,
      reason: `Only ${sampleSize} pitch(es) of swing-decision data — too thin to trust, defaulting to standard easing.`,
    };
  }

  const earlySwingPct = earlyWeighted / earlyN;
  const twoStrikeSwingPct = twoKWeighted / twoKN;
  const delta = +(twoStrikeSwingPct - earlySwingPct).toFixed(1);

  let level, reason;
  if (delta >= FULL_EASE_DELTA) {
    level = 'full';
    reason = `Swing% jumps ${delta} pts at two strikes (${earlySwingPct.toFixed(0)}% \u2192 ${twoStrikeSwingPct.toFixed(0)}%) \u2014 ease shift to standard.`;
  } else if (delta <= NO_EASE_DELTA) {
    level = 'none';
    reason = `Swing% barely changes at two strikes (${delta >= 0 ? '+' : ''}${delta} pts) \u2014 hold the shift.`;
  } else {
    level = 'partial';
    reason = `Swing% rises moderately at two strikes (+${delta} pts) \u2014 ease off one notch.`;
  }
  return { level, delta, sampleSize, reason };
}

/**
 * classifyHitter(stats) -> { template, grid, highlightZones, confidence, reason, twoStrikeMethod, twoStrikeDetail }
 *
 * `stats` is one row from db.getPlayerAdvancedStats(teamId, 0) — the
 * SCOUTED TEAM'S OWN hitters (is_our_team = 0), not bundle.opponentBatters
 * (is_our_team = 1 — batters from every team the scouted team has faced,
 * mixed together — not useful for shading against this specific team).
 */
function classifyHitter(stats = {}) {
  const battedBalls = (stats.gb ?? 0) + (stats.fb ?? 0) + (stats.ld ?? 0);

  const sprayByCount = parseJsonField(stats.spray_by_count || stats.sprayByCount) || {};
  const earlyBucket = sprayByCount.early || { pct: {}, n: 0 };
  const twoKBucket   = sprayByCount.twoStrike || { pct: {}, n: 0 };

  // O classification: prefer the real early-count bucket; fall back to
  // season-total spray_*_pct if spray_by_count hasn't been backfilled yet
  // for this row (e.g. before a recalculate-team-stats.js run).
  const hasEarlyBucket = earlyBucket.n >= MIN_EARLY_BALLS;
  const oSource = hasEarlyBucket
    ? { pct: earlyBucket.pct, n: earlyBucket.n, label: 'measured early-count spray' }
    : {
        pct: {
          LF: stats.spray_lf_pct, CF: stats.spray_cf_pct, RF: stats.spray_rf_pct,
          '3B': stats.spray_3b_pct, SS: stats.spray_ss_pct, '2B': stats.spray_2b_pct, '1B': stats.spray_1b_pct,
        },
        n: battedBalls,
        label: 'season-total spray (spray_by_count not available)',
      };

  const oClass = classifySprayShare(oSource.pct, oSource.n, MIN_EARLY_BALLS);
  const oTemplate = oClass.template;
  const oGrid = TEMPLATES[oTemplate];

  // 2K classification: try measured 2K spray first.
  let twoStrikeMethod, twoKGrid, twoStrikeDetail;

  if (twoKBucket.n >= MIN_TWOSTRIKE_BALLS) {
    const kClass = classifySprayShare(twoKBucket.pct, twoKBucket.n, MIN_TWOSTRIKE_BALLS);
    twoStrikeMethod = 'measured_spray';
    twoKGrid = TEMPLATES[kClass.template];
    twoStrikeDetail = { template: kClass.template, n: twoKBucket.n, reason: `2K spray: ${kClass.reason}` };
  } else {
    // Fall back to the swing-decision proxy, easing the O template.
    const easing = computeTwoStrikeEasing(stats.swingDecisions || stats.swing_decisions);
    twoStrikeMethod = 'swing_decision_proxy';
    twoKGrid = { ...oGrid };
    for (const pos of OUTFIELD_POSITIONS) {
      if (easing.level === 'none') {
        twoKGrid[pos] = oGrid[pos];
      } else if (easing.level === 'partial') {
        twoKGrid[pos] = DEINTENSIFY[oGrid[pos]] ?? oGrid[pos];
      } else {
        twoKGrid[pos] = EASED_OUTFIELD[oTemplate][pos];
      }
    }
    twoStrikeDetail = {
      template: null, n: twoKBucket.n,
      reason: `Only ${twoKBucket.n} measured 2K batted ball(s) (need ${MIN_TWOSTRIKE_BALLS}+) \u2014 used swing-decision proxy instead: ${easing.reason}`,
      easingLevel: easing.level,
    };
  }

  // Merge into a single per-position [O, 2K] grid. Infield never varies by
  // count in either path.
  const grid = {};
  for (const pos of POSITIONS) {
    if (OUTFIELD_POSITIONS.includes(pos)) {
      grid[pos] = [oGrid[pos], twoKGrid[pos]];
    } else {
      grid[pos] = [oGrid[pos], oGrid[pos]];
    }
  }

  return {
    template: oTemplate, // primary/O-side template, used for highlight zone + threat-row styling
    grid,
    highlightZones: HIGHLIGHT_ZONES[oTemplate],
    confidence: oClass.confidence,
    reason: `O: ${oClass.reason} (${oSource.label}, n=${oSource.n})`,
    twoStrikeMethod,   // 'measured_spray' | 'swing_decision_proxy'
    twoStrikeDetail,
  };
}

/**
 * buildAlignmentRows(playerAdvancedRows, lineupOrder, threatByName)
 *
 * Joins the classification above with:
 *  - real batting-order data from db.getTeamLineupOrder()
 *  - AI-assigned threat level from analysis.playerBreakdowns[].threatLevel
 *    or battingAnalysis.protectedHitters[].threat (high|medium|low only)
 *
 * Returns rows sorted by empirical batting order, ready for the docx/HTML
 * table builders.
 */
function buildAlignmentRows(playerAdvancedRows = [], lineupOrder = [], threatByName = {}) {
  const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

  const orderMap = {};
  lineupOrder.forEach((row) => {
    orderMap[norm(row.player_name)] = row.most_common_order ?? row.avg_order ?? null;
  });

  const rows = playerAdvancedRows.map((stats) => {
    const classification = classifyHitter(stats);
    const key = norm(stats.player_name);
    return {
      name: stats.player_name,
      threat: threatByName[key] || threatByName[stats.player_name] || 'low',
      battingOrder: orderMap[key] ?? null,
      hasRealLineupData: orderMap[key] != null,
      ...classification,
    };
  });

  rows.sort((a, b) => {
    if (a.battingOrder == null && b.battingOrder == null) return 0;
    if (a.battingOrder == null) return 1;
    if (b.battingOrder == null) return -1;
    return a.battingOrder - b.battingOrder;
  });

  return rows;
}

module.exports = {
  POSITIONS,
  TEMPLATES,
  HIGHLIGHT_ZONES,
  CODE_LEGEND,
  classifyHitter,
  classifySprayShare,
  computeTwoStrikeEasing,
  buildAlignmentRows,
};
