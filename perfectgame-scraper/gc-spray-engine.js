/**
 * gc-spray-engine.js
 * Voodoo Scout — GameChanger Play-by-Play Spray Zone Engine
 *
 * Reads GC play-by-play from SQLite, maps each batted ball event to one of
 * the 10 PG fan zones using fielder position logic, and generates:
 *   1. Per-player zone hit data JSON (authoritative source)
 *   2. Heat map PNG per player (zone-shaded fan diagram with hit dots)
 *   3. PG vs GC discrepancy report (plain text, email-ready)
 *
 * Zone layout (10 zones, left-to-right):
 *   Infield:  [3B] [SS] [P/Mid] [2B] [1B]
 *   Outfield: [LF-deep] [LF-gap] [CF] [RF-gap] [RF-deep]
 *
 * Fielder → zone mapping accounts for batter handedness:
 *   RHB: pull = left side (3B/SS/LF), oppo = right side (1B/2B/RF)
 *   LHB: pull = right side (1B/2B/RF), oppo = left side (3B/SS/LF)
 *
 * Usage:
 *   const engine = require('./gc-spray-engine');
 *   await engine.buildTeamSprayData(db, teamName, pgSprayData, outputDir);
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Zone definitions — mirrors pg-spray-scraper.js
// ---------------------------------------------------------------------------
const ZONE_IDS = [
  "IF_3B", "IF_SS", "IF_P", "IF_2B", "IF_1B",
  "OF_LF_D", "OF_LF_G", "OF_CF", "OF_RF_G", "OF_RF_D",
];

// Fan geometry for SVG rendering
// Origin: tip of the fan (home plate) at (250, 420) in a 500×440 canvas
// The fan opens upward. Each zone is a wedge of the fan.
// We define each zone as { startAngle, endAngle, innerRadius, outerRadius }
// Angles in degrees, 0 = straight up, positive = clockwise
const FAN = {
  origin: { x: 250, y: 420 },
  infieldInnerR:  40,
  infieldOuterR:  180,
  outfieldInnerR: 185,
  outfieldOuterR: 390,
  // Total fan spans from -60° (right field line) to +60° (left field line)
  // Each of 5 zones covers 24°
  zones: {
    // Infield (bottom row) — left to right = 3B to 1B
    // From a RHB perspective: pull side is left (3B), oppo is right (1B)
    IF_3B:   { startDeg: -60, endDeg: -36, inner: 40,  outer: 180 },
    IF_SS:   { startDeg: -36, endDeg: -12, inner: 40,  outer: 180 },
    IF_P:    { startDeg: -12, endDeg:  12, inner: 40,  outer: 180 },
    IF_2B:   { startDeg:  12, endDeg:  36, inner: 40,  outer: 180 },
    IF_1B:   { startDeg:  36, endDeg:  60, inner: 40,  outer: 180 },
    // Outfield (top row)
    OF_LF_D: { startDeg: -60, endDeg: -36, inner: 185, outer: 390 },
    OF_LF_G: { startDeg: -36, endDeg: -12, inner: 185, outer: 390 },
    OF_CF:   { startDeg: -12, endDeg:  12, inner: 185, outer: 390 },
    OF_RF_G: { startDeg:  12, endDeg:  36, inner: 185, outer: 390 },
    OF_RF_D: { startDeg:  36, endDeg:  60, inner: 185, outer: 390 },
  }
};

// ---------------------------------------------------------------------------
// Fielder number → zone mapping
// POS: 1=P, 2=C, 3=1B, 4=2B, 5=3B, 6=SS, 7=LF, 8=CF, 9=RF
// Returns { zoneId, fieldingArea } for a RIGHT-HANDED batter.
// For LHB we mirror the left/right zones.
// ---------------------------------------------------------------------------
const FIELDER_TO_ZONE_RHB = {
  1:  "IF_P",     // Pitcher
  2:  null,       // Catcher — not a batted-ball zone (foul tip, dropped 3rd, etc.)
  3:  "IF_1B",
  4:  "IF_2B",
  5:  "IF_3B",
  6:  "IF_SS",
  7:  "OF_LF_D",  // Default LF → deep left; gap determined by hit type context
  8:  "OF_CF",
  9:  "OF_RF_D",  // Default RF → deep right
};

// For a LHB, left side becomes oppo and right side becomes pull — mirror L/R zones
const LHB_MIRROR = {
  IF_3B:   "IF_1B",
  IF_SS:   "IF_2B",
  IF_P:    "IF_P",
  IF_2B:   "IF_SS",
  IF_1B:   "IF_3B",
  OF_LF_D: "OF_RF_D",
  OF_LF_G: "OF_RF_G",
  OF_CF:   "OF_CF",
  OF_RF_G: "OF_LF_G",
  OF_RF_D: "OF_LF_D",
};

// Foul territory positions (not on the main fan)
const FOUL_ZONE_CATCHER = "FOUL_CATCHER";

// ---------------------------------------------------------------------------
// GC play-by-play text parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single play-by-play text string.
 * Returns {
 *   batter, pitcher, result, hitType, firstFielder, fielderNum,
 *   isHit, isOut, isFoul, isStrikeout, isWalk, isHomeRun,
 *   rawText
 * }
 */
function parsePlayText(text) {
  const raw = String(text || "");
  const upper = raw.toUpperCase().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  // Hit type — explicit terms in GC
  let hitType = null;
  if (/GROUND\s*BALL|GROUNDER/.test(upper)) hitType = "ground_ball";
  else if (/LINE\s*DRIVE/.test(upper))      hitType = "line_drive";
  else if (/FLY\s*BALL|FLYBALL/.test(upper)) hitType = "fly_ball";
  else if (/POP\s*(?:UP|OUT)|POPUP/.test(upper)) hitType = "popup";
  else if (/BUNT/.test(upper))               hitType = "bunt";

  // Foul ball
  const isFoul = /FOUL/.test(upper);

  // Outcome
  const isStrikeout = /STRIKEOUT|STRUCK OUT|STRIKES OUT/.test(upper);
  const isWalk      = /\bWALK\b|WALKS|BASE ON BALLS/.test(upper);
  const isHomeRun   = /HOME RUN|HOMER|HR\b/.test(upper);
  const isHit       = !isOut(upper) && !isStrikeout && !isWalk &&
                      (/SINGLE|DOUBLE|TRIPLE|HOME RUN|REACHES|HIT BY PITCH/.test(upper) ||
                       /GROUND(?:ED)?\s+(?:BALL\s+)?(?:THROUGH|BETWEEN|OVER|INTO|TO\s+(?:LEFT|RIGHT|CENTER))/.test(upper));

  function isOut(u) {
    return /\bOUT\b|FLIES OUT|GROUNDS OUT|LINES OUT|POPS OUT|DOUBLE PLAY|TRIPLE PLAY/.test(u);
  }

  // First fielder — the first position number or position name mentioned after the hit type
  // GC uses formats like:
  //   "ground ball to 3rd baseman to 1st baseman, out"
  //   "fly ball to left fielder"
  //   "line drive to second baseman"
  //   "pop out to catcher"
  //   "ground ball, 6-4-3 double play"   ← first digit is first fielder

  let firstFielderNum = null;
  let firstFielderText = "";

  // Named position patterns
  const positionNames = [
    { pattern: /(?:TO\s+)?PITCH(?:ER)?(?:\s+\d+)?/,    num: 1  },
    { pattern: /(?:TO\s+)?CATCH(?:ER)?(?:\s+\d+)?/,    num: 2  },
    { pattern: /(?:TO\s+)?FIRST\s*(?:BASE(?:MAN)?)?/,  num: 3  },
    { pattern: /(?:TO\s+)?SECOND\s*(?:BASE(?:MAN)?)?/, num: 4  },
    { pattern: /(?:TO\s+)?THIRD\s*(?:BASE(?:MAN)?)?/,  num: 5  },
    { pattern: /(?:TO\s+)?SHORT\s*STOP|SHORTSTOP/,     num: 6  },
    { pattern: /(?:TO\s+)?LEFT\s*FIELD(?:ER)?/,        num: 7  },
    { pattern: /(?:TO\s+)?CENTER\s*FIELD(?:ER)?/,      num: 8  },
    { pattern: /(?:TO\s+)?RIGHT\s*FIELD(?:ER)?/,       num: 9  },
  ];

  // First try named positions
  let earliestIdx = Infinity;
  for (const { pattern, num } of positionNames) {
    const m = upper.match(pattern);
    if (m && m.index < earliestIdx) {
      earliestIdx = m.index;
      firstFielderNum = num;
      firstFielderText = m[0];
    }
  }

  // If no named position found, try numeric sequence (e.g. "6-4-3" → 6 is first)
  if (!firstFielderNum) {
    const numericSeq = upper.match(/\b([1-9])(?:-[1-9])+\b/);
    if (numericSeq) {
      firstFielderNum = parseInt(numericSeq[1], 10);
      firstFielderText = numericSeq[0];
    }
  }

  // Single numeric position after "TO"
  if (!firstFielderNum) {
    const singleNum = upper.match(/\bTO\s+([1-9])\b/);
    if (singleNum) firstFielderNum = parseInt(singleNum[1], 10);
  }

  return {
    rawText:         raw,
    hitType,
    isFoul,
    isStrikeout,
    isWalk,
    isHomeRun,
    isOut:           isOut(upper),
    isHit,
    firstFielderNum,
    firstFielderText,
  };
}

/**
 * Map a parsed play to a zone ID, accounting for batter handedness.
 * bats: "R", "L", or "S" (switch)
 * Returns { zoneId, confidence } where confidence is "high" or "low"
 */
function playToZone(parsedPlay, bats) {
  const { firstFielderNum, hitType, isFoul, isStrikeout, isWalk, isHomeRun } = parsedPlay;

  // Non-batted-ball events
  if (isStrikeout) return { zoneId: null, reason: "strikeout" };
  if (isWalk)      return { zoneId: null, reason: "walk" };

  // Home run — center fan dot at deep CF by default (no fielder)
  if (isHomeRun)   return { zoneId: "OF_CF", confidence: "low", reason: "home_run" };

  // Catcher involvement = foul ball territory
  if (firstFielderNum === 2)
    return { zoneId: FOUL_ZONE_CATCHER, confidence: "high", reason: "catcher_foul" };

  if (!firstFielderNum) return { zoneId: null, reason: "no_fielder_identified" };

  // Get RHB zone
  let zoneId = FIELDER_TO_ZONE_RHB[firstFielderNum] || null;
  if (!zoneId) return { zoneId: null, reason: `unknown_fielder_${firstFielderNum}` };

  // Mirror for LHB
  const effectiveBats = String(bats || "R").toUpperCase();
  if (effectiveBats === "L" && LHB_MIRROR[zoneId]) {
    zoneId = LHB_MIRROR[zoneId];
  }
  // Switch hitters: we can't determine orientation without knowing pitcher hand
  // Mark as low confidence
  const confidence = effectiveBats === "S" ? "low" : "high";

  // Refine OF zones using hit type context:
  // If LF/RF fielder and we have hit type, we can guess gap vs deep
  if (firstFielderNum === 7) {
    // Left fielder — if it was a line drive it's more likely LF-gap, fly = LF-deep
    if (hitType === "line_drive") zoneId = effectiveBats === "L" ? "OF_RF_G" : "OF_LF_G";
    else                          zoneId = effectiveBats === "L" ? "OF_RF_D" : "OF_LF_D";
  } else if (firstFielderNum === 9) {
    if (hitType === "line_drive") zoneId = effectiveBats === "L" ? "OF_LF_G" : "OF_RF_G";
    else                          zoneId = effectiveBats === "L" ? "OF_LF_D" : "OF_RF_D";
  }

  return { zoneId, confidence, reason: "fielder_position" };
}

// ---------------------------------------------------------------------------
// SQLite query helpers
// The GC SQLite schema (from Phases 1-2) is assumed to have tables:
//   teams, games, box_score_players, play_by_play
// Adjust table/column names to match your actual schema.
// ---------------------------------------------------------------------------

/**
 * Get all play-by-play records for games involving a given opponent team.
 * Uses the actual GC schema:
 *   games.opponent_name, games.team_id → teams.team_name
 *   play_events.description = play text
 *   play_events.inning_half = "top" | "bottom"
 */
async function getPlaysForOpponent(db, opponentTeamName) {
  return new Promise((resolve, reject) => {
    // Games where this team was the opponent
    // Also join teams so we have our team name for context
    const sql = `
      SELECT
        g.id                AS game_id,
        g.game_date,
        g.opponent_name,
        t.team_name         AS our_team_name,
        p.id                AS play_id,
        p.sequence_num,
        p.inning_num        AS inning,
        p.inning_half       AS half,
        p.event_type,
        p.batter_name,
        p.pitcher_name,
        p.description       AS play_text,
        p.outs_before,
        p.result_rbi,
        p.is_scoring_play
      FROM play_events p
      JOIN games g ON g.id = p.game_id
      JOIN teams t ON t.id = g.team_id
      -- Confirm batter is on opponent side via batting_lines (is_our_team = 0)
      JOIN batting_lines bl ON
        bl.game_id = p.game_id AND
        bl.player_name = p.batter_name AND
        bl.is_our_team = 0
      WHERE
        LOWER(g.opponent_name) LIKE LOWER(?)
        AND p.batter_name IS NOT NULL
        AND p.batter_name != ''
        AND p.description IS NOT NULL
        AND p.description != ''
      ORDER BY g.game_date, g.id, p.sequence_num
    `;
    const like = `%${opponentTeamName}%`;
    db.all(sql, [like], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/**
 * Get the box score batting lines for each game — used for per-game roster.
 * batting_lines has is_our_team flag so we can isolate opponent batters.
 * Returns array of { game_id, player_name, position, batting_order, team_name_raw }
 */
async function getBoxScoreRosters(db, opponentTeamName) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT
        b.game_id,
        b.player_name,
        b.position,
        b.batting_order,
        b.team_name_raw,
        b.is_our_team,
        b.team_side
      FROM batting_lines b
      JOIN games g ON g.id = b.game_id
      WHERE
        LOWER(g.opponent_name) LIKE LOWER(?)
        AND b.is_our_team = 0
        AND b.player_name IS NOT NULL
        AND b.player_name != ''
      ORDER BY b.game_id, b.batting_order
    `;
    const like = `%${opponentTeamName}%`;
    db.all(sql, [like], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// ---------------------------------------------------------------------------
// Build per-player zone hit map from GC plays
// ---------------------------------------------------------------------------

/**
 * Given all plays for a team, build a map of:
 *   playerName → { zoneHits: {zoneId: count}, hitEvents: [...], bats }
 * pgRoster is the array from pg-spray-data.json (for handedness lookup)
 */
function buildPlayerZoneMap(plays, pgRosterPlayers) {
  // Build handedness lookup from PG data
  const handedness = {};
  for (const p of (pgRosterPlayers || [])) {
    if (p.player || p.name) {
      const key = normalizePlayerName(p.player || p.name);
      handedness[key] = p.effectiveBats || p.bio?.bats || p.rosterBio?.bats || "R";
    }
  }

  const playerMap = {};

  for (const play of plays) {
    const batter = normalizePlayerName(play.batter_name);
    if (!batter) continue;

    const parsed = parsePlayText(play.play_text);

    // Skip non-batted-ball events for zone mapping
    if (parsed.isStrikeout || parsed.isWalk) continue;
    if (!parsed.hitType && !parsed.firstFielderNum && !parsed.isHomeRun) continue;

    if (!playerMap[batter]) {
      playerMap[batter] = {
        name:       play.batter_name,
        bats:       handedness[batter] || "R",
        zoneHits:   {},
        hitEvents:  [],
        games:      new Set(),
      };
      // Initialize all zones to 0
      for (const z of ZONE_IDS) playerMap[batter].zoneHits[z] = 0;
      playerMap[batter].zoneHits[FOUL_ZONE_CATCHER] = 0;
    }

    const entry = playerMap[batter];
    entry.games.add(play.game_id);

    const { zoneId, confidence, reason } = playToZone(parsed, entry.bats);

    const event = {
      game_id:     play.game_id,
      game_date:   play.game_date,
      inning:      play.inning,
      half:        play.half,
      hitType:     parsed.hitType,
      firstFielder: parsed.firstFielderNum,
      zoneId,
      confidence,
      reason,
      isHit:       parsed.isHit,
      isOut:       parsed.isOut,
      isFoul:      parsed.isFoul,
      rawText:     play.play_text,
    };

    entry.hitEvents.push(event);

    if (zoneId) {
      entry.zoneHits[zoneId] = (entry.zoneHits[zoneId] || 0) + 1;
    }
  }

  // Convert game sets to counts
  for (const entry of Object.values(playerMap)) {
    entry.gameCount = entry.games.size;
    delete entry.games;

    // Calculate zone percentages
    const total = Object.values(entry.zoneHits).reduce((s, v) => s + v, 0);
    entry.totalBattedBalls = total;
    entry.zonePercents = {};
    for (const [z, count] of Object.entries(entry.zoneHits)) {
      entry.zonePercents[z] = total > 0 ? Math.round((count / total) * 100) : 0;
    }
  }

  return playerMap;
}

function normalizePlayerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// SVG heat map generator
// Produces a fan-shaped heat map with:
//   - Zone shading intensity proportional to hit frequency (GC data)
//   - Zone percentage labels
//   - Individual hit event dots (color-coded by hit type)
//   - PG cross-reference counts shown in a side panel
//   - Batter name, handedness, and switch-hitter caveat if applicable
// ---------------------------------------------------------------------------

function degToRad(deg) { return (deg * Math.PI) / 180; }

/**
 * Generate SVG path data for a fan wedge.
 * origin: {x, y}, startDeg, endDeg relative to straight up (0° = 12 o'clock),
 * innerR, outerR
 */
function fanWedgePath(origin, startDeg, endDeg, innerR, outerR) {
  // Convert: 0° = up = -90° in standard math, clockwise positive
  // SVG Y-axis is inverted (positive down), so we need to flip
  // Fan opens upward: straight up = 0°, left = -60°, right = +60°
  // In SVG coords (Y down): up = -Y direction
  // angle 0° (straight up) → SVG direction: (0, -1)
  // angle θ clockwise → SVG: (sin(θ), -cos(θ))
  const toSVG = (deg) => {
    const rad = degToRad(deg);
    return {
      x: origin.x + Math.sin(rad) * outerR,
      y: origin.y - Math.cos(rad) * outerR,
    };
  };
  const toSVGInner = (deg) => {
    const rad = degToRad(deg);
    return {
      x: origin.x + Math.sin(rad) * innerR,
      y: origin.y - Math.cos(rad) * innerR,
    };
  };

  const outerStart = toSVG(startDeg);
  const outerEnd   = toSVG(endDeg);
  const innerStart = toSVGInner(startDeg);
  const innerEnd   = toSVGInner(endDeg);

  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;

  return [
    `M ${innerStart.x.toFixed(1)} ${innerStart.y.toFixed(1)}`,
    `L ${outerStart.x.toFixed(1)} ${outerStart.y.toFixed(1)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x.toFixed(1)} ${outerEnd.y.toFixed(1)}`,
    `L ${innerEnd.x.toFixed(1)} ${innerEnd.y.toFixed(1)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x.toFixed(1)} ${innerStart.y.toFixed(1)}`,
    "Z",
  ].join(" ");
}

/**
 * Get the center point of a wedge (for label placement).
 */
function wedgeCenter(origin, startDeg, endDeg, innerR, outerR) {
  const midDeg = (startDeg + endDeg) / 2;
  const midR   = (innerR + outerR) / 2;
  const rad    = degToRad(midDeg);
  return {
    x: origin.x + Math.sin(rad) * midR,
    y: origin.y - Math.cos(rad) * midR,
  };
}

/**
 * Heat color: white (0 hits) → light blue → dark blue (max hits)
 * Returns hex color string.
 */
function heatColor(count, maxCount) {
  if (!count || !maxCount) return "#f8f9fa";
  const intensity = Math.min(count / maxCount, 1);
  // Interpolate: white (#fff) → steel blue (#2171b5)
  const r = Math.round(255 - intensity * (255 - 33));
  const g = Math.round(255 - intensity * (255 - 113));
  const b = Math.round(255 - intensity * (255 - 181));
  return `rgb(${r},${g},${b})`;
}

/**
 * Hit dot color by hit type.
 */
function dotColor(hitType, isHit) {
  if (!isHit) return "#e74c3c";  // red = out
  switch (hitType) {
    case "ground_ball": return "#27ae60";  // green
    case "line_drive":  return "#2980b9";  // blue
    case "fly_ball":    return "#f39c12";  // orange
    case "popup":       return "#8e44ad";  // purple
    case "bunt":        return "#16a085";  // teal
    default:            return "#2ecc71";  // light green
  }
}

/**
 * Convert normalized dot position (0-1) back to SVG fan coordinates.
 * PG fan origin is at bottom center. We approximate dot placement
 * within the fan zone using the zone's angular midpoint.
 */
function zoneDotPosition(zoneId, jitterSeed, origin) {
  const zone = FAN.zones[zoneId];
  if (!zone) return null;

  // Use jitter to spread dots within zone
  const jitter = (seed, range) => ((seed * 2654435761) % 1000) / 1000 * range - range / 2;

  const angularSpread = zone.endDeg - zone.startDeg;
  const radialSpread  = zone.outer - zone.inner;

  const midDeg = (zone.startDeg + zone.endDeg) / 2;
  const midR   = (zone.inner + zone.outer) / 2;

  const deg = midDeg + jitter(jitterSeed, angularSpread * 0.6);
  const r   = midR   + jitter(jitterSeed + 1, radialSpread * 0.5);
  const rad = degToRad(deg);

  return {
    x: origin.x + Math.sin(rad) * r,
    y: origin.y - Math.cos(rad) * r,
  };
}

/**
 * Generate the full SVG heat map for one player.
 * Returns an SVG string.
 */
function generateHeatMapSVG(playerName, gcZoneData, pgSprayData, bats, isSwitchHitter) {
  const W = 680, H = 500;
  const origin = FAN.origin;

  const zoneHits    = gcZoneData?.zoneHits    || {};
  const zonePercents= gcZoneData?.zonePercents || {};
  const hitEvents   = gcZoneData?.hitEvents   || [];

  const maxHits = Math.max(...ZONE_IDS.map(z => zoneHits[z] || 0), 1);

  // PG reference data (All filter)
  const pgAll     = pgSprayData?.sprayData?.all;
  const pgInfield  = pgAll?.infield  || {};
  const pgOutfield = pgAll?.outfield || {};

  const pgZoneMap = {
    IF_3B:   pgInfield["3B"]   ?? "—",
    IF_SS:   pgInfield["SS"]   ?? "—",
    IF_P:    pgInfield["P"]    ?? "—",
    IF_2B:   pgInfield["2B"]   ?? "—",
    IF_1B:   pgInfield["1B"]   ?? "—",
    OF_LF_D: pgOutfield["LF_deep"] ?? "—",
    OF_LF_G: pgOutfield["LF_gap"]  ?? "—",
    OF_CF:   pgOutfield["CF"]      ?? "—",
    OF_RF_G: pgOutfield["RF_gap"]  ?? "—",
    OF_RF_D: pgOutfield["RF_deep"] ?? "—",
  };

  // Fan background color
  const fanBg = "#1a472a";

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, sans-serif">`;

  // Background
  svg += `<rect width="${W}" height="${H}" fill="#ffffff" rx="8"/>`;

  // Title
  const handLabel = isSwitchHitter ? "S/?" : bats === "L" ? "LHB" : "RHB";
  const switchNote = isSwitchHitter ? " (switch hitter — orientation varies)" : "";
  svg += `<text x="${W/2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#1a1a1a">${escXml(playerName)} · ${escXml(handLabel)}${escXml(switchNote)}</text>`;
  svg += `<text x="${W/2}" y="46" text-anchor="middle" font-size="11" fill="#666">GC Play-by-Play Spray Chart · Authoritative hit location data</text>`;

  // Fan zones — shaded by hit frequency
  for (const zoneId of ZONE_IDS) {
    const zone  = FAN.zones[zoneId];
    if (!zone) continue;
    const d     = fanWedgePath(origin, zone.startDeg, zone.endDeg, zone.inner, zone.outer);
    const color = heatColor(zoneHits[zoneId] || 0, maxHits);
    svg += `<path d="${d}" fill="${color}" stroke="#fff" stroke-width="1.5" opacity="0.92"/>`;
  }

  // Zone boundary lines (fan outline)
  // Outer arc
  const outerArcPath = (() => {
    const o = origin;
    const r = FAN.outfieldOuterR;
    const leftPt  = { x: o.x + Math.sin(degToRad(-60)) * r, y: o.y - Math.cos(degToRad(-60)) * r };
    const rightPt = { x: o.x + Math.sin(degToRad( 60)) * r, y: o.y - Math.cos(degToRad( 60)) * r };
    return `M ${leftPt.x.toFixed(1)} ${leftPt.y.toFixed(1)} A ${r} ${r} 0 0 1 ${rightPt.x.toFixed(1)} ${rightPt.y.toFixed(1)}`;
  })();
  svg += `<path d="${outerArcPath}" fill="none" stroke="#555" stroke-width="1.5"/>`;

  // Infield/outfield dividing arc
  const midArcPath = (() => {
    const o = origin;
    const r = FAN.outfieldInnerR;
    const leftPt  = { x: o.x + Math.sin(degToRad(-60)) * r, y: o.y - Math.cos(degToRad(-60)) * r };
    const rightPt = { x: o.x + Math.sin(degToRad( 60)) * r, y: o.y - Math.cos(degToRad( 60)) * r };
    return `M ${leftPt.x.toFixed(1)} ${leftPt.y.toFixed(1)} A ${r} ${r} 0 0 1 ${rightPt.x.toFixed(1)} ${rightPt.y.toFixed(1)}`;
  })();
  svg += `<path d="${midArcPath}" fill="none" stroke="#555" stroke-width="1"/>`;

  // Foul lines
  const leftLine  = { x: origin.x + Math.sin(degToRad(-60)) * FAN.outfieldOuterR, y: origin.y - Math.cos(degToRad(-60)) * FAN.outfieldOuterR };
  const rightLine = { x: origin.x + Math.sin(degToRad( 60)) * FAN.outfieldOuterR, y: origin.y - Math.cos(degToRad( 60)) * FAN.outfieldOuterR };
  svg += `<line x1="${origin.x}" y1="${origin.y}" x2="${leftLine.x.toFixed(1)}" y2="${leftLine.y.toFixed(1)}" stroke="#888" stroke-width="1.5" stroke-dasharray="4,3"/>`;
  svg += `<line x1="${origin.x}" y1="${origin.y}" x2="${rightLine.x.toFixed(1)}" y2="${rightLine.y.toFixed(1)}" stroke="#888" stroke-width="1.5" stroke-dasharray="4,3"/>`;

  // Zone percentage labels (GC data)
  for (const zoneId of ZONE_IDS) {
    const zone = FAN.zones[zoneId];
    if (!zone) continue;
    const c    = wedgeCenter(origin, zone.startDeg, zone.endDeg, zone.inner, zone.outer);
    const pct  = zonePercents[zoneId] || 0;
    const hits = zoneHits[zoneId] || 0;
    if (hits === 0) continue;

    svg += `<text x="${c.x.toFixed(1)}" y="${(c.y + 4).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="bold" fill="#111">${pct}%</text>`;
    svg += `<text x="${c.x.toFixed(1)}" y="${(c.y + 14).toFixed(1)}" text-anchor="middle" font-size="8" fill="#333">(${hits})</text>`;
  }

  // Hit event dots
  for (let i = 0; i < hitEvents.length; i++) {
    const ev = hitEvents[i];
    if (!ev.zoneId || ev.zoneId === FOUL_ZONE_CATCHER) continue;
    const pos = zoneDotPosition(ev.zoneId, i * 7 + 13, origin);
    if (!pos) continue;
    const color = dotColor(ev.hitType, ev.isHit);
    const opacity = ev.confidence === "low" ? 0.45 : 0.82;
    svg += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="5" fill="${color}" stroke="white" stroke-width="1" opacity="${opacity}"/>`;
  }

  // Home plate marker
  svg += `<polygon points="${origin.x},${origin.y-6} ${origin.x-5},${origin.y} ${origin.x+5},${origin.y}" fill="#fff" stroke="#333" stroke-width="1"/>`;

  // ---------------------------------------------------------------------------
  // Right side panel — PG cross-reference counts + legend
  // ---------------------------------------------------------------------------
  const panelX = W - 145;
  const panelY = 58;

  svg += `<rect x="${panelX}" y="${panelY}" width="135" height="300" rx="6" fill="#f4f6f8" stroke="#ddd" stroke-width="1"/>`;
  svg += `<text x="${panelX + 68}" y="${panelY + 16}" text-anchor="middle" font-size="10" font-weight="bold" fill="#333">PG Cross-Reference</text>`;
  svg += `<text x="${panelX + 68}" y="${panelY + 28}" text-anchor="middle" font-size="8" fill="#888">(raw counts, all pitches)</text>`;

  const pgRows = [
    { label: "LF-deep", val: pgZoneMap["OF_LF_D"] },
    { label: "LF-gap",  val: pgZoneMap["OF_LF_G"] },
    { label: "CF",      val: pgZoneMap["OF_CF"]   },
    { label: "RF-gap",  val: pgZoneMap["OF_RF_G"] },
    { label: "RF-deep", val: pgZoneMap["OF_RF_D"] },
    { label: "3B",      val: pgZoneMap["IF_3B"]   },
    { label: "SS",      val: pgZoneMap["IF_SS"]   },
    { label: "P/Mid",   val: pgZoneMap["IF_P"]    },
    { label: "2B",      val: pgZoneMap["IF_2B"]   },
    { label: "1B",      val: pgZoneMap["IF_1B"]   },
  ];

  svg += `<line x1="${panelX+8}" y1="${panelY+34}" x2="${panelX+127}" y2="${panelY+34}" stroke="#ccc" stroke-width="1"/>`;

  pgRows.forEach((row, i) => {
    const ty = panelY + 46 + i * 22;
    svg += `<text x="${panelX + 12}" y="${ty}" font-size="10" fill="#444">${escXml(row.label)}</text>`;
    svg += `<text x="${panelX + 123}" y="${ty}" text-anchor="end" font-size="10" font-weight="bold" fill="#222">${escXml(String(row.val))}</text>`;
  });

  // Legend
  const legendY = panelY + 270;
  svg += `<text x="${panelX + 4}" y="${legendY}" font-size="8" font-weight="bold" fill="#555">DOT LEGEND</text>`;
  const legendItems = [
    { color: "#27ae60", label: "Ground ball" },
    { color: "#2980b9", label: "Line drive"  },
    { color: "#f39c12", label: "Fly ball"    },
    { color: "#8e44ad", label: "Popup"       },
    { color: "#e74c3c", label: "Out"         },
  ];
  legendItems.forEach((item, i) => {
    const ly = legendY + 12 + i * 13;
    svg += `<circle cx="${panelX + 10}" cy="${ly - 3}" r="4" fill="${item.color}"/>`;
    svg += `<text x="${panelX + 18}" y="${ly}" font-size="8" fill="#555">${escXml(item.label)}</text>`;
  });

  // Footer note
  const totalEvents = hitEvents.filter(e => e.zoneId && e.zoneId !== FOUL_ZONE_CATCHER).length;
  svg += `<text x="10" y="${H - 10}" font-size="8" fill="#999">Source: GC play-by-play (${totalEvents} batted ball events) · Zone shading = hit frequency · Low-confidence dots at 45% opacity</text>`;

  svg += `</svg>`;
  return svg;
}

function escXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// PG vs GC discrepancy detector
// ---------------------------------------------------------------------------

/**
 * Compare GC play-by-play hit events to PG pitch-by-pitch data for the same game.
 * pgPitchByPitch: array of { inning, half, batter, pitcher, pitchType, velocity,
 *                             result, hitType } — parsed from PG screenshots or DOM
 *
 * For now we compare what we can derive from GC text vs what PG recorded.
 * Returns array of discrepancy objects.
 */
function findDiscrepancies(gcPlays, pgPitchData, gameId, gameDate, homeTeam, awayTeam) {
  const discrepancies = [];

  // Index PG pitch data by inning+half+approximate sequence
  // This is a best-effort match since we don't have an exact play sequence ID
  const pgByInningHalf = {};
  for (const pitch of (pgPitchData || [])) {
    const key = `${pitch.inning}_${pitch.half}`;
    if (!pgByInningHalf[key]) pgByInningHalf[key] = [];
    pgByInningHalf[key].push(pitch);
  }

  // For each GC batted-ball play, look for a matching PG record
  let pgSeqCounters = {};

  for (const play of gcPlays) {
    const parsed = parsePlayText(play.play_text);
    if (parsed.isStrikeout || parsed.isWalk) continue;
    if (!parsed.hitType && !parsed.firstFielderNum) continue;

    const key = `${play.inning}_${play.half}`;
    pgSeqCounters[key] = (pgSeqCounters[key] || 0);
    const pgPlay = pgByInningHalf[key]?.[pgSeqCounters[key]];
    pgSeqCounters[key]++;

    if (!pgPlay) continue;

    // Compare hit type
    if (pgPlay.hitType && parsed.hitType && pgPlay.hitType !== parsed.hitType) {
      discrepancies.push({
        type:      "hit_type_mismatch",
        game_id:   gameId,
        game_date: gameDate,
        our_team: homeTeam,
        opp_team: awayTeam,
        inning:    play.inning,
        half:      play.half,
        batter:    play.batter_name,
        pitcher:   play.pitcher_name,
        gc_value:  parsed.hitType,
        pg_value:  pgPlay.hitType,
        gc_text:   play.play_text,
        pg_text:   pgPlay.rawText || "",
      });
    }

    // Compare result (hit vs out)
    const gcIsHit  = parsed.isHit;
    const pgIsHit  = pgPlay.result && /^(single|double|triple|hr|home.?run|hit)/i.test(pgPlay.result);
    const gcIsOut  = parsed.isOut;
    const pgIsOut  = pgPlay.result && /out|error/i.test(pgPlay.result);

    if (gcIsHit !== undefined && pgIsHit !== undefined && gcIsHit !== pgIsHit) {
      discrepancies.push({
        type:      "result_mismatch",
        game_id:   gameId,
        game_date: gameDate,
        our_team: homeTeam,
        opp_team: awayTeam,
        inning:    play.inning,
        half:      play.half,
        batter:    play.batter_name,
        pitcher:   play.pitcher_name,
        gc_value:  gcIsHit ? "hit" : "out",
        pg_value:  pgIsHit ? "hit" : "out",
        gc_text:   play.play_text,
        pg_text:   pgPlay.rawText || "",
      });
    }
  }

  return discrepancies;
}

/**
 * Format discrepancies as a plain-text email ready to send to stats@perfectgame.com
 */
function formatDiscrepancyEmail(discrepancies, teamName, reportDate) {
  if (!discrepancies.length) {
    return `No discrepancies found between GameChanger and Perfect Game records for ${teamName}.`;
  }

  const lines = [];
  lines.push(`To: stats@perfectgame.com`);
  lines.push(`Subject: Scoring Discrepancy Report — ${teamName} — ${reportDate}`);
  lines.push(``);
  lines.push(`Hello,`);
  lines.push(``);
  lines.push(`I am writing to report discrepancies between the GameChanger play-by-play records`);
  lines.push(`and the Perfect Game DiamondKast records for the following games involving ${teamName}.`);
  lines.push(`Please review and correct the PG records as appropriate.`);
  lines.push(``);
  lines.push(`DISCREPANCY DETAILS`);
  lines.push(`${"=".repeat(70)}`);

  // Group by game
  const byGame = {};
  for (const d of discrepancies) {
    const key = `${d.game_date || "unknown-date"}_${d.game_id}`;
    if (!byGame[key]) byGame[key] = { date: d.game_date, our: d.our_team, opponent: d.opp_team, items: [] };
    byGame[key].items.push(d);
  }

  for (const [, game] of Object.entries(byGame)) {
    lines.push(``);
    lines.push(`Game: ${game.opponent} @ ${game.our}  |  Date: ${game.date || "unknown"}`);
    lines.push(`${"-".repeat(70)}`);

    for (const d of game.items) {
      const inningLabel = `${d.half === "top" ? "Top" : "Bot"} ${d.inning}`;
      lines.push(``);
      lines.push(`  Inning:   ${inningLabel}`);
      lines.push(`  Batter:   ${d.batter || "unknown"}`);
      lines.push(`  Pitcher:  ${d.pitcher || "unknown"}`);

      if (d.type === "hit_type_mismatch") {
        lines.push(`  Issue:    Hit type mismatch`);
        lines.push(`  GC says:  ${formatHitType(d.gc_value)}`);
        lines.push(`  PG says:  ${formatHitType(d.pg_value)}`);
      } else if (d.type === "result_mismatch") {
        lines.push(`  Issue:    Result mismatch`);
        lines.push(`  GC says:  ${d.gc_value}`);
        lines.push(`  PG says:  ${d.pg_value}`);
      } else {
        lines.push(`  Issue:    ${d.type}`);
        lines.push(`  GC value: ${d.gc_value}`);
        lines.push(`  PG value: ${d.pg_value}`);
      }

      if (d.gc_text) lines.push(`  GC text:  "${d.gc_text}"`);
      if (d.pg_text) lines.push(`  PG text:  "${d.pg_text}"`);
    }
  }

  lines.push(``);
  lines.push(`${"=".repeat(70)}`);
  lines.push(`Total discrepancies: ${discrepancies.length}`);
  lines.push(``);
  lines.push(`Thank you for reviewing these records.`);
  lines.push(``);

  return lines.join("\n");
}

function formatHitType(ht) {
  const map = {
    ground_ball: "Ground Ball",
    line_drive:  "Line Drive",
    fly_ball:    "Fly Ball",
    popup:       "Pop Up",
    bunt:        "Bunt",
  };
  return map[ht] || ht || "unknown";
}

// ---------------------------------------------------------------------------
// Main export: build all spray outputs for a team
// ---------------------------------------------------------------------------

/**
 * Build GC-authoritative spray data, heat map PNGs, and discrepancy report.
 *
 * @param {object} db          - SQLite database instance (better-sqlite3 or sqlite3)
 * @param {string} teamName    - Opponent team name
 * @param {object} pgSprayData - Output from scrapeTeamSprayData() (pg-spray-data.json)
 * @param {string} outputDir   - Team output directory
 * @param {Array}  pgPitchData - Optional: parsed PG pitch-by-pitch records for discrepancy check
 */
async function buildTeamSprayData(db, teamName, pgSprayData, outputDir, pgPitchData = []) {
  console.log(`\n[SprayEngine] Building spray data for: ${teamName}`);
  ensureDirectory(outputDir);

  const sprayDir = path.join(outputDir, "spray-charts");
  ensureDirectory(sprayDir);

  // 1. Pull GC plays
  const plays = await getPlaysForOpponent(db, teamName);
  console.log(`[SprayEngine] Found ${plays.length} GC play-by-play records`);

  // 2. Build player zone maps
  const playerMap = buildPlayerZoneMap(plays, pgSprayData?.players || []);
  console.log(`[SprayEngine] Built zone maps for ${Object.keys(playerMap).length} players`);

  // 3. Generate heat map PNGs for each player
  const heatMapFiles = {};

  for (const [nameKey, gcData] of Object.entries(playerMap)) {
    const playerName = gcData.name;
    const bats       = gcData.bats || "R";
    const isSwitchHitter = bats.toUpperCase() === "S";

    // Find matching PG spray data
    const pgPlayer = (pgSprayData?.players || []).find(
      p => normalizePlayerName(p.player || p.name || "") === nameKey
    );

    const svg = generateHeatMapSVG(playerName, gcData, pgPlayer, bats, isSwitchHitter);

    const safeName = cleanFileName(playerName);
    const svgFile  = path.join(sprayDir, `${safeName}-spray-chart.svg`);
    fs.writeFileSync(svgFile, svg, "utf8");

    heatMapFiles[nameKey] = svgFile;
    console.log(`[SprayEngine] Heat map written: ${path.basename(svgFile)}`);
  }

  // 4. Discrepancy report
  const allDiscrepancies = [];
  if (pgPitchData.length) {
    // Group plays by game
    const playsByGame = {};
    for (const play of plays) {
      if (!playsByGame[play.game_id]) playsByGame[play.game_id] = [];
      playsByGame[play.game_id].push(play);
    }
    const pgPitchByGame = {};
    for (const pitch of pgPitchData) {
      if (!pgPitchByGame[pitch.game_id]) pgPitchByGame[pitch.game_id] = [];
      pgPitchByGame[pitch.game_id].push(pitch);
    }

    for (const [gameId, gamePlays] of Object.entries(playsByGame)) {
      const firstPlay = gamePlays[0];
      const d = findDiscrepancies(
        gamePlays,
        pgPitchByGame[gameId] || [],
        gameId,
        firstPlay?.game_date,
        firstPlay?.our_team_name,
        firstPlay?.opponent_name,
      );
      allDiscrepancies.push(...d);
    }
  }

  const reportDate  = new Date().toISOString().slice(0, 10);
  const emailText   = formatDiscrepancyEmail(allDiscrepancies, teamName, reportDate);
  const reportFile  = path.join(outputDir, `pg-gc-discrepancy-report.txt`);
  fs.writeFileSync(reportFile, emailText, "utf8");
  console.log(`[SprayEngine] Discrepancy report: ${allDiscrepancies.length} issues → ${reportFile}`);

  // 5. Write combined structured output
  const output = {
    team:           teamName,
    builtAt:        new Date().toISOString(),
    playerCount:    Object.keys(playerMap).length,
    totalPlays:     plays.length,
    discrepancies:  allDiscrepancies.length,
    players:        Object.values(playerMap).map(p => ({
      name:            p.name,
      bats:            p.bats,
      isSwitchHitter:  p.bats?.toUpperCase() === "S",
      gameCount:       p.gameCount,
      totalBattedBalls: p.totalBattedBalls,
      zoneHits:        p.zoneHits,
      zonePercents:    p.zonePercents,
      heatMapFile:     heatMapFiles[normalizePlayerName(p.name)] || null,
    })),
  };

  const dataFile = path.join(outputDir, "gc-spray-data.json");
  fs.writeFileSync(dataFile, JSON.stringify(output, null, 2), "utf8");
  console.log(`[SprayEngine] Structured data written → ${dataFile}`);

  return {
    gcSprayData:      output,
    heatMapFiles,
    discrepancyCount: allDiscrepancies.length,
    reportFile,
    dataFile,
  };
}

function cleanFileName(v) {
  return String(v || "unknown")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  buildTeamSprayData,
  parsePlayText,
  playToZone,
  buildPlayerZoneMap,
  generateHeatMapSVG,
  formatDiscrepancyEmail,
  findDiscrepancies,
  ZONE_IDS,
  FAN,
  FIELDER_TO_ZONE_RHB,
  LHB_MIRROR,
};
