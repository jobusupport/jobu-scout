'use strict';

/**
 * Authoritative statistical-computation core for High School Slice 2B.
 *
 * Parsing, event classification, and baseball formulas live only here.
 * src/stats-engine.js is the narrow Travel compatibility adapter and invokes
 * legacyIdentity mode; the public baseball engine invokes the safer default.
 *
 * The default contract accumulates by durable player ID whenever available,
 * uses inning/venue context to separate same-named opposing players, routes
 * unresolved identities into explicit game-scoped buckets, and applies that
 * same identity path to batting, pitching, baserunning, and fielding errors.
 * A reconciled engine game identity, when supplied in metadata, controls game
 * counts and unresolved context without mutating source games.
 *
 * This module has no database, network, filesystem, environment, UI, or
 * wall-clock dependency and does not mutate inputs.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const EVENT_STARTERS = [
  'Home Run', "Fielder's Choice", 'Hit By Pitch',
  'Strikeout', 'Ground Out', 'Line Out', 'Fly Out', 'Pop Out', 'Foul Out',
  'Single', 'Double', 'Triple', 'Walk',
  'Sacrifice', 'Sac Fly', 'Sac Bunt', 'Intentional Walk',
  'Error', 'Pickoff',
];

const PITCH_TOKEN_MAP = {
  'in play':         'in_play',
  'foul tip':        'foul_tip',
  'foul':            'foul',
  'looking':         'called_strike',   // "Strike N looking"
  'swinging':        'swinging_strike', // "Strike N swinging"
  'ball':            'ball',
  'pickoff':         'pickoff',
  'balk':            'balk',
  'steals':          'stolen_base',
  'caught stealing': 'caught_stealing',
  'wild pitch':      'wild_pitch',
  'passed ball':     'passed_ball',
};

// Spray zones (inferred from fielder mentioned in play text)
const SPRAY_ZONES = {
  // Outfield
  'left field':   'LF_OF',
  'center field': 'CF_OF',
  'right field':  'RF_OF',
  // Infield (by fielder position)
  'third baseman': '3B_IF',
  'shortstop':     'SS_IF',
  'second baseman':'2B_IF',
  'first baseman': '1B_IF',
  'pitcher':       'P_C',
  'catcher':       'P_C',
};

const BATTED_BALL_TYPES = {
  'ground ball':    'GB',
  'hard ground ball':'GB',
  'line drive':     'LD',
  'fly':            'FB',   // "flies out", "fly out"
  'pop':            'FB',   // "pop out"
  'line out':       'LD',
};

const HIT_EVENTS     = new Set(['Single','Double','Triple','Home Run']);
const OUT_EVENTS     = new Set(['Ground Out','Fly Out','Line Out','Pop Out','Foul Out',"Fielder's Choice"]);
const AB_EVENTS      = new Set([...HIT_EVENTS, ...OUT_EVENTS, 'Strikeout', 'Error']);
const NON_AB_EVENTS  = new Set(['Walk','Hit By Pitch','Sacrifice','Sac Fly','Sac Bunt','Intentional Walk']);

// ─── Text Parsing Helpers ─────────────────────────────────────────────────────

function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function detectEventType(text) {
  const t = cleanText(text);
  // Match longest first to avoid "Single" matching inside "Strikeout" etc.
  const sorted = [...EVENT_STARTERS].sort((a, b) => b.length - a.length);
  for (const evt of sorted) {
    if (t.startsWith(evt)) return evt;
  }
  return null;
}

function stripScoreAndOuts(text) {
  let t = text;
  // Remove score e.g. "CSTL 0 - BRMN 17"
  t = t.replace(/[A-Z]{2,5}\s+\d+\s*[-–]\s*[A-Z]{2,5}\s+\d+(\s*\|\s*\d+\s*Outs?)?/g, '');
  // Remove out count "1 Out", "2 Outs", "3 Outs"
  t = t.replace(/\b\d\s+Outs?\b/g, '');
  return t.trim();
}

/**
 * Parse a GC full plate appearance text into a structured PA object.
 * Returns null if the text is not a full PA description.
 */
function parsePA(rawText) {
  const text = cleanText(rawText);

  const eventType = detectEventType(text);
  if (!eventType) return null;

  // Must have a period+space+Capital to be a full PA (not a label line)
  if (!/\.\s+[A-Z]/.test(text) && !/^Hit By Pitch [A-Z]/.test(text)) {
    // Exception: "Hit By Pitch Ball 1. Player..." — already handled
    // Also exception: very short texts like just event labels
    if (!text.includes(',') && !text.includes('Ball') && !text.includes('Strike')) {
      return null;
    }
  }

  const stripped = stripScoreAndOuts(text);

  // Remove event type prefix
  let remainder = stripped;
  for (const evt of [...EVENT_STARTERS].sort((a, b) => b.length - a.length)) {
    if (remainder.startsWith(evt)) {
      remainder = remainder.slice(evt.length).trim();
      break;
    }
  }

  // Split at first ". [Capital]" to separate pitch sequence from narrative
  const splitMatch = remainder.match(/^(.*?)\.\s+([A-Z].*)$/s);
  const pitchPart     = splitMatch ? splitMatch[1] : remainder;
  const narrativePart = splitMatch ? splitMatch[2] : '';

  // Parse pitch tokens from pitchPart
  const pitches = parsePitchSequence(pitchPart);

  // Extract batter and pitcher from narrative
  const batter  = extractBatter(narrativePart, eventType);
  const pitcher = extractPitcher(narrativePart);

  // Extract batted ball info
  const battedBall = extractBattedBall(narrativePart);
  const sprayZone  = extractSprayZone(narrativePart);

  // Extract every fielder responsible for an error mentioned anywhere in this
  // play's text — not gated to eventType==='Error' (see extractFielders doc),
  // and scanning the full text rather than just narrativePart in case the
  // pitch-sequence/narrative split above didn't find a clean ". [Capital]"
  // boundary for this particular description.
  const fielders = extractFielders(text);

  // Extract baserunning events from the full text
  const sbCount  = (text.match(/\bsteals\b/gi) || []).length;
  const csCount  = (text.match(/\bcaught stealing\b/gi) || []).length;
  const wpCount  = (text.match(/\bwild pitch\b/gi) || []).length;
  const pbCount  = (text.match(/\bpassed ball\b/gi) || []).length;
  const balkCount = (text.match(/\bbalk\b/gi) || []).length;
  const pickoffs = (text.match(/\bpickoff\b/gi) || []).length;

  // Detect RISP (runners in scoring position = 2nd or 3rd mentioned before the PA)
  const runnersOn2nd = /\b(advances to 2nd|remains at 2nd|on 2nd|at 2nd)\b/i.test(text);
  const runnersOn3rd = /\b(advances to 3rd|remains at 3rd|on 3rd|at 3rd)\b/i.test(text);
  const hasRISP = runnersOn2nd || runnersOn3rd;

  // Detect scoring play
  const rbi = (text.match(/\bscores\b/gi) || []).length;

  return {
    eventType,
    batter,
    pitcher,
    pitches,
    battedBall,
    sprayZone,
    fielders,
    sbCount,
    csCount,
    wpCount,
    pbCount,
    balkCount,
    pickoffs,
    hasRISP,
    rbi,
    rawText: text,
  };
}

function normalizePitchToken(token) {
  return cleanText(token)
    // Remove velo/pitch-type annotations like "(66 MPH Fastball)". The old
    // parser expected exactly "Ball 1" / "Strike 1 looking", so GC's velo
    // text caused every pitch to become "unknown" and the swing table stayed empty.
    .replace(/\s*\([^)]*\)/g, '')
    // Remove score/out prefixes that sometimes ride along on the first pitch token.
    .replace(/[A-Z]{2,5}\s+\d+\s*[-–]\s*[A-Z]{2,5}\s+\d+/g, '')
    .replace(/\b\d+\s+Outs?\b/gi, '')
    .replace(/^Courtesy runner\b.*?\bin for\b.*?,/i, '')
    .trim();
}

function parsePitchSequence(pitchPart) {
  const tokens = pitchPart.split(',').map(t => t.trim()).filter(Boolean);
  const pitches = [];
  let balls = 0, strikes = 0;

  for (const token of tokens) {
    const normalized = normalizePitchToken(token);
    const lower = normalized.toLowerCase();
    let pitchType = null;

    if (/^strike \d looking$/i.test(normalized)) {
      pitchType = 'called_strike';
    } else if (/^strike \d swinging$/i.test(normalized)) {
      pitchType = 'swinging_strike';
    } else if (/^strike \d$/i.test(normalized)) {
      pitchType = 'strike'; // unspecified
    } else if (/^ball \d$/i.test(normalized)) {
      pitchType = 'ball';
    } else if (/^foul tip$/i.test(normalized)) {
      pitchType = 'foul_tip';
    } else if (/^foul$/i.test(normalized)) {
      pitchType = 'foul';
    } else if (/^in play$/i.test(normalized)) {
      pitchType = 'in_play';
    } else if (/pickoff/i.test(lower)) {
      pitchType = 'pickoff';
    } else if (/balk/i.test(lower)) {
      pitchType = 'balk';
    } else if (/steals/i.test(lower) || /caught stealing/i.test(lower)) {
      pitchType = 'baserunning';
    } else if (/advances|remains|scores/i.test(lower)) {
      pitchType = 'runner_event';
    } else if (/wild pitch/i.test(lower)) {
      pitchType = 'wild_pitch';
    } else if (/passed ball/i.test(lower)) {
      pitchType = 'passed_ball';
    } else {
      pitchType = 'unknown';
    }

    const countBefore = `${balls}-${strikes}`;

    pitches.push({
      type: pitchType,
      raw: token,
      normalized,
      countBefore,
      balls,
      strikes,
    });

    // Advance count
    if (pitchType === 'ball') {
      balls = Math.min(balls + 1, 3);
    } else if (pitchType === 'called_strike' || pitchType === 'swinging_strike' || pitchType === 'strike') {
      strikes = Math.min(strikes + 1, 2);
    } else if (pitchType === 'foul' || pitchType === 'foul_tip') {
      if (strikes < 2) strikes++;
    }
    // in_play, balk, etc. don't advance count
  }

  return pitches;
}

function extractBatter(narrative, eventType) {
  if (!narrative) return null;

  const verbs = {
    'Single':          'singles',
    'Double':          'doubles',
    'Triple':          'triples',
    'Home Run':        'homers|hits a home run',
    'Strikeout':       'strikes out|is out on foul tip',
    'Walk':            'walks',
    'Hit By Pitch':    'is hit by pitch',
    'Fly Out':         'flies out',
    'Ground Out':      'grounds out|grounds into',
    'Line Out':        'lines out',
    'Pop Out':         'pops out',
    'Foul Out':        'is out on foul',
    "Fielder's Choice":'grounds into',
    'Sacrifice':       'sacrifice|bunts',
    'Error':           'reaches on (?:an )?error|on (?:an )?error',
  };

  const verbPattern = verbs[eventType] || '[a-z]+';
  // NOTE: deliberately no /i flag — GC narrative verbs are consistently
  // lowercase, and an /i flag here makes [A-Z] match lowercase too, which
  // let filler words (e.g. "ground ball and") masquerade as a false-positive
  // "name" immediately before a verb phrase. Case-sensitive is strictly more
  // correct for extracting an actual Title-Case player name.
  //
  // First-name token uses [A-Z][a-zA-Z]*\.? (capital letter, then ZERO or
  // more letters, optional trailing period) rather than [A-Z][a-z]+ (which
  // requires 2+ letters). GC's actual play-by-play format abbreviates first
  // names to a single initial with NO trailing period — "W Woodhead",
  // "P Rollins", "Z Powell" — not "Wyatt Woodhead". The old pattern required
  // at least one lowercase letter after the capital, so it never matched a
  // bare initial and this function returned null on effectively every real
  // play, silently discarding batter attribution (and therefore spray-zone
  // and swing-decision data, both of which depend on a resolved batter).
  const m = narrative.match(
    new RegExp(`([A-Z][a-zA-Z]*\\.?(?:\\s+[A-Z][a-zA-Z'-]+){1,2})\\s+(?:${verbPattern})`)
  );
  if (m) return m[1].trim();

  // Fallback: some phrasings put the batter's name at the very start of the
  // narrative with descriptive text between it and the verb — e.g. "Grayson
  // Bentley hits a ground ball and reaches on an error by pitcher..." — the
  // primary pattern above requires the name immediately before the verb, so
  // it never matches here even though the batter is unambiguous. Only used
  // when the primary match fails, so this can't regress any case that
  // already resolves correctly.
  // Same single-initial fix as above: first token allows a bare capital
  // letter ([A-Z][a-zA-Z'-]*, zero-or-more trailing chars) instead of
  // requiring 2+ characters.
  const leading = narrative.match(/^([A-Z][a-zA-Z'-]*(?:\s+[A-Z][a-zA-Z'-]+){0,2})\s+[a-z]/);
  return leading ? leading[1].trim() : null;
}

function extractPitcher(narrative) {
  // Same single-initial fix as extractBatter above — GC abbreviates pitcher
  // first names to a bare initial too ("N Lopez pitching", "Z Powell
  // pitching"), which [A-Z][a-z]+ never matched.
  const m = narrative.match(/([A-Z][a-zA-Z]*\.?(?:\s+[A-Z][a-zA-Z'-]+){1,2})\s+pitching/i);
  return m ? m[1].trim() : null;
}

function extractBattedBall(narrative) {
  if (!narrative) return null;
  const lower = narrative.toLowerCase();
  for (const [term, type] of Object.entries(BATTED_BALL_TYPES)) {
    if (lower.includes(term)) return type;
  }
  // Infer from event type mentions
  if (/flies out|fly out/i.test(narrative)) return 'FB';
  if (/grounds out|ground out|grounds into/i.test(narrative)) return 'GB';
  if (/lines out|line out/i.test(narrative)) return 'LD';
  if (/pop out|pops out/i.test(narrative)) return 'FB';
  return null;
}

function extractSprayZone(narrative) {
  if (!narrative) return null;
  const lower = narrative.toLowerCase();

  // Check outfield first (more specific)
  if (lower.includes('left field'))   return 'LF';
  if (lower.includes('center field')) return 'CF';
  if (lower.includes('right field'))  return 'RF';

  // Infield
  if (lower.includes('third baseman'))  return '3B';
  if (lower.includes('shortstop'))      return 'SS';
  if (lower.includes('second baseman')) return '2B';
  if (lower.includes('first baseman'))  return '1B';
  if (lower.includes('pitcher'))        return 'P';
  if (lower.includes('catcher'))        return 'C';

  return null;
}

const FIELDER_POSITION_MAP = {
  'left fielder':   'LF',
  'center fielder': 'CF',
  'right fielder':  'RF',
  'third baseman':  '3B',
  'shortstop':      'SS',
  'second baseman': '2B',
  'first baseman':  '1B',
  'pitcher':        'P',
  'catcher':        'C',
};

/**
 * Extract every fielder responsible for an error mentioned in play text.
 * GC play text usually reads "...reaches on an error by shortstop" (position
 * only) or "...error by third baseman Shumake" (position + name). A player's
 * name is present in most (but not all) cases — when absent, this returns
 * { position, name: null } so the caller can decide how to attribute it
 * rather than guessing.
 *
 * Deliberately NOT limited to plays whose primary eventType is 'Error' — a
 * play can be a Ground Out at the primary level while still crediting a
 * runner-advancing error mid-sentence (e.g. "...scores on error by first
 * baseman..."), and some plays contain more than one error mention. This
 * matches globally so both cases are captured.
 *
 * Examples matched:
 *   "reaches on an error by pitcher Graham Rickard."
 *   "reaches on an error by shortstop."
 *   "advances to 2nd on error by right fielder ."  (name sometimes blank)
 *   "...error by second baseman , ...advances to 2nd on error by right fielder ."  (two errors, one play)
 */
function extractFielders(narrative) {
  if (!narrative) return [];
  const re = /error by (left fielder|center fielder|right fielder|third baseman|shortstop|second baseman|first baseman|pitcher|catcher)\s*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})?/gi;
  const results = [];
  let m;
  while ((m = re.exec(narrative)) !== null) {
    results.push({
      position: FIELDER_POSITION_MAP[m[1].toLowerCase()] || null,
      name: m[2] ? m[2].trim() : null,
    });
  }
  return results;
}

function boxRowsForSide(game, type) {
  const box = game.boxScore || {};
  const combined = Array.isArray(box[type]) ? box[type] : [];
  if (combined.length && combined.some(r => r.isOurTeam !== undefined && r.isOurTeam !== null)) {
    return combined;
  }

  const capType = type.charAt(0).toUpperCase() + type.slice(1);
  const away = Array.isArray(box[`away${capType}`]) ? box[`away${capType}`] : [];
  const home = Array.isArray(box[`home${capType}`]) ? box[`home${capType}`] : [];
  const ourSide = String(game.meta?.ourSide || '').toLowerCase();

  if (!away.length && !home.length) return combined;

  return [
    ...away.map(r => ({ ...r, isOurTeam: ourSide === 'away', TeamSide: r.TeamSide || 'away' })),
    ...home.map(r => ({ ...r, isOurTeam: ourSide === 'home', TeamSide: r.TeamSide || 'home' })),
  ];
}


// ─── Per-Player Accumulator ────────────────────────────────────────────────────

// playerId is optional and additive-only: when omitted/null (every existing
// Travel caller, which never supplies one), the returned object's shape is
// IDENTICAL to the legacy accumulator -- .playerId is never added at all.
function emptyPlayerStats(name, playerId = null) {
  const stats = {
    name,
    // Counting stats
    PA: 0, AB: 0, H: 0, R: 0, RBI: 0,
    BB: 0, SO: 0, HBP: 0, SF: 0, SAC: 0,
    singles: 0, doubles: 0, triples: 0, HR: 0,
    SB: 0, CS: 0, PIK: 0,
    E: 0, // fielding errors committed (attributed via extractFielder on Error plays)
    // Batted ball
    GB: 0, FB: 0, LD: 0, battedBalls: 0,
    // Spray zones
    spray: { LF:0, CF:0, RF:0, '3B':0, SS:0, '2B':0, '1B':0, P:0, C:0 },
    // Spray zones split by ball-strike count at the moment of contact —
    // real measured location data, not inferred from swing behavior.
    // See the in-play pitch's countBefore, attributed just below.
    sprayByCount: {
      early:      { LF:0, CF:0, RF:0, '3B':0, SS:0, '2B':0, '1B':0, P:0, C:0 },
      twoStrike:  { LF:0, CF:0, RF:0, '3B':0, SS:0, '2B':0, '1B':0, P:0, C:0 },
    },
    // Count-by-count swing decisions
    // counts[count] = { swing, take_k, total }
    counts: {},
    // Pitch totals
    totalPitches: 0,
    // Situational
    RISP_AB: 0, RISP_H: 0,
    twoOut_AB: 0, twoOut_H: 0, twoOut_RBI: 0,
    // Game log
    games: new Set(),
  };
  if (playerId != null) stats.playerId = playerId;
  return stats;
}

function emptyPitcherStats(name, playerId = null) {
  const stats = {
    name,
    BF: 0,
    outs: 0,       // converted to IP
    H: 0, R: 0, ER: 0,
    BB: 0, SO: 0, HBP: 0,
    WP: 0, BK: 0, PIK: 0,
    E: 0, // fielding errors committed as a defender (e.g. "error by pitcher")
    GB: 0, FB: 0, LD: 0,
    // Pitch totals
    totalPitches: 0, strikes: 0,
    games: new Set(),
  };
  if (playerId != null) stats.playerId = playerId;
  return stats;
}

function addCount(player, countBefore, pitchType) {
  if (!player.counts[countBefore]) {
    player.counts[countBefore] = { swing: 0, take_k: 0, total: 0 };
  }
  const c = player.counts[countBefore];
  c.total++;

  const isSwing = ['swinging_strike', 'foul', 'foul_tip', 'in_play'].includes(pitchType);
  const isTakeK = pitchType === 'called_strike';

  if (isSwing) c.swing++;
  if (isTakeK) c.take_k++;
}


function normalizeNameKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

const INVALID_PLAYER_NAMES = new Set([
  '', 'out', 'outs', 'run', 'runs', 'inning', 'top', 'bottom', 'home', 'away',
  'courtesyrunner', 'ball', 'strike', 'foul', 'play', 'unknown', 'undefined', 'null'
]);

const NON_PLAYER_NAME_WORDS = new Set([
  'single', 'double', 'triple', 'home', 'run', 'strikeout', 'walk', 'hit', 'by',
  'pitch', 'fly', 'out', 'outs', 'ground', 'line', 'pop', 'foul', 'error',
  'sacrifice', 'bunt', 'fielder', 'fielders', 'choice', 'intentional', 'play',
  'runner', 'stolen', 'base', 'wild', 'passed', 'ball', 'balk', 'pickoff',
  'caught', 'stealing', 'strike', 'looking', 'swinging', 'in', 'courtesy',
  'lineup', 'changed'
]);

function isValidPlayerName(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const key = normalizeNameKey(raw);
  if (INVALID_PLAYER_NAMES.has(key)) return false;
  // Require at least one letter and avoid pure event/count words.
  if (!/[A-Za-z]/.test(raw)) return false;

  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // Corrupt legacy rows often look like "Ground Out", "Walk Ball",
  // "Single Strike", or "Lineup Changed" because older normalizer code
  // grabbed the play label/pitch sequence instead of the narrative batter.
  // Treat those as non-names so the narrative parser can recover the player.
  if (words.length && words.every(w => NON_PLAYER_NAME_WORDS.has(w))) return false;

  return true;
}

function rosterCandidates(...sets) {
  const seen = new Set();
  const out = [];
  for (const set of sets) {
    for (const candidate of set || []) {
      if (!candidate) continue;
      const key = normalizeNameKey(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(String(candidate).trim());
    }
  }
  return out;
}

function initialLastKey(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0].replace(/[^A-Za-z0-9]/g, '');
  const last = parts[parts.length - 1].replace(/[^A-Za-z0-9]/g, '');
  if (!first || !last) return null;
  return `${first[0].toLowerCase()}|${normalizeNameKey(last)}`;
}

function rosterCanonicalName(name, ...sets) {
  if (!isValidPlayerName(name)) return null;

  const raw = String(name || '').trim();
  const candidates = rosterCandidates(...sets);

  // If there is no roster context, keep the legacy behavior and return the
  // parsed name. With roster context, never let an unmatched structured value
  // like "Double Ball" become a synthetic player row.
  if (!candidates.length) return raw;

  const key = normalizeNameKey(raw);
  for (const candidate of candidates) {
    if (normalizeNameKey(candidate) === key) return candidate;
  }

  // GameChanger play text frequently abbreviates first names as a single
  // initial ("B Millis") while the box score stores the full name
  // ("Bentley Millis"). Resolve unique first-initial + last-name matches.
  const wantedInitialLast = initialLastKey(raw);
  if (wantedInitialLast) {
    const matches = candidates.filter(candidate => initialLastKey(candidate) === wantedInitialLast);
    if (matches.length === 1) return matches[0];
  }

  return null;
}

// Presence, not truthiness: a falsy-but-meaningful supplied value (numeric
// `0` is the concrete case a durable playerId can legitimately take) must
// survive this lookup. `||` chaining would treat `0` the same as an absent
// field, silently discarding a real ID before it ever reaches durable-ID
// resolution -- so every candidate field is read with an explicit
// null/undefined check instead of truthiness.
function playProvidedName(play, camelName, snakeName, altName) {
  for (const candidateName of [camelName, snakeName, altName]) {
    const value = play?.[candidateName];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

// ─── Durable identity + side-disambiguation helpers (new in this file) ────

// Builds a name -> playerId Map from one side's box rows for one row kind.
// The public engine uses it for durable-first identity. Travel compatibility
// mode deliberately preserves the former display-name accumulator contract.
function idMapFor(rows, wantOwn) {
  const map = new Map();
  for (const row of rows || []) {
    if (!!row.isOurTeam !== wantOwn) continue;
    const name = row.Player;
    if (!name || row.playerId == null) continue;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(String(row.playerId));
  }
  return map;
}

function codePointCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// Player IDs are normalized to strings at this boundary because the public
// result contract exposes object keys. Numeric and string IDs are
// deliberately treated as equivalent after this conversion (`0` and `"0"`
// both become `"0"`) -- there is exactly one canonical form a durable ID can
// take once it reaches an accumulator key or an index lookup. Null/undefined
// mean "not supplied"; see resolveSuppliedIdentity for how a blank
// (empty/whitespace-only) supplied string is handled -- it is NOT treated as
// meaningful identity evidence here, but the two are kept as separate checks
// because "field absent" and "field present but blank" remain distinguishable
// facts about the input up to that point.
function normalizedPlayerId(value) {
  return value === null || value === undefined ? null : String(value);
}

function idIndexFor(rows, role) {
  const index = new Map();
  for (const row of rows || []) {
    const playerId = normalizedPlayerId(row?.playerId);
    if (playerId === null || playerId.trim() === '') continue;
    if (!index.has(playerId)) index.set(playerId, []);
    index.get(playerId).push({
      side: row.isOurTeam ? 'own' : 'opponent',
      name: row.Player || null,
      role,
    });
  }
  return index;
}

function combinedIdIndex(...indexes) {
  const combined = new Map();
  for (const index of indexes) for (const [playerId, entries] of index) {
    if (!combined.has(playerId)) combined.set(playerId, []);
    combined.get(playerId).push(...entries);
  }
  return combined;
}

function unresolvedIdentityKey(context, playerId, name, role) {
  return `unresolved-player:${JSON.stringify([context, playerId, name || null, role])}`;
}

// Returns null for BOTH "field absent" and "field present but blank"
// (empty/whitespace-only) -- neither is meaningful identity evidence, and a
// caller receiving null falls through to its own name/inning-based
// heuristics exactly as if no ID had been supplied at all. This is
// deliberate: a blank ID must never suppress a name that uniquely resolves
// on its own. It is NOT the same as a meaningful-but-unmatched ID (a real
// value not found on either roster), which instead returns an explicit
// `resolved: false` record below so the caller stops guessing and reports
// it as unresolved rather than silently falling back to name matching.
function resolveSuppliedIdentity(providedId, index, expectedSide, context, role, fallbackName) {
  const playerId = normalizedPlayerId(providedId);
  if (playerId === null || playerId.trim() === '') return null;
  const matches = index.get(playerId) || [];
  const sides = new Set(matches.map((entry) => entry.side));
  const names = [...new Set(matches.map((entry) => entry.name).filter(Boolean))].sort(codePointCompare);
  const displayName = names[0] || fallbackName || null;
  const unresolved = (reason, side = expectedSide || null, matchedSide = null) => ({
    key: unresolvedIdentityKey(context, playerId, displayName, role),
    playerId,
    resolved: false,
    reason,
    side,
    matchedSide,
    displayName,
    matches,
  });

  if (!matches.length) return unresolved('supplied durable player ID was not found on either side');
  if (sides.size > 1) return unresolved('supplied durable player ID appears on multiple sides');
  const side = [...sides][0];
  if (expectedSide && expectedSide !== side) {
    return unresolved(`supplied durable player ID conflicts with explicit ${role} side context`, expectedSide, side);
  }
  return { key: playerId, playerId, resolved: true, side, displayName, matches };
}

// Durable ID takes precedence over the display name as the accumulator key.
// Without one, the public mode creates an explicit context-scoped unresolved
// key; only Travel compatibility mode keeps the former plain-name key.
function identityFor(name, providedId, idByName, context, legacyIdentity) {
  // Same input-presence contract as resolveSuppliedIdentity: a blank
  // (empty/whitespace-only) supplied ID is not meaningful evidence and must
  // fall through to the name-based idByName lookup below, not be trusted as
  // a resolved identity keyed by whitespace. `providedId != null` alone is
  // not enough -- `"   " != null` is true, and String(providedId) would
  // otherwise mint a bogus but "resolved" identity out of pure whitespace.
  if (providedId != null && String(providedId).trim() !== '') {
    return { key: String(providedId), playerId: String(providedId), resolved: true };
  }
  const ids = idByName?.get(name);
  if (ids?.size === 1) {
    const playerId = [...ids][0];
    return { key: playerId, playerId, resolved: true };
  }
  if (legacyIdentity) return { key: name, playerId: null, resolved: null };
  return {
    key: unresolvedIdentityKey(context, null, name, 'name'),
    playerId: null,
    resolved: false,
    reason: ids?.size > 1
      ? 'display name maps to multiple durable player IDs and the play supplies no player ID'
      : 'no durable player ID was supplied',
  };
}

// Resolves which side (own/opponent) was on OFFENSE for this specific play,
// using the play's own inning label -- independent of any player name --
// mirroring game-reconstructor.js's proven offenseSideFromInning(). Returns
// null (still unresolved) when the inning label or the game's own venue
// (game.meta.ourSide) isn't available/parseable.
function resolveOffenseSideFromInning(play, ourSideVenue) {
  const normalizedOwnSide = String(ourSideVenue || '').toLowerCase();
  if (normalizedOwnSide !== 'home' && normalizedOwnSide !== 'away') return null;
  const inningText = String(play?.inning || play?.inning_label || '').toLowerCase();
  const battingVenue = inningText.startsWith('top') ? 'away' : inningText.startsWith('bottom') ? 'home' : null;
  if (!battingVenue) return null;
  return battingVenue === normalizedOwnSide ? 'own' : 'opponent';
}

// ─── Core Processing ──────────────────────────────────────────────────────────

/**
 * Process an array of game JSON objects (from our scraper).
 * Separates our team's players from opponents using isOurTeam flag, with
 * durable-ID accumulation and explicit unresolved-identity handling (see
 * this file's own header for what's new versus the relocated legacy file).
 *
 * @param {object[]} games     - Array of game JSON objects
 * @param {string}   teamName  - The team we're scouting (used to confirm isOurTeam)
 * @returns {{ players, opponentBatters, ourPitchers, pitchers, unresolvedBatters, unresolvedPitchers, unattributedErrors }}
 */
function processGames(games, options = {}) {
  const legacyIdentity = options.legacyIdentity === true;
  const players  = new Map();  // our batters
  const pitchers = new Map();  // opponent pitchers (who pitched against us)
  const opponentBatters = new Map(); // opponent batters
  const ourPitchers = new Map();     // our pitchers
  const unresolvedBatters = new Map();
  const unresolvedPitchers = new Map();
  // Errors whose fielder couldn't be matched to a named roster player (no
  // name in the play text, or the name didn't match either roster) — tallied
  // by which side committed them rather than silently dropped or misattributed.
  let unattributedErrorsOurSide = 0;
  let unattributedErrorsOpponentSide = 0;

  for (const game of games) {
    const gameId   = game.meta?.engineGameIdentity?.key || game.meta?.sourceGameId || game.meta?.gameId || 'unknown';
    const ourSide  = game.meta?.ourSide || null;
    const plays    = game.plays || [];
    const batting  = boxRowsForSide(game, 'batting');
    const pitching = boxRowsForSide(game, 'pitching');

    // Build sets of our players vs opponents from box score
    const ourBatterNames = new Set(
      batting.filter(b => b.isOurTeam).map(b => b.Player)
    );
    const ourPitcherNames = new Set(
      pitching.filter(p => p.isOurTeam).map(p => p.Player)
    );
    const oppBatterNames = new Set(
      batting.filter(b => !b.isOurTeam).map(b => b.Player)
    );
    const oppPitcherNames = new Set(
      pitching.filter(p => !p.isOurTeam).map(p => p.Player)
    );

    // Durable-ID lookup maps for this game (see idMapFor's own doc above).
    const ownBatterIdByName = idMapFor(batting, true);
    const oppBatterIdByName = idMapFor(batting, false);
    const ownPitcherIdByName = idMapFor(pitching, true);
    const oppPitcherIdByName = idMapFor(pitching, false);
    const batterIdIndex = idIndexFor(batting, 'batter');
    const pitcherIdIndex = idIndexFor(pitching, 'pitcher');
    const fielderIdIndex = combinedIdIndex(batterIdIndex, pitcherIdIndex);

    // Process each play
    for (const play of plays) {
      const text = cleanText(play.text || '');
      if (!text) continue;

      // Skip label-only lines
      const evt = detectEventType(text);
      if (!evt) continue;

      // Skip pure label lines (no pitch sequence or narrative)
      if (!text.includes(',') && !text.includes('Ball') &&
          !text.includes('Strike') && !text.includes('In play') &&
          !text.includes('Foul')) {
        continue;
      }

      const pa = parsePA(text);
      if (!pa) continue;

      // Prefer structured names stored by the normalizer. The free-text parser
      // can misread scoreboard fragments such as "2 Outs" as a batter named
      // "Outs", which previously created bogus advanced rows and starved the
      // real players of swing-decision data after recalculation.
      const structuredBatter = playProvidedName(play, 'batterName', 'batter_name', 'Batter');
      const structuredPitcher = playProvidedName(play, 'pitcherName', 'pitcher_name', 'Pitcher');
      const parsedBatterFromText = pa.batter;
      const parsedPitcherFromText = pa.pitcher;

      const structuredBatterName = isValidPlayerName(structuredBatter)
        ? rosterCanonicalName(structuredBatter, ourBatterNames, oppBatterNames)
        : null;
      const parsedBatterName = isValidPlayerName(pa.batter)
        ? rosterCanonicalName(pa.batter, ourBatterNames, oppBatterNames)
        : null;
      pa.batter = structuredBatterName || parsedBatterName || null;

      const structuredPitcherName = isValidPlayerName(structuredPitcher)
        ? rosterCanonicalName(structuredPitcher, ourPitcherNames, oppPitcherNames)
        : null;
      const parsedPitcherName = isValidPlayerName(pa.pitcher)
        ? rosterCanonicalName(pa.pitcher, ourPitcherNames, oppPitcherNames)
        : null;
      pa.pitcher = structuredPitcherName || parsedPitcherName || null;

      // ── Attribute each error mention to the fielder who committed it ──
      // Deliberately independent of pa.batter resolving successfully — a
      // batter-extraction miss (e.g. an unexpected phrasing variant) should
      // not also silently drop error data for an unrelated defensive player.
      // Match the fielder's name directly against all four rosters to
      // determine which side committed it, rather than deriving it from
      // isOurBatter (which requires a resolved batter). If no name was
      // captured, or it doesn't match a known roster player, tally it as
      // unattributed for now — position-only fallback would risk crediting
      // the wrong player, since a player's position can change mid-game.
      for (const fielderInfo of pa.fielders) {
        const fielderName = fielderInfo.name;
        const suppliedFielderId = playProvidedName(play, 'fielderId', 'fielder_id', 'FielderId');
        let attributed = false;

        if (legacyIdentity && fielderName) {
          if (ourBatterNames.has(fielderName)) {
            if (!players.has(fielderName)) players.set(fielderName, emptyPlayerStats(fielderName));
            players.get(fielderName).E++;
            attributed = true;
          } else if (ourPitcherNames.has(fielderName)) {
            if (!ourPitchers.has(fielderName)) ourPitchers.set(fielderName, emptyPitcherStats(fielderName));
            ourPitchers.get(fielderName).E++;
            attributed = true;
          } else if (oppBatterNames.has(fielderName)) {
            if (!opponentBatters.has(fielderName)) opponentBatters.set(fielderName, emptyPlayerStats(fielderName));
            opponentBatters.get(fielderName).E++;
            attributed = true;
          } else if (oppPitcherNames.has(fielderName)) {
            if (!pitchers.has(fielderName)) pitchers.set(fielderName, emptyPitcherStats(fielderName));
            pitchers.get(fielderName).E++;
            attributed = true;
          }
        } else if (!legacyIdentity && (fielderName || suppliedFielderId != null)) {
          const inOwn = ourBatterNames.has(fielderName) || ourPitcherNames.has(fielderName);
          const inOpponent = oppBatterNames.has(fielderName) || oppPitcherNames.has(fielderName);
          const offenseSide = resolveOffenseSideFromInning(play, ourSide);
          const defenseSide = offenseSide ? (offenseSide === 'own' ? 'opponent' : 'own') : null;
          const suppliedIdentity = resolveSuppliedIdentity(
            suppliedFielderId,
            fielderIdIndex,
            defenseSide,
            `${gameId}:${defenseSide || 'unresolved'}:fielder`,
            'fielder',
            fielderName,
          );
          let fielderSide = suppliedIdentity?.side || null;
          if (!suppliedIdentity) {
            if (inOwn && inOpponent) fielderSide = defenseSide;
            else if (inOwn) fielderSide = 'own';
            else if (inOpponent) fielderSide = 'opponent';
          }
          const matchedRoles = new Set(suppliedIdentity?.matches?.map((entry) => entry.role) || []);
          const role = matchedRoles.has('batter') || (!matchedRoles.size && (
            (fielderSide === 'own' && ourBatterNames.has(fielderName))
            || (fielderSide === 'opponent' && oppBatterNames.has(fielderName))
          )) ? 'batter' : matchedRoles.has('pitcher') ? 'pitcher' : 'batter';
          const idMap = fielderSide === 'own'
            ? (role === 'batter' ? ownBatterIdByName : ownPitcherIdByName)
            : fielderSide === 'opponent' ? (role === 'batter' ? oppBatterIdByName : oppPitcherIdByName) : null;
          const displayName = suppliedIdentity?.displayName || fielderName || `Unresolved ${fielderInfo.position || 'fielder'}`;
          const identity = suppliedIdentity || identityFor(
            displayName, null, idMap, `${gameId}:${fielderSide || 'unresolved'}:fielder`, false,
          );
          const resolvedMap = role === 'pitcher'
            ? (fielderSide === 'own' ? ourPitchers : pitchers)
            : (fielderSide === 'own' ? players : opponentBatters);
          const statMap = !fielderSide || identity.resolved === false
            ? (role === 'pitcher' ? unresolvedPitchers : unresolvedBatters)
            : resolvedMap;
          if (!statMap.has(identity.key)) {
            const created = role === 'pitcher'
              ? emptyPitcherStats(displayName, identity.playerId)
              : emptyPlayerStats(displayName, identity.playerId);
            if (!fielderSide || identity.resolved === false) {
              created.identity = {
                resolved: false,
                playerIdentityResolved: identity.resolved,
                playerId: identity.playerId,
                displayName,
                reason: identity.reason || 'fielder side could not be resolved',
                context: `${gameId}:${fielderSide || 'unresolved'}:fielder`,
                side: fielderSide,
                matchedSide: identity.matchedSide || null,
                position: fielderInfo.position || null,
              };
            }
            statMap.set(identity.key, created);
          }
          statMap.get(identity.key).E++;
          statMap.get(identity.key).games.add(gameId);
          attributed = true;
        }

        if (!attributed) {
          // Best-effort side guess for the unattributed tally only (not used
          // for player-level credit): if we know the batter and their side,
          // the fielder is the opposite side; otherwise default to opponent
          // since that's who a scouting report cares about most.
          const fielderIsOurSide = pa.batter && ourBatterNames.size > 0
            ? !ourBatterNames.has(pa.batter)
            : false;
          if (fielderIsOurSide) unattributedErrorsOurSide++;
          else unattributedErrorsOpponentSide++;
        }
      }

      const suppliedBatterId = playProvidedName(play, 'batterId', 'batter_id', 'BatterId');
      const expectedBatterSide = resolveOffenseSideFromInning(play, ourSide);
      const suppliedBatterIdentity = legacyIdentity ? null : resolveSuppliedIdentity(
        suppliedBatterId,
        batterIdIndex,
        expectedBatterSide,
        `${gameId}:${expectedBatterSide || 'unresolved'}:batter`,
        'batter',
        pa.batter || structuredBatter || parsedBatterFromText,
      );
      if (suppliedBatterIdentity?.displayName) pa.batter = suppliedBatterIdentity.displayName;
      if (!pa.batter) continue;

      // ── Own/opponent/unresolved side resolution for the BATTER ─────────
      // See this file's own header ("CROSS-SIDE DISAMBIGUATION") for why
      // this differs from the legacy bare-membership check.
      const batterInOwn = ourBatterNames.has(pa.batter);
      const batterInOpp = oppBatterNames.has(pa.batter);
      let batterSide;
      if (suppliedBatterIdentity) {
        batterSide = suppliedBatterIdentity.resolved ? suppliedBatterIdentity.side : 'unresolved';
      } else if (legacyIdentity) {
        batterSide = ourBatterNames.size > 0 ? (batterInOwn ? 'own' : 'opponent') : 'own';
      } else if (batterInOwn && batterInOpp) {
        const resolved = resolveOffenseSideFromInning(play, ourSide);
        batterSide = resolved || 'unresolved';
      } else if (ourBatterNames.size > 0) {
        batterSide = batterInOwn ? 'own' : 'opponent';
      } else {
        batterSide = 'own'; // legacy fallback preserved exactly: track all as own
      }

      const batterIdByName = batterSide === 'own' ? ownBatterIdByName : batterSide === 'opponent' ? oppBatterIdByName : null;
      const batterIdentity = suppliedBatterIdentity || (batterSide === 'unresolved'
        ? { key: unresolvedIdentityKey(`${gameId}:side`, null, pa.batter, 'batter'), resolved: false, playerId: null, reason: 'side could not be resolved' }
        : identityFor(pa.batter, suppliedBatterId, batterIdByName, `${gameId}:${batterSide}:batter`, legacyIdentity));
      const batterKey = batterIdentity.key;
      const batterMap = batterIdentity.resolved === false
        ? unresolvedBatters
        : batterSide === 'own' ? players : batterSide === 'opponent' ? opponentBatters : unresolvedBatters;
      if (!batterMap.has(batterKey)) {
        const created = emptyPlayerStats(pa.batter, batterIdentity.playerId);
        if (batterIdentity.resolved === false) {
          created.identity = {
            resolved: false,
            playerId: batterIdentity.playerId,
            displayName: pa.batter,
            reason: batterIdentity.reason,
            context: `${gameId}:${batterSide}:batter`,
            side: batterIdentity.side || null,
            matchedSide: batterIdentity.matchedSide || null,
          };
        }
        batterMap.set(batterKey, created);
      }
      const batter = batterMap.get(batterKey);
      if (batter.playerId && codePointCompare(pa.batter, batter.name) < 0) batter.name = pa.batter;
      batter.games.add(gameId);

      // PA counting
      batter.PA++;
      const isAB = AB_EVENTS.has(pa.eventType);
      if (isAB) batter.AB++;

      // Hit types
      if (pa.eventType === 'Single')    { batter.H++; batter.singles++; }
      if (pa.eventType === 'Double')    { batter.H++; batter.doubles++; }
      if (pa.eventType === 'Triple')    { batter.H++; batter.triples++; }
      if (pa.eventType === 'Home Run')  { batter.H++; batter.HR++; }
      if (pa.eventType === 'Walk' || pa.eventType === 'Intentional Walk') batter.BB++;
      if (pa.eventType === 'Strikeout') batter.SO++;
      if (pa.eventType === 'Hit By Pitch') batter.HBP++;
      if (pa.eventType === 'Sac Fly')   batter.SF++;
      if (pa.eventType === 'Sacrifice' || pa.eventType === 'Sac Bunt') batter.SAC++;
      batter.RBI += pa.rbi || 0;
      batter.SB  += pa.sbCount || 0;
      batter.CS  += pa.csCount || 0;
      batter.PIK += pa.pickoffs || 0;

      // Batted ball
      if (pa.battedBall) {
        batter.battedBalls++;
        if (pa.battedBall === 'GB') batter.GB++;
        if (pa.battedBall === 'FB') batter.FB++;
        if (pa.battedBall === 'LD') batter.LD++;
      }

      // Spray zone
      if (pa.sprayZone && batter.spray[pa.sprayZone] !== undefined) {
        batter.spray[pa.sprayZone]++;

        // Attribute to early-count vs two-strike bucket using the actual
        // ball-strike count at the moment the ball was put in play — not a
        // proxy. countBefore is "balls-strikes", e.g. "1-2".
        const inPlayPitch = pa.pitches.find(p => p.type === 'in_play');
        if (inPlayPitch && inPlayPitch.countBefore) {
          const strikesAtContact = parseInt(inPlayPitch.countBefore.split('-')[1], 10);
          const bucket = Number.isFinite(strikesAtContact) && strikesAtContact >= 2
            ? batter.sprayByCount.twoStrike
            : batter.sprayByCount.early;
          bucket[pa.sprayZone]++;
        }
      }

      // RISP
      if (pa.hasRISP && isAB) {
        batter.RISP_AB++;
        if (HIT_EVENTS.has(pa.eventType)) batter.RISP_H++;
      }

      // Pitch count decisions
      const actualPitches = pa.pitches.filter(p =>
        ['ball','called_strike','swinging_strike','foul','foul_tip','in_play'].includes(p.type)
      );
      batter.totalPitches += actualPitches.length;

      for (const pitch of actualPitches) {
        addCount(batter, pitch.countBefore, pitch.type);
      }

      // ── Update pitcher stats ──
      const suppliedPitcherId = playProvidedName(play, 'pitcherId', 'pitcher_id', 'PitcherId');
      if (pa.pitcher || (!legacyIdentity && suppliedPitcherId != null)) {
        // ── Own/opponent/unresolved side resolution for the PITCHER ──────
        // The pitcher is on DEFENSE, i.e. the opposite side from the
        // batter's offense side for this same play.
        const pitcherInOwn = ourPitcherNames.has(pa.pitcher);
        const pitcherInOpp = oppPitcherNames.has(pa.pitcher);
        let pitcherSide;
        const offenseSide = resolveOffenseSideFromInning(play, ourSide);
        const expectedPitcherSide = offenseSide ? (offenseSide === 'own' ? 'opponent' : 'own') : null;
        const suppliedPitcherIdentity = legacyIdentity ? null : resolveSuppliedIdentity(
          suppliedPitcherId,
          pitcherIdIndex,
          expectedPitcherSide,
          `${gameId}:${expectedPitcherSide || 'unresolved'}:pitcher`,
          'pitcher',
          pa.pitcher || structuredPitcher || parsedPitcherFromText,
        );
        if (suppliedPitcherIdentity?.displayName) pa.pitcher = suppliedPitcherIdentity.displayName;
        if (suppliedPitcherIdentity) {
          pitcherSide = suppliedPitcherIdentity.resolved ? suppliedPitcherIdentity.side : 'unresolved';
        } else if (legacyIdentity) {
          pitcherSide = ourPitcherNames.size > 0 ? (pitcherInOwn ? 'own' : 'opponent') : 'opponent';
        } else if (pitcherInOwn && pitcherInOpp) {
          const resolvedOffense = resolveOffenseSideFromInning(play, ourSide);
          pitcherSide = resolvedOffense ? (resolvedOffense === 'own' ? 'opponent' : 'own') : 'unresolved';
        } else if (ourPitcherNames.size > 0) {
          pitcherSide = pitcherInOwn ? 'own' : 'opponent';
        } else {
          pitcherSide = 'opponent'; // legacy fallback preserved exactly: default false (opponent)
        }

        const pitcherIdByName = pitcherSide === 'own' ? ownPitcherIdByName : pitcherSide === 'opponent' ? oppPitcherIdByName : null;
        const pitcherIdentity = suppliedPitcherIdentity || (pitcherSide === 'unresolved'
          ? { key: unresolvedIdentityKey(`${gameId}:side`, null, pa.pitcher, 'pitcher'), resolved: false, playerId: null, reason: 'side could not be resolved' }
          : identityFor(pa.pitcher, suppliedPitcherId, pitcherIdByName, `${gameId}:${pitcherSide}:pitcher`, legacyIdentity));
        const pitcherKey = pitcherIdentity.key;
        const pitcherMap = pitcherIdentity.resolved === false
          ? unresolvedPitchers
          : pitcherSide === 'own' ? ourPitchers : pitcherSide === 'opponent' ? pitchers : unresolvedPitchers;
        if (!pitcherMap.has(pitcherKey)) {
          const created = emptyPitcherStats(pa.pitcher, pitcherIdentity.playerId);
          if (pitcherIdentity.resolved === false) {
            created.identity = {
              resolved: false,
              playerId: pitcherIdentity.playerId,
              displayName: pa.pitcher,
              reason: pitcherIdentity.reason,
              context: `${gameId}:${pitcherSide}:pitcher`,
              side: pitcherIdentity.side || null,
              matchedSide: pitcherIdentity.matchedSide || null,
            };
          }
          pitcherMap.set(pitcherKey, created);
        }
        const pitcher = pitcherMap.get(pitcherKey);
        if (pitcher.playerId && codePointCompare(pa.pitcher, pitcher.name) < 0) pitcher.name = pa.pitcher;
        pitcher.games.add(gameId);
        pitcher.BF++;

        // Outs recorded
        if (OUT_EVENTS.has(pa.eventType) || pa.eventType === 'Strikeout') {
          pitcher.outs++;
        }
        if (HIT_EVENTS.has(pa.eventType)) pitcher.H++;
        if (pa.eventType === 'Walk')         pitcher.BB++;
        if (pa.eventType === 'Strikeout')    pitcher.SO++;
        if (pa.eventType === 'Hit By Pitch') pitcher.HBP++;
        pitcher.R   += pa.rbi || 0;  // Approximate runs
        pitcher.WP  += pa.wpCount || 0;
        pitcher.BK  += pa.balkCount || 0;
        pitcher.PIK += pa.pickoffs || 0;

        if (pa.battedBall === 'GB') pitcher.GB++;
        if (pa.battedBall === 'FB') pitcher.FB++;
        if (pa.battedBall === 'LD') pitcher.LD++;

        // Strike percentage
        for (const pitch of actualPitches) {
          pitcher.totalPitches++;
          if (['called_strike','swinging_strike','foul','foul_tip','in_play'].includes(pitch.type)) {
            pitcher.strikes++;
          }
        }
      }
    }
  }

  return {
    players:            finalizeStats(players),
    ourPitchers:        finalizeStats(ourPitchers),
    opponentBatters:    finalizeStats(opponentBatters),
    pitchers:           finalizeStats(pitchers),
    unresolvedBatters:  finalizeStats(unresolvedBatters),
    unresolvedPitchers: finalizeStats(unresolvedPitchers),
    unattributedErrors: {
      ourSide:      unattributedErrorsOurSide,
      opponentSide: unattributedErrorsOpponentSide,
    },
  };
}

// ─── Finalization ─────────────────────────────────────────────────────────────

function finalizeStats(statMap) {
  const result = {};

  const entries = statMap instanceof Map ? [...statMap.entries()] : Object.entries(statMap);
  entries.sort(([left], [right]) => codePointCompare(left, right));
  for (const [name, raw] of entries) {
    const s = { ...raw };
    s.games = s.games.size;

    // Batting rates
    s.BA    = s.AB > 0 ? +(s.H / s.AB).toFixed(3) : null;
    s.OBP   = s.PA > 0 ? +((s.H + s.BB + s.HBP) / (s.PA)).toFixed(3) : null;
    const TB = s.singles + 2*s.doubles + 3*s.triples + 4*s.HR;
    s.TB    = TB;
    s.SLG   = s.AB > 0 ? +(TB / s.AB).toFixed(3) : null;
    s.OPS   = (s.OBP && s.SLG) ? +(s.OBP + s.SLG).toFixed(3) : null;
    s.XBH   = s.doubles + s.triples + s.HR;
    s.K_pct = s.PA > 0 ? +(s.SO / s.PA * 100).toFixed(1) : null;
    s.BB_pct = s.PA > 0 ? +(s.BB / s.PA * 100).toFixed(1) : null;

    // Batted ball %
    const bb = s.battedBalls;
    s.GB_pct = bb > 0 ? +(s.GB / bb * 100).toFixed(1) : null;
    s.FB_pct = bb > 0 ? +(s.FB / bb * 100).toFixed(1) : null;
    s.LD_pct = bb > 0 ? +(s.LD / bb * 100).toFixed(1) : null;

    // RISP
    s.BA_RISP = s.RISP_AB > 0 ? +(s.RISP_H / s.RISP_AB).toFixed(3) : null;

    // Spray zone percentages
    const totalZone = s.spray ? Object.values(s.spray).reduce((a, b) => a + b, 0) : 0;
    s.sprayPct = {};
    if (!s.spray) s.spray = {};
    for (const [zone, count] of Object.entries(s.spray)) {
      s.sprayPct[zone] = totalZone > 0 ? +(count / totalZone * 100).toFixed(1) : 0;
    }

    // Spray zone percentages split by count — real measured location data
    // (see sprayByCount attribution above), not inferred from swing%.
    function sprayBucketPct(bucket = {}) {
      const total = Object.values(bucket).reduce((a, b) => a + b, 0);
      const pct = {};
      for (const [zone, count] of Object.entries(bucket)) {
        pct[zone] = total > 0 ? +(count / total * 100).toFixed(1) : 0;
      }
      return { pct, n: total };
    }
    const earlyBucket = sprayBucketPct(s.sprayByCount?.early);
    const twoKBucket   = sprayBucketPct(s.sprayByCount?.twoStrike);
    s.sprayPctEarly = earlyBucket.pct;
    s.sprayEarlyN   = earlyBucket.n;
    s.sprayPct2K    = twoKBucket.pct;
    s.spray2KN      = twoKBucket.n;

    // Swing decisions table (matching Bob Jones format)
    s.swingDecisions = {};
    const ALL_COUNTS = ['0-0','0-1','0-2','1-0','1-1','1-2','2-0','2-1','2-2','3-0','3-1','3-2'];
    const rawCounts = s.counts || {};
    for (const count of ALL_COUNTS) {
      const c = rawCounts[count] || { swing: 0, take_k: 0, total: 0 };
      s.swingDecisions[count] = {
        swing_pct: c.total > 0 ? Math.round(c.swing / c.total * 100) : 0,
        take_k_pct: c.total > 0 ? Math.round(c.take_k / c.total * 100) : 0,
        n: c.total,
      };
    }

    // Pitcher-specific
    if (s.outs !== undefined) {
      const fullInnings  = Math.floor(s.outs / 3);
      const partialOuts  = s.outs % 3;
      s.IP       = `${fullInnings}.${partialOuts}`;
      s.IP_dec   = +(fullInnings + partialOuts/3).toFixed(4);
      s.ERA      = s.IP_dec > 0 ? +(s.R  / s.IP_dec * 9).toFixed(2) : null;
      s.WHIP     = s.IP_dec > 0 ? +((s.BB + s.H) / s.IP_dec).toFixed(3) : null;
      s.SO_per7  = s.IP_dec > 0 ? +(s.SO / s.IP_dec * 7).toFixed(2) : null;
      s.BB_per7  = s.IP_dec > 0 ? +(s.BB / s.IP_dec * 7).toFixed(2) : null;
      s.S_pct    = s.totalPitches > 0 ? +(s.strikes / s.totalPitches * 100).toFixed(1) : null;
      s.P_per_IP = s.IP_dec > 0 ? +(s.totalPitches / s.IP_dec).toFixed(1) : null;
      s.K_pct_BF = s.BF > 0 ? +(s.SO / s.BF * 100).toFixed(1) : null;
      s.BB_pct_BF = s.BF > 0 ? +(s.BB / s.BF * 100).toFixed(1) : null;
      s.GO_AO    = s.FB > 0 ? +(s.GB / s.FB).toFixed(2) : null;

      const pbb = s.battedBalls || (s.GB + s.FB + s.LD);
      s.GB_pct = pbb > 0 ? +(s.GB / pbb * 100).toFixed(1) : null;
      s.FB_pct = pbb > 0 ? +(s.FB / pbb * 100).toFixed(1) : null;
      s.LD_pct = pbb > 0 ? +(s.LD / pbb * 100).toFixed(1) : null;
    }

    // Clean up internal accumulators
    delete s.counts;
    delete s.spray;
    delete s.sprayByCount;
    delete s.battedBalls;

    Object.defineProperty(result, name, {
      value: s,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result;
}

// ─── Convenience: process a single game JSON file ────────────────────────────

function processGameFile(gameJson) {
  return processGames([gameJson]);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  processGames,
  processGameFile,
  parsePA,
  parsePitchSequence,
  detectEventType,
  // Exposed for testing
  _internals: { extractBatter, extractPitcher, extractBattedBall, extractSprayZone, extractFielders, normalizePitchToken }
};
