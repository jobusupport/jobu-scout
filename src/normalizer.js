'use strict';

/**
 * normalizer.js
 * Voodoo Scout — Phase 2: JSON → Structured Data
 *
 * Converts raw game JSON extracted by the Playwright scraper into
 * clean, typed objects ready for SQLite insertion.
 *
 * Usage:
 *   const { normalizeGameData } = require('./normalizer');
 *   const normalized = normalizeGameData(rawJson, team);
 *   // → { game, battingLines, pitchingLines, playEvents }
 *
 * Options:
 *   invertTeamSide: true  → flip isOurTeam for all batting/pitching rows.
 *                           Use this when ingesting an OPPONENT team's GC page
 *                           so that their players land in is_our_team=0 (the
 *                           side the report queries look at for scouting data).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const EVENT_TYPE_MAP = {
  // Hits
  'single':            'single',
  'doubles':           'double',
  'double':            'double',
  'triple':            'triple',
  'home run':          'home_run',
  'homer':             'home_run',
  'hr':                'home_run',
  // Outs — batted ball
  'fly out':           'fly_out',
  'flyout':            'fly_out',
  'ground out':        'ground_out',
  'groundout':         'ground_out',
  'line out':          'line_out',
  'lineout':           'line_out',
  'pop out':           'pop_out',
  'popout':            'pop_out',
  'foul out':          'foul_out',
  // Strikeouts
  'strikeout':         'strikeout',
  'struck out':        'strikeout',
  'strikeout swinging':'strikeout',
  'strikeout looking': 'strikeout_looking',
  // Walks / HBP
  'walk':              'walk',
  'intentional walk':  'ibb',
  'hit by pitch':      'hbp',
  // Baserunning
  'stolen base':       'stolen_base',
  'caught stealing':   'caught_stealing',
  'wild pitch':        'wild_pitch',
  'passed ball':       'passed_ball',
  'balk':              'balk',
  'pickoff':           'pickoff',
  // Fielding
  'error':             'error',
  "fielder's choice":  'fielders_choice',
  'fielders choice':   'fielders_choice',
  // Sacrifice
  'sacrifice fly':     'sac_fly',
  'sacrifice bunt':    'sac_bunt',
  'sacrifice':         'sac_bunt',
  // Inning markers
  'end of inning':     'end_inning',
  'inning over':       'end_inning',
};

const SCORING_EVENTS = new Set([
  'single', 'double', 'triple', 'home_run',
  'walk', 'ibb', 'hbp', 'wild_pitch', 'passed_ball',
  'error', 'fielders_choice', 'sac_fly', 'sac_bunt'
]);

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toInt(value, fallback = null) {
  const str = String(value || '').trim();
  // Reject strings that look like decimals/averages (contain a dot)
  if (str.includes('.')) return fallback;
  const n = parseInt(str.replace(/[^0-9-]/g, ''), 10);
  return isNaN(n) ? fallback : n;
}

function toFloat(value, fallback = null) {
  const n = parseFloat(String(value || '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? fallback : n;
}

function toAvg(value) {
  // Accepts ".333", "0.333", "333" — normalizes to ".333" format
  const cleaned = clean(value);
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  if (n > 1) return null; // Bad data
  return n.toFixed(3).replace(/^0/, ''); // ".333"
}

/**
 * Convert innings pitched string to decimal.
 * "3.2" (3 innings + 2 outs) → 3.667
 * "6.0" → 6.0
 */
function ipToDecimal(ip) {
  const str = clean(ip);
  if (!str) return null;
  const [whole, frac] = str.split('.');
  const innings = parseInt(whole, 10) || 0;
  const outs = parseInt(frac || '0', 10);
  return parseFloat((innings + outs / 3).toFixed(4));
}

/**
 * Parse a raw date/time string from GC into ISO date + time parts.
 * Input: "Sat April 12, 2:00 PM - 4:30 PM CT"
 * Output: { date: "2026-04-12", time: "14:00", raw: "..." }
 */
function parseDateTimeRaw(raw) {
  if (!raw) return { date: null, time: null, raw: null };

  const MONTHS = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12'
  };

  const monthMatch = raw.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i
  );

  const yearMatch = raw.match(/\b(20\d{2})\b/);
  const timeMatch = raw.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)/i);

  let date = null;
  if (monthMatch) {
    const month = MONTHS[monthMatch[1].toLowerCase()];
    const day = String(monthMatch[2]).padStart(2, '0');
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear();
    date = `${year}-${month}-${day}`;
  }

  let time = null;
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2];
    const ampm = timeMatch[3].toUpperCase();
    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    time = `${String(hours).padStart(2, '0')}:${minutes}`;
  }

  return { date, time, raw };
}

/**
 * Parse inning string like "Top 3" or "Bottom 7" into parts.
 */
function parseInning(inningStr) {
  if (!inningStr) return { inning: null, inningNum: null, inningHalf: null };
  const match = String(inningStr).match(/\b(Top|Bottom|Mid|End)\s+(\d+)\b/i);
  if (!match) return { inning: inningStr, inningNum: null, inningHalf: null };
  return {
    inning: `${match[1]} ${match[2]}`,
    inningNum: parseInt(match[2], 10),
    inningHalf: match[1].toLowerCase() === 'top' ? 'top' : 'bottom'
  };
}

/**
 * Classify a play description into a normalized event type.
 */
function normalizeEventType(description) {
  if (!description) return 'unknown';
  const lower = description.toLowerCase();

  // Check longest matches first to avoid "single" matching "single" in "strikeout"
  const sorted = Object.entries(EVENT_TYPE_MAP)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [phrase, type] of sorted) {
    if (lower.includes(phrase)) return type;
  }

  return 'unknown';
}

/**
 * Try to extract player name from a play description.
 * GC play text is typically: "Player Name verb phrase"
 */
function extractPlayerFromPlay(description) {
  if (!description) return null;
  // Take first 2–3 words if they look like a name (capitalized, no digits)
  const words = description.trim().split(/\s+/);
  const nameParts = [];
  for (const word of words.slice(0, 3)) {
    if (/^[A-Z][a-z]+$/.test(word) || /^[A-Z]+$/.test(word)) {
      nameParts.push(word);
    } else {
      break;
    }
  }
  return nameParts.length >= 2 ? nameParts.join(' ') : null;
}

// ─── Core Normalizers ─────────────────────────────────────────────────────────

/**
 * Normalize a single batting row from GC box score table.
 * Handles varying column names across GC versions.
 */
function normalizeBattingRow(raw, gameId, teamId, battingOrder) {
  // GC column names vary — try multiple key patterns
  function get(...keys) {
    for (const key of keys) {
      const val = raw[key] ?? raw[key.toUpperCase()] ?? raw[key.toLowerCase()];
      if (val !== undefined && val !== null && val !== '') return String(val);
    }
    return null;
  }

  const playerName = clean(
    get('Player', 'Name', 'Batter', 'player', 'name', 'batter') || ''
  );

  if (!playerName || playerName.toLowerCase() === 'totals') return null;

  return {
    gameId,
    teamId,
    playerName,
    battingOrder: battingOrder ?? null,
    isOurTeam:  raw.isOurTeam === true ? 1 : (raw.isOurTeam === false ? 0 : null),
    teamSide:   raw.TeamSide   || raw.teamSide   || null,
    teamNameRaw: raw.TeamName  || raw.teamName   || null,
    position: clean(get('Pos', 'Position', 'pos') || ''),
    ab:       toInt(get('AB', 'ab', 'At Bats', 'AtBats')),
    r:        toInt(get('R', 'r', 'Runs', 'runs')),
    h:        toInt(get('H', 'h', 'Hits', 'hits')),
    rbi:      toInt(get('RBI', 'rbi')),
    bb:       toInt(get('BB', 'bb', 'Walk', 'Walks', 'walks')),
    so:       toInt(get('SO', 'so', 'K', 'k', 'Strikeout', 'Strikeouts')),
    avg:      toAvg(get('AVG', 'avg', 'BA', 'ba')),
    obp:      toAvg(get('OBP', 'obp')),
    slg:      toAvg(get('SLG', 'slg')),
    doubles:  toInt(get('2B', 'Doubles', 'doubles')),
    triples:  toInt(get('3B', 'Triples', 'triples')),
    hr:       toInt(get('HR', 'hr', 'Home Runs')),
    sb:       toInt(get('SB', 'sb', 'Stolen Bases')),
    hbp:      toInt(get('HBP', 'hbp', 'Hit By Pitch')),
    sac:      toInt(get('SAC', 'sac', 'Sacrifice')),
    lob:      toInt(get('LOB', 'lob', 'Left On Base')),
    rawJson:  JSON.stringify(raw),
  };
}

/**
 * Normalize a single pitching row from GC box score table.
 */
function normalizePitchingRow(raw, gameId, teamId) {
  function get(...keys) {
    for (const key of keys) {
      const val = raw[key] ?? raw[key.toUpperCase()] ?? raw[key.toLowerCase()];
      if (val !== undefined && val !== null && val !== '') return String(val);
    }
    return null;
  }

  const playerName = clean(
    get('Player', 'Name', 'Pitcher', 'player', 'name', 'pitcher') || ''
  );

  if (!playerName || playerName.toLowerCase() === 'totals') return null;

  const ip = clean(get('IP', 'ip', 'Innings', 'Innings Pitched') || '');

  return {
    gameId,
    teamId,
    playerName,
    isOurTeam:  raw.isOurTeam === true ? 1 : (raw.isOurTeam === false ? 0 : null),
    teamSide:   raw.TeamSide   || raw.teamSide   || null,
    teamNameRaw: raw.TeamName  || raw.teamName   || null,
    ip:          ip || null,
    ipDecimal:   ipToDecimal(ip),
    bf:          toInt(get('BF', 'bf', 'Batters Faced')),
    pc:          toInt(get('PC', 'pc', 'Pitches', 'Pitch Count', 'NP')),
    strikes:     toInt(get('STR', 'str', 'Strikes', 'strikes', 'S')),
    hAllowed:    toInt(get('H', 'h', 'Hits', 'Hits Allowed')),
    rAllowed:    toInt(get('R', 'r', 'Runs', 'Runs Allowed')),
    er:          toInt(get('ER', 'er', 'Earned Runs')),
    bb:          toInt(get('BB', 'bb', 'Walks')),
    so:          toInt(get('SO', 'so', 'K', 'Strikeouts')),
    hrAllowed:   toInt(get('HR', 'hr', 'Home Runs')),
    era:         clean(get('ERA', 'era') || ''),
    whip:        clean(get('WHIP', 'whip') || ''),
    rawJson:     JSON.stringify(raw),
  };
}

/**
 * Normalize a single play-by-play event.
 */
function normalizePlayEvent(raw, gameId, teamId, sequenceNum) {
  const description = clean(raw.text || raw.description || raw.play || '');
  if (!description) return null;

  const eventType = normalizeEventType(description);
  const inningParsed = parseInning(raw.inning || '');

  // Detect RBI from description
  const rbiMatch = description.match(/\b(\d+)\s*RBI\b/i);
  const resultRbi = rbiMatch ? parseInt(rbiMatch[1], 10) : null;

  // Is this a scoring play?
  const isScoringPlay = SCORING_EVENTS.has(eventType) &&
    /\bscores?\b/i.test(description) ? 1 : 0;

  return {
    gameId,
    teamId,
    sequenceNum,
    inning:       inningParsed.inning,
    inningNum:    inningParsed.inningNum,
    inningHalf:   inningParsed.inningHalf,
    eventType,
    batterName:   extractPlayerFromPlay(description),
    pitcherName:  null,               // GC play text rarely names the pitcher
    description,
    runnersOn:    null,               // Requires deeper DOM parsing (Phase 1.5)
    outsBefore:   null,
    resultRbi,
    isScoringPlay,
  };
}

/**
 * Normalize the game-level meta from extractGameHeader() output.
 */
function normalizeGameMeta(meta, teamId) {
  const dateTime = parseDateTimeRaw(meta.gameDateTime || meta.dateTime || '');

  // Extract opponent name from teamCandidates
  // GC header typically has both team names; the opponent is the one that
  // doesn't match the team we're scouting
  const opponent = (meta.teamCandidates || [])
    .filter(name => name && name.length < 100)
    .find(name => !name.toLowerCase().includes('varsity') && name !== '') || null;

  // ── Extract score from meta or teamCandidates ──────────────────────────────
  let scoreUs   = toInt(meta.scoreUs);
  let scoreThem = toInt(meta.scoreThem);
  let result    = meta.result || null;

  // Try to extract scores from teamCandidates (e.g. "0 - 11", "11", "0")
  if ((scoreUs == null || scoreThem == null) && meta.teamCandidates) {
    const candidates = meta.teamCandidates || [];

    // Look for "X - Y" pattern first
    const dashScore = candidates.find(c => /^\d+\s*-\s*\d+$/.test(String(c || '').trim()));
    if (dashScore) {
      const parts = dashScore.split('-').map(s => parseInt(s.trim(), 10));
      // In GC format, the score is shown as "awayScore - homeScore"
      const ourSide = (meta.ourSide || '').toLowerCase();
      if (ourSide === 'home') {
        scoreThem = parts[0]; scoreUs = parts[1];
      } else {
        scoreUs = parts[0]; scoreThem = parts[1];
      }
    } else {
      // Look for two standalone integers
      const nums = candidates
        .map(c => String(c || '').trim())
        .filter(c => /^\d+$/.test(c))
        .map(Number);
      if (nums.length >= 2) {
        const ourSide = (meta.ourSide || '').toLowerCase();
        if (ourSide === 'home') {
          scoreThem = nums[0]; scoreUs = nums[1];
        } else {
          scoreUs = nums[0]; scoreThem = nums[1];
        }
      }
    }
  }

  // Try to extract result from headline in teamCandidates
  if (!result && scoreUs != null && scoreThem != null) {
    if (scoreUs > scoreThem) result = 'W';
    else if (scoreThem > scoreUs) result = 'L';
    else result = 'T';
  }

  // Also check headline text for win/loss indicators
  if (!result) {
    const headline = (meta.teamCandidates || []).find(c =>
      /leads|past|beats|defeats|wins|falls|loses|loss/i.test(String(c || ''))
    ) || '';
    const ourName = (meta.homeTeam || meta.awayTeam || '').toLowerCase();
    if (headline) {
      const hl = headline.toLowerCase();
      // "leads X past Y" or "X defeats Y" — if our team is the subject, W
      if (hl.includes('leads') || hl.includes('beats') || hl.includes('defeats')) {
        const isOurLead = hl.includes(ourName.split(' ')[0]?.toLowerCase() || '__');
        result = isOurLead ? 'W' : 'L';
      }
    }
  }

  // Determine opponent name from teamCandidates
  const ourTeamName = (meta.homeTeam || meta.awayTeam || '').toLowerCase();
  const opponentName = (meta.opponentName ||
    (meta.teamCandidates || [])
      .filter(name => name && name.length > 3 && name.length < 100)
      .filter(name => !/^[A-Z]{2,5}$/.test(name))  // skip abbreviations
      .filter(name => !name.toLowerCase().includes(ourTeamName.split(' ')[0]?.toLowerCase() || '__'))
      .find(name => !name.toLowerCase().includes('varsity')) || null
  );

  return {
    teamId,
    gcGameId:        meta.gameId || null,
    gcGameUrl:       meta.gameUrl || meta.pageUrl || null,
    gameDate:        dateTime.date,
    gameTime:        dateTime.time,
    gameDatetimeRaw: dateTime.raw || meta.dateTime || null,
    result,
    scoreUs,
    scoreThem,
    opponentName,
    location:        null,
    seasonType:      null,
    jsonFile:        meta.jsonFile || null,
    screenshotFile:  meta.screenshotFile || null,
    capturedAt:      meta.capturedAt || new Date().toISOString(),
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * normalizeGameData(rawJson, teamId, options)
 *
 * Takes the raw JSON output from extractGameData() and returns
 * structured objects ready for DB insertion.
 *
 * @param {object} rawJson     - Output from Playwright extraction
 * @param {number} teamId      - DB team ID (must already exist in teams table)
 * @param {object} [options]
 * @param {boolean} [options.invertTeamSide=false]
 *   When true, all isOurTeam values are flipped before DB storage.
 *   Use this when ingesting an OPPONENT team's own GC page so that
 *   their players land in is_our_team=0 (what report queries expect
 *   for the scouted team). For Birmingham Stars' own games leave false.
 * @returns {{ game, battingLines, pitchingLines, playEvents }}
 */
function normalizeGameData(rawJson, teamId, options = {}) {
  if (!rawJson || typeof rawJson !== 'object') {
    throw new Error('normalizeGameData: rawJson must be an object');
  }

  const invertTeamSide = options.invertTeamSide === true;

  const { meta = {}, boxScore = {}, plays = [] } = rawJson;

  // 1. Game record
  const game = normalizeGameMeta(meta, teamId);

  // Placeholder game_id — will be replaced with DB-assigned ID after insert
  const gameId = '__pending__';

  // ── Build extra-stat lookup maps from battingExtra sections ──────────────
  // GC stores 2B/3B/HR/SB/HBP as { "2B": ["Player A,", "Player B 2,"], ... }
  function parseExtraSection(extraObj) {
    const map = {};  // playerName → { doubles, triples, hr, sb, hbp }
    if (!extraObj || typeof extraObj !== 'object') return map;

    function parseEntries(arr, field) {
      if (!Array.isArray(arr)) return;
      for (const entry of arr) {
        // Format: "Player Name 2," or "Player Name," (count defaults to 1)
        const raw = String(entry).replace(/,$/, '').trim();
        const countMatch = raw.match(/(\d+)$/);
        const count = countMatch ? parseInt(countMatch[1], 10) : 1;
        const name  = raw.replace(/(\s+\d+)?$/, '').trim();
        if (!name) continue;
        if (!map[name]) map[name] = { doubles: 0, triples: 0, hr: 0, sb: 0, hbp: 0 };
        map[name][field] = (map[name][field] || 0) + count;
      }
    }

    parseEntries(extraObj['2B']  || extraObj['Doubles']  || [], 'doubles');
    parseEntries(extraObj['3B']  || extraObj['Triples']  || [], 'triples');
    parseEntries(extraObj['HR']  || extraObj['HomeRuns'] || [], 'hr');
    parseEntries(extraObj['SB']  || extraObj['StolenBases'] || [], 'sb');
    parseEntries(extraObj['HBP'] || extraObj['HitByPitch']  || [], 'hbp');
    return map;
  }

  const awayExtra = parseExtraSection(boxScore.awayBattingExtra);
  const homeExtra = parseExtraSection(boxScore.homeBattingExtra);

  // ── Build combined batting rows (away + home) ──────────────────────────────
  function enrichBattingRow(row, extraMap) {
    // Try to find this player in extraMap (names may have trailing punctuation)
    const playerName = String(row.Player || row.Name || row.Batter || row.player || row.name || '').trim();
    const extra = extraMap[playerName] || {};

    // Merge extra stats into the row object so normalizeBattingRow can find them
    return {
      ...row,
      '2B':   extra.doubles ?? row['2B'] ?? null,
      '3B':   extra.triples ?? row['3B'] ?? null,
      'HR':   extra.hr      ?? row['HR'] ?? null,
      'SB':   extra.sb      ?? row['SB'] ?? null,
      'HBP':  extra.hbp     ?? row['HBP'] ?? null,
    };
  }

  // Helper: flip isOurTeam if invertTeamSide is active
  function maybeInvert(isOurTeamBool) {
    return invertTeamSide ? !isOurTeamBool : isOurTeamBool;
  }

  // Determine which side is "our team" from meta
  const ourSide = (meta.ourSide || '').toLowerCase(); // "home" or "away"

  const awayBattingRaw = boxScore.awayBatting || [];
  const homeBattingRaw = boxScore.homeBatting || [];

  const allBattingRows = (() => {
    if (awayBattingRaw.length > 0 || homeBattingRaw.length > 0) {
      // Stamp isOurTeam based on ourSide when using split arrays
      return [
        ...awayBattingRaw.map(r => ({
          ...enrichBattingRow(r, awayExtra),
          isOurTeam: maybeInvert(ourSide === 'away'),
          TeamSide: 'away',
        })),
        ...homeBattingRaw.map(r => ({
          ...enrichBattingRow(r, homeExtra),
          isOurTeam: maybeInvert(ourSide === 'home'),
          TeamSide: 'home',
        })),
      ];
    }
    // Legacy fallback: combined batting array already has isOurTeam set
    return (boxScore.batting || []).map(r => {
      const side = (r.TeamSide || r.teamSide || '').toLowerCase();
      const enriched = enrichBattingRow(r, side === 'home' ? homeExtra : awayExtra);
      // r.isOurTeam is already a boolean from the scraper; invert if needed
      const originalIsOurTeam = enriched.isOurTeam === true || enriched.isOurTeam === 1;
      return {
        ...enriched,
        isOurTeam: maybeInvert(originalIsOurTeam),
      };
    });
  })();

  const battingLines = allBattingRows
    .map((row, i) => normalizeBattingRow(row, gameId, teamId, i + 1))
    .filter(Boolean)
    .map(bl => {
      // Calculate OBP and SLG from components if not already present
      if (bl.obp == null && bl.ab != null && bl.h != null) {
        const ab  = bl.ab  ?? 0;
        const h   = bl.h   ?? 0;
        const bb  = bl.bb  ?? 0;
        const hbp = bl.hbp ?? 0;
        const sac = bl.sac ?? 0;
        const denom = ab + bb + hbp + sac;
        bl.obp = denom > 0 ? parseFloat(((h + bb + hbp) / denom).toFixed(3)) : null;
      }
      if (bl.slg == null && bl.ab != null && bl.ab > 0) {
        const singles = (bl.h ?? 0) - (bl.doubles ?? 0) - (bl.triples ?? 0) - (bl.hr ?? 0);
        const tb = singles + (bl.doubles ?? 0) * 2 + (bl.triples ?? 0) * 3 + (bl.hr ?? 0) * 4;
        bl.slg = parseFloat((tb / bl.ab).toFixed(3));
      }
      return bl;
    });

  // 3. Pitching lines
  // Build combined pitching array from split home/away if available
  const awayPitchingRaw = boxScore.awayPitching || [];
  const homePitchingRaw = boxScore.homePitching || [];

  let allPitchingRowsRaw;
  if (awayPitchingRaw.length > 0 || homePitchingRaw.length > 0) {
    allPitchingRowsRaw = [
      ...awayPitchingRaw.map(r => ({
        ...r,
        isOurTeam: maybeInvert(ourSide === 'away'),
        TeamSide: 'away',
      })),
      ...homePitchingRaw.map(r => ({
        ...r,
        isOurTeam: maybeInvert(ourSide === 'home'),
        TeamSide: 'home',
      })),
    ];
  } else {
    // Legacy: combined pitching array
    allPitchingRowsRaw = [
      ...(boxScore.pitching || []).map(r => {
        const originalIsOurTeam = r.isOurTeam === true || r.isOurTeam === 1;
        return { ...r, isOurTeam: maybeInvert(originalIsOurTeam) };
      }),
      ...Object.values(boxScore.raw || {})
        .filter(t => t && t.data)
        .flatMap(t => t.data)
        .filter(row => {
          const keys = Object.keys(row).map(k => k.toUpperCase());
          return keys.includes('IP') || keys.includes('BF') || keys.includes('PC');
        })
        .map(r => {
          const originalIsOurTeam = r.isOurTeam === true || r.isOurTeam === 1;
          return { ...r, isOurTeam: maybeInvert(originalIsOurTeam) };
        }),
    ];
  }

  const pitchingLines = allPitchingRowsRaw
    .map(row => normalizePitchingRow(row, gameId, teamId))
    .filter(Boolean);

  // Deduplicate pitchers (same player may appear in multiple table passes)
  const seenPitchers = new Set();
  const dedupedPitching = pitchingLines.filter(p => {
    if (seenPitchers.has(p.playerName)) return false;
    seenPitchers.add(p.playerName);
    return true;
  });

  // 4. Play events
  const rawPlays = Array.isArray(plays) ? plays : (plays.events || []);
  const playEvents = rawPlays
    .map((play, i) => normalizePlayEvent(play, gameId, teamId, i + 1))
    .filter(Boolean);

  if (invertTeamSide) {
    console.log('[normalizer] invertTeamSide=true — scouted team players stored as is_our_team=0');
  }

  return {
    game,
    battingLines,
    pitchingLines: dedupedPitching,
    playEvents,
    // Summary for logging
    _summary: {
      batters: battingLines.length,
      pitchers: dedupedPitching.length,
      plays: playEvents.length,
      hasBattingData: battingLines.length > 0,
      hasPitchingData: dedupedPitching.length > 0,
      hasPlayData: playEvents.length > 0,
      invertTeamSide,
    }
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  normalizeGameData,
  normalizeBattingRow,
  normalizePitchingRow,
  normalizePlayEvent,
  normalizeGameMeta,
  normalizeEventType,
  ipToDecimal,
  parseDateTimeRaw,
  // Expose for testing
  _internals: { clean, toInt, toFloat, toAvg, parseInning, extractPlayerFromPlay }
};