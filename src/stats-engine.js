'use strict';

/**
 * stats-engine.js
 * Voodoo Scout — Advanced Stats Calculator
 *
 * Calculates ALL stats visible in the Bob Jones sample report
 * directly from play-by-play text. No additional scraping needed.
 *
 * Produces per-player:
 *   - GB%, FB%, LD% (batted ball rates)
 *   - K%, BB% (already in box score, but calculated here for accuracy)
 *   - Swing Decisions table (Swing%, TakeK%, n) for all 12 counts
 *   - Pitch count per PA, pitch totals
 *   - SBA, CS, pickoffs
 *   - Spray direction (7-zone percentages)
 *   - Situational splits (RISP, 2-out, leadoff)
 *
 * Produces per-pitcher:
 *   - S% (strike percentage)
 *   - SO/7, BB/7
 *   - Pitch count, BF
 *   - GB/FB allowed
 *   - WP, HBP, BK
 *
 * Usage:
 *   const { processGames } = require('./stats-engine');
 *   const stats = processGames(gameJsonArray);
 *   // → { players: {name: playerStats}, pitchers: {name: pitcherStats}, team: teamStats }
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

  // Bunt detection, deliberately independent of eventType — GC only labels
  // a play "Sac Bunt" for a textbook sacrifice. A bunt for a hit, a bunt
  // that becomes a fielder's choice/ground out/pop out, or a failed bunt
  // attempt still contains the word "bunt" in the narrative even though its
  // primary event is Single/Ground Out/Fielder's Choice/Pop Out. Scanning
  // the whole text (not just narrativePart) catches all of these.
  const isBunt = /\bbunt/i.test(text);

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
    isBunt,
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

function emptyPlayerStats(name) {
  return {
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
    // Count-by-count swing decisions
    // counts[count] = { swing, take_k, total }
    counts: {},
    // Pitch totals
    totalPitches: 0,
    // Situational
    RISP_AB: 0, RISP_H: 0,
    twoOut_AB: 0, twoOut_H: 0, twoOut_RBI: 0,
	// Find this line:
	BB: 0, SO: 0, HBP: 0, SF: 0, SAC: 0,
	// Change to:
	BB: 0, SO: 0, HBP: 0, SF: 0, SAC: 0, BUNT: 0,
    // Game log
    games: new Set(),
  };
}

function emptyPitcherStats(name) {
  return {
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

function playProvidedName(play, camelName, snakeName, altName) {
  return play?.[camelName] || play?.[snakeName] || play?.[altName] || null;
}

// ─── Core Processing ──────────────────────────────────────────────────────────

/**
 * Process an array of game JSON objects (from our scraper).
 * Separates our team's players from opponents using isOurTeam flag.
 *
 * @param {object[]} games     - Array of game JSON objects
 * @param {string}   teamName  - The team we're scouting (used to confirm isOurTeam)
 * @returns {{ players, pitchers, team, opponent }}
 */
function processGames(games) {
  const players  = {};  // our batters
  const pitchers = {};  // opponent pitchers (who pitched against us)
  const opponentBatters = {}; // opponent batters
  const ourPitchers = {};     // our pitchers
  // Errors whose fielder couldn't be matched to a named roster player (no
  // name in the play text, or the name didn't match either roster) — tallied
  // by which side committed them rather than silently dropped or misattributed.
  let unattributedErrorsOurSide = 0;
  let unattributedErrorsOpponentSide = 0;

  for (const game of games) {
    const gameId   = game.meta?.gameId || 'unknown';
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
        let attributed = false;

        if (fielderName) {
          if (ourBatterNames.has(fielderName)) {
            if (!players[fielderName]) players[fielderName] = emptyPlayerStats(fielderName);
            players[fielderName].E++;
            attributed = true;
          } else if (ourPitcherNames.has(fielderName)) {
            if (!ourPitchers[fielderName]) ourPitchers[fielderName] = emptyPitcherStats(fielderName);
            ourPitchers[fielderName].E++;
            attributed = true;
          } else if (oppBatterNames.has(fielderName)) {
            if (!opponentBatters[fielderName]) opponentBatters[fielderName] = emptyPlayerStats(fielderName);
            opponentBatters[fielderName].E++;
            attributed = true;
          } else if (oppPitcherNames.has(fielderName)) {
            if (!pitchers[fielderName]) pitchers[fielderName] = emptyPitcherStats(fielderName);
            pitchers[fielderName].E++;
            attributed = true;
          }
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

      if (!pa.batter) continue;

      const isOurBatter = ourBatterNames.size > 0
        ? ourBatterNames.has(pa.batter)
        : true; // fallback: track all

      const isOurPitcher = ourPitcherNames.size > 0
        ? ourPitcherNames.has(pa.pitcher)
        : false;

      // ── Update batter stats ──
      const batterMap = isOurBatter ? players : opponentBatters;
      if (!batterMap[pa.batter]) {
        batterMap[pa.batter] = emptyPlayerStats(pa.batter);
      }
      const batter = batterMap[pa.batter];
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
      if (pa.pitcher) {
        const pitcherMap = isOurPitcher ? ourPitchers : pitchers;
        if (!pitcherMap[pa.pitcher]) {
          pitcherMap[pa.pitcher] = emptyPitcherStats(pa.pitcher);
        }
        const pitcher = pitcherMap[pa.pitcher];
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
    players:         finalizeStats(players),
    ourPitchers:     finalizeStats(ourPitchers),
    opponentBatters: finalizeStats(opponentBatters),
    pitchers:        finalizeStats(pitchers),
    unattributedErrors: {
      ourSide:      unattributedErrorsOurSide,
      opponentSide: unattributedErrorsOpponentSide,
    },
  };
}

// ─── Finalization ─────────────────────────────────────────────────────────────

function finalizeStats(statMap) {
  const result = {};

  for (const [name, raw] of Object.entries(statMap)) {
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
    delete s.battedBalls;

    result[name] = s;
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
