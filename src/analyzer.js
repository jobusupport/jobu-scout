'use strict';

const { getPGDataForTeam } = require('./pg-reader');

/**
 * analyzer.js
 * Voodoo Scout — AI Analysis Layer (Phase 4)
 */

const db       = require('./db');
const pipeline = require('./pipeline');

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS   = 20000;
const API_URL      = 'https://api.anthropic.com/v1/messages';
const API_KEY      = process.env.ANTHROPIC_API_KEY || '';

// ─── PitchSmart Rules (USA Baseball) ──────────────────────────────────────────
// Source: USA Baseball PitchSmart guidelines
// Age groups: 7-8, 9-10, 11-12, 13-14, 15-16, 17-18
// Rest requirements based on pitches thrown in a single outing

const PITCHSMART_RULES = {
  // USA Baseball Pitch Smart rest thresholds. Keys are minimum pitch counts.
  // Example: 13-14U, 36 pitches means 2 full calendar days of rest.
  '7-8':   { max: 50,  rest: { 1: 0, 21: 1, 36: 2, 51: 3 } },
  '9-10':  { max: 75,  rest: { 1: 0, 21: 1, 36: 2, 51: 3, 66: 4 } },
  '11-12': { max: 85,  rest: { 1: 0, 21: 1, 36: 2, 51: 3, 66: 4 } },
  '13-14': { max: 95,  rest: { 1: 0, 21: 1, 36: 2, 51: 3, 66: 4 } },
  '15-16': { max: 95,  rest: { 1: 0, 31: 1, 46: 2, 61: 3, 76: 4 } },
  '17-18': { max: 105, rest: { 1: 0, 31: 1, 46: 2, 61: 3, 76: 4 } },
};

function getPitchSmartGroup(ageGroup) {
  const age = parseInt(ageGroup) || 14;
  if (age <= 8)  return '7-8';
  if (age <= 10) return '9-10';
  if (age <= 12) return '11-12';
  if (age <= 14) return '13-14';
  if (age <= 16) return '15-16';
  return '17-18';
}

function getRequiredRestDays(pitches, ageGroup) {
  const group = getPitchSmartGroup(ageGroup);
  const rules = PITCHSMART_RULES[group];
  if (!rules) return 0;
  // Find the highest threshold the pitcher exceeded
  let restDays = 0;
  for (const [threshold, days] of Object.entries(rules.rest).sort((a,b) => Number(b[0])-Number(a[0]))) {
    if (pitches >= Number(threshold)) {
      restDays = days;
      break;
    }
  }
  return restDays;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildPitchSmartAnalysis(games, ageGroup, gameDate) {
  if (!games || !games.length) return null;

  const now        = gameDate ? new Date(gameDate) : new Date();
  const cutoff96h  = new Date(now.getTime() - (96 * 60 * 60 * 1000));

  // Find games played in last 96 hours
  const recentGames = games.filter(g => {
    if (!g.game_date) return false;
    const gd = new Date(g.game_date);
    return gd >= cutoff96h && gd <= now;
  });

  if (!recentGames.length) return { hasRecentGames: false };

  // For each recent game, look at pitching lines to find pitch counts
  // pitch_count comes from pitching_lines table via bundle.pitching
  // We need to flag pitchers who appeared in recent games
  const recentDates = recentGames.map(g => g.game_date);

  return {
    hasRecentGames: true,
    recentGameDates: recentDates,
    // The actual per-game pitch counts are passed in via pitchingLines
    // and processed in buildAnalysisPrompt
  };
}

function dateAtNoon(dateStr) {
  if (!dateStr) return new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) {
    return new Date(`${dateStr}T12:00:00`);
  }
  return new Date(dateStr);
}

function addCalendarDays(dateStr, days) {
  const d = dateAtNoon(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function numericOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).trim().replace(/,/g, '').replace(/%$/, '');
  if (!cleaned || cleaned === '-' || cleaned.toUpperCase() === 'N/A') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function getPitchCountFromLine(line = {}) {
  const raw = parseMaybeJson(line.raw_json || line.rawJson) || {};
  const candidates = [
    line.pitch_count,
    line.pitchCount,
    line.pc,
    line.PC,
    line.pitches,
    line.pitch_count_total,
    line.total_pitches,
    raw.PC,
    raw.pc,
    raw['#P'],
    raw['Pitches'],
    raw['Pitch Count'],
    raw.NP,
  ];

  for (const candidate of candidates) {
    const n = numericOrNull(candidate);
    if (n !== null && n > 0) return Math.round(n);
  }

  // Last-resort estimate. GameChanger sometimes fails to expose PC but does
  // expose BF/IP. This prevents impossible report rows like "0 pitches (5.1 IP)".
  const bf = numericOrNull(line.bf || line.BF || raw.BF || raw['Batters Faced']);
  if (bf !== null && bf > 0) return Math.max(1, Math.round(bf * 3.8));

  const ipDec = numericOrNull(line.ip_decimal || line.ipDecimal);
  if (ipDec !== null && ipDec > 0) return Math.max(1, Math.round(ipDec * 15));

  return 0;
}

function isOurTeamValue(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function getScoutedPitchingLines(allPitchLines = []) {
  const valid = allPitchLines.filter(l => l && l.player_name);
  const falseSide = valid.filter(l => !isOurTeamValue(l.is_our_team));
  if (falseSide.length) return falseSide;

  // Fallback for legacy data where side flags were not set consistently.
  const countByFlag = { true: new Set(), false: new Set() };
  for (const line of valid) {
    countByFlag[String(isOurTeamValue(line.is_our_team))].add(line.player_name);
  }
  const scoutedIsOurTeam = countByFlag.true.size >= countByFlag.false.size;
  return valid.filter(l => isOurTeamValue(l.is_our_team) === scoutedIsOurTeam);
}

function computePitchSmartEligibility(bundle, options = {}) {
  const team = bundle.team || {};
  const ageGroup = team.age_group || '14';
  const psGroup = getPitchSmartGroup(ageGroup);
  const psRules = PITCHSMART_RULES[psGroup];
  const referenceDate = options.gameDate || new Date().toISOString().slice(0, 10);
  const referenceTs = dateAtNoon(referenceDate);

  const scoutedLines = getScoutedPitchingLines(bundle.recentPitchingLines || []);

  // Use the most recent game dates in the data, not a fixed calendar window.
  // Reports can be generated weeks after a tournament, so a 96-hour window would
  // hide the actual last outings.
  const allGameDates = [...new Set(
    scoutedLines.map(l => l.game_date).filter(Boolean)
  )].sort((a, b) => dateAtNoon(b) - dateAtNoon(a));

  const lookbackDates = new Set(allGameDates.slice(0, 2));

  // PitchSmart is based on a pitcher's DAILY pitch total, not a cumulative
  // two-date total. Group pitcher outings by date first, then evaluate each date.
  const pitcherByDate = {};
  for (const line of scoutedLines) {
    if (!line.game_date || !lookbackDates.has(line.game_date)) continue;

    const name = line.player_name;
    const date = line.game_date;
    const pitches = getPitchCountFromLine(line);

    if (!pitcherByDate[name]) pitcherByDate[name] = {};
    if (!pitcherByDate[name][date]) {
      pitcherByDate[name][date] = { date, pitches: 0, outings: [] };
    }

    pitcherByDate[name][date].pitches += pitches;
    pitcherByDate[name][date].outings.push({
      date,
      pitches,
      opponent: line.opponent_name || 'Unknown',
      ip: line.ip || null,
      bf: line.bf ?? null,
      pc: line.pc ?? line.pitch_count ?? null,
    });
  }

  const pitchers = Object.entries(pitcherByDate).map(([name, byDate]) => {
    const dailyGames = Object.values(byDate)
      .sort((a, b) => dateAtNoon(b.date) - dateAtNoon(a.date))
      .map(day => {
        const restNeeded = getRequiredRestDays(day.pitches, ageGroup);
        const eligibleDate = restNeeded === 0
          ? day.date
          : addCalendarDays(day.date, restNeeded + 1);
        return {
          date: day.date,
          pitches: day.pitches,
          restNeeded,
          eligibleDate,
          outings: day.outings,
          opponent: day.outings.map(o => o.opponent).filter(Boolean).join(' / ') || 'Unknown',
          ip: day.outings.map(o => o.ip).filter(Boolean).join(' + ') || null,
        };
      });

    const mostRecentGame = dailyGames[0];
    const limitingGame = dailyGames
      .slice()
      .sort((a, b) => dateAtNoon(b.eligibleDate) - dateAtNoon(a.eligibleDate))[0] || mostRecentGame;

    const daysSince = Math.floor(
      (referenceTs - dateAtNoon(mostRecentGame.date)) / (1000 * 60 * 60 * 24)
    );
    const isEligible = dateAtNoon(limitingGame.eligibleDate) <= referenceTs;

    return {
      name,
      // Keep this as the most recent daily pitch total so the report does not
      // imply PitchSmart rest was calculated from a two-day cumulative number.
      pitches: mostRecentGame.pitches,
      dailyPitches: mostRecentGame.pitches,
      totalLookbackPitches: dailyGames.reduce((s, d) => s + d.pitches, 0),
      restNeeded: limitingGame.restNeeded,
      daysSince,
      isEligible,
      eligibleDate: limitingGame.eligibleDate,
      mostRecentGameDate: mostRecentGame.date,
      mostRecentOpponent: mostRecentGame.opponent,
      limitingGameDate: limitingGame.date,
      games: dailyGames.flatMap(day => day.outings),
      dailyGames,
    };
  }).sort((a, b) => {
    if (a.isEligible !== b.isEligible) return a.isEligible ? 1 : -1;
    return dateAtNoon(b.mostRecentGameDate) - dateAtNoon(a.mostRecentGameDate)
      || b.pitches - a.pitches;
  });

  const recentGames = [...lookbackDates].map(d => ({ game_date: d }));

  // ── Data-quality guard: detect a collapsed game_date pattern ──────────────
  // If the "last 2 dates" lookback only ever finds ONE distinct date, but that
  // date carries outings against many different opponents, the scraper almost
  // certainly failed to resolve distinct per-game dates (a known failure mode
  // in the GameChanger schedule-page date extraction) and stamped every game
  // with the same value. When that happens, PitchSmart's cumulative same-day
  // pitch counts and "not eligible until +N days" projections are not
  // trustworthy — they are built on a false premise (many games on one day).
  // We do not attempt to guess correct dates here; we just refuse to present
  // the result with unwarranted confidence.
  const distinctOpponentsOnSingleDate = lookbackDates.size === 1
    ? new Set(
        scoutedLines
          .filter(l => l.game_date && lookbackDates.has(l.game_date))
          .map(l => l.opponent_name)
          .filter(Boolean)
      ).size
    : 0;
  const dateDataSuspect = lookbackDates.size === 1 && distinctOpponentsOnSingleDate > 2;
  const dateDataWarning = dateDataSuspect
    ? `PitchSmart data quality warning: every scouted outing in the lookback window shares the single ` +
      `date ${[...lookbackDates][0]}, but spans ${distinctOpponentsOnSingleDate} different opponents. ` +
      `A team cannot realistically play that many different opponents in one calendar day, so the ` +
      `underlying game dates for this team are very likely wrong (a scraper date-resolution issue), and ` +
      `the pitch counts/eligibility below should be treated as unreliable until this team is re-scraped ` +
      `with corrected date extraction.`
    : null;

  return {
    ageGroup,
    psGroup,
    psRules,
    referenceDate: referenceTs.toISOString().slice(0, 10),
    lookbackDates: [...lookbackDates].sort(),
    recentGames,
    pitchers,
    dateDataSuspect,
    dateDataWarning,
  };
}

// ─── Claude API ────────────────────────────────────────────────────────────────

function extractJsonCandidate(text) {
  let clean = String(text || '').trim();

  // Claude sometimes wraps otherwise-valid JSON in ```json fences. Strip them
  // even when there is leading/trailing whitespace or a language label.
  const fullFence = clean.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (fullFence) clean = fullFence[1].trim();
  clean = clean
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // If Claude adds a sentence before the JSON, discard everything before the
  // first JSON opener. This is deliberately conservative: only objects/arrays.
  const firstObj = clean.indexOf('{');
  const firstArr = clean.indexOf('[');
  let start = -1;
  if (firstObj >= 0 && firstArr >= 0) start = Math.min(firstObj, firstArr);
  else start = Math.max(firstObj, firstArr);
  if (start > 0) clean = clean.slice(start).trim();

  // Prefer the first balanced JSON object/array. This avoids choking if Claude
  // appends explanation after the closing brace.
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let end = -1;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  return end > 0 ? clean.slice(0, end).trim() : clean;
}

function parseClaudeJson(text) {
  const candidate = extractJsonCandidate(text);

  try {
    return JSON.parse(candidate);
  } catch (e1) {
    // Last-resort salvage for responses that are complete except for trailing
    // markdown or extra text. Do NOT pretend truly truncated JSON is valid.
    const withoutTrailingFence = candidate.replace(/```[\s\S]*$/g, '').trim();
    try {
      return JSON.parse(withoutTrailingFence);
    } catch (e2) {
      const preview = String(text || '').slice(0, 900);
      throw new Error(
        `Claude returned non-JSON or truncated JSON: ${e2.message}\n` +
        `Preview:\n${preview}`
      );
    }
  }
}

async function callClaude(systemPrompt, userPrompt) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');

  return parseClaudeJson(text);
}

// ─── Prompt Builders ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Voodoo Scout, an elite baseball intelligence analyst specializing in high school and travel ball scouting. You produce detailed, actionable scouting reports matching the quality of professional scout documents.

You respond ONLY with valid JSON matching the exact schema requested. No preamble, no markdown, no explanation outside the JSON. All text fields should be concise and written for a coach who has 30 seconds to read each section. Numbers should be numbers, not strings. Use null for unknown values.`;

function fmtAvg(v) {
  if (v == null) return 'N/A';
  const n = parseFloat(v);
  if (isNaN(n)) return 'N/A';
  return n.toFixed(3).replace(/^0/, '');
}

function fmtNum(v, d = 2) {
  if (v == null) return 'N/A';
  const n = parseFloat(v);
  return isNaN(n) ? 'N/A' : n.toFixed(d);
}

function safeJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function officialTeamTotalsFromBox(batting = [], pitching = [], gamesAnalyzed = 0) {
  const officialBatting = batting.reduce((t, b) => {
    t.pa += (b.total_ab || 0) + (b.total_bb || 0) + (b.total_hbp || 0) + (b.total_sac || 0);
    t.ab += b.total_ab || 0;
    t.h += b.total_h || 0;
    t.bb += b.total_bb || 0;
    t.so += b.total_so || 0;
    t.hbp += b.total_hbp || 0;
    t.doubles += b.total_2b || 0;
    t.triples += b.total_3b || 0;
    t.hr += b.total_hr || 0;
    t.rbi += b.total_rbi || 0;
    t.sb += b.total_sb || 0;
    t.sac += b.total_sac || 0;
    return t;
  }, { games: gamesAnalyzed, pa: 0, ab: 0, h: 0, bb: 0, so: 0, hbp: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, sb: 0, sac: 0 });

  const officialPitching = pitching.reduce((t, p) => {
    t.ip += Number(p.total_ip || 0);
    t.bf += p.total_bf || 0;
    t.pc += p.total_pc || p.total_pitches || 0;
    t.h += p.total_h || 0;
    t.r += p.total_r || 0;
    t.er += p.total_er || 0;
    t.bb += p.total_bb || 0;
    t.so += p.total_so || 0;
    t.hr += p.total_hr || 0;
    return t;
  }, { games: gamesAnalyzed, ip: 0, bf: 0, pc: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0 });

  return { officialBatting, officialPitching };
}

function buildVerifiedFactsBlock(bundle, batting, pitching) {
  const verified = bundle.verifiedTotals || null;
  const gamesAnalyzed = bundle.meta?.gamesAnalyzed || 0;
  const fallback = officialTeamTotalsFromBox(batting, pitching, gamesAnalyzed);
  const officialBatting = safeJson(verified?.batting_official, fallback.officialBatting) || fallback.officialBatting;
  const officialPitching = safeJson(verified?.pitching_official, fallback.officialPitching) || fallback.officialPitching;
  const tendencies = safeJson(verified?.tendencies, {}) || {};
  const warnings = safeJson(verified?.warnings, []) || [];

  const totalBases = ((officialBatting.h || 0) - (officialBatting.doubles || 0) - (officialBatting.triples || 0) - (officialBatting.hr || 0))
    + 2 * (officialBatting.doubles || 0) + 3 * (officialBatting.triples || 0) + 4 * (officialBatting.hr || 0);
  const obpDen = (officialBatting.ab || 0) + (officialBatting.bb || 0) + (officialBatting.hbp || 0) + (officialBatting.sac || 0);
  const avg = officialBatting.ab > 0 ? officialBatting.h / officialBatting.ab : null;
  const obp = obpDen > 0 ? ((officialBatting.h || 0) + (officialBatting.bb || 0) + (officialBatting.hbp || 0)) / obpDen : null;
  const slg = officialBatting.ab > 0 ? totalBases / officialBatting.ab : null;
  const ops = obp !== null && slg !== null ? obp + slg : null;

  const validationLine = verified
    ? `Validation: ${verified.validated_games || 0}/${verified.play_by_play_games || 0} play-by-play games matched box score within tolerance; confidence=${verified.confidence || 'low'}; mismatches=${verified.mismatch_games || 0}.`
    : 'Validation: no stored play-by-play validation run found yet; official totals below are box-score aggregates.';

  const sideTendencyLines = [];
  const scoutedBatting = tendencies.scoutedBatting || {};
  const scoutedPitchingDefense = tendencies.scoutedPitchingDefense || {};
  if (Object.keys(scoutedBatting).length) {
    sideTendencyLines.push(`Scouted batting side-specific PBP: groundOuts=${scoutedBatting.groundOutsValidatedPbp ?? 'N/A'}, flyOuts=${scoutedBatting.flyOutsValidatedPbp ?? 'N/A'}, lineOuts=${scoutedBatting.lineOutsValidatedPbp ?? 'N/A'} (${scoutedBatting.note || 'side-attributed play-by-play only'}).`);
  }
  if (Object.keys(scoutedPitchingDefense).length) {
    sideTendencyLines.push(`Scouted pitching/defense side-specific PBP: WP=${scoutedPitchingDefense.wildPitchesFromSideAttributedPbp ?? 'N/A'}, PB=${scoutedPitchingDefense.passedBallsFromSideAttributedPbp ?? 'N/A'}, pickoffs=${scoutedPitchingDefense.pickoffsFromSideAttributedPbp ?? 'N/A'} (${scoutedPitchingDefense.note || 'side-attributed play-by-play only'}).`);
  }

  return `=== VERIFIED TEAM FACTS — USE THESE NUMBERS FOR ALL NUMERIC CLAIMS ===
${validationLine}
Games analyzed: ${gamesAnalyzed}
Official batting totals from box score: PA ${officialBatting.pa || 0}, AB ${officialBatting.ab || 0}, H ${officialBatting.h || 0}, BB ${officialBatting.bb || 0}, SO ${officialBatting.so || 0}, HBP ${officialBatting.hbp || 0}, 2B ${officialBatting.doubles || 0}, 3B ${officialBatting.triples || 0}, HR ${officialBatting.hr || 0}, RBI ${officialBatting.rbi || 0}, SB ${officialBatting.sb || 0}.
Official slash line from box score: AVG ${avg === null ? 'N/A' : fmtAvg(avg)}, OBP ${obp === null ? 'N/A' : fmtAvg(obp)}, SLG ${slg === null ? 'N/A' : fmtAvg(slg)}, OPS ${ops === null ? 'N/A' : fmtAvg(ops)}.
Official pitching totals from box score: IP ${fmtNum(officialPitching.ip, 1)}, BF ${officialPitching.bf || 0}, PC ${officialPitching.pc || 0}, H ${officialPitching.h || 0}, R ${officialPitching.r || 0}, ER ${officialPitching.er || 0}, BB ${officialPitching.bb || 0}, SO ${officialPitching.so || 0}, HR ${officialPitching.hr || 0}.
${sideTendencyLines.length ? sideTendencyLines.join('\n') : 'Side-specific play-by-play tendencies are unavailable or have not been validated; do not cite raw event-distribution totals.'}
${warnings.length ? `Validation warnings: ${warnings.join(' | ')}` : 'Validation warnings: none.'}

HARD RULES:
- Do NOT use raw all-game event distribution counts for HBP, BB, SO, GB, FB, LD, WP, PB, pickoffs, or catcher/pitcher claims.
- Do NOT report any number that conflicts with the official box-score totals above.
- If a side-specific tendency is unavailable, say it is unavailable instead of inventing or using raw event counts.
- Claude explains verified facts; Claude does not calculate new season totals.`;
}

function buildAnalysisPrompt(bundle, options = {}) {
  const { team, games, tendencies, meta,
          playerAdvanced = [], oppPitchers = [] } = bundle;

  // Filter bundle.batting and bundle.pitching to opponent-only rows (is_our_team=false).
  // Without this filter, every player from every game appears in the report regardless
  // of which team they played for.
  // NOTE: is_our_team is a real boolean in Supabase (true/false), not 0/1 — a strict
  // `=== 0` check never matches a boolean and silently zeroes out this entire dataset,
  // starving the Claude prompt of real batting/pitching data.
  const batting  = (bundle.batting  || []).filter(b => !b.is_our_team);
  const pitching = (bundle.pitching || []).filter(p => !p.is_our_team);

  const { gameLocation = null, gameDate = null } = options;

  const pgData      = getPGDataForTeam(team.team_name);
  const pitcherVelo = pgData ? pgData.pitcherVelo : {};

  const wins   = games.filter(g => g.result === 'W').length;
  const losses = games.filter(g => g.result === 'L').length;
  const ties   = games.filter(g => g.result === 'T').length;
  const withResult = games.filter(g => g.result && g.result !== '?').length;
  const winPct = withResult > 0 ? (wins / withResult).toFixed(3) : null;

  const totalH   = batting.reduce((s, b) => s + (b.total_h   || 0), 0);
  const totalBB  = batting.reduce((s, b) => s + (b.total_bb  || 0), 0);
  const totalHBP = batting.reduce((s, b) => s + (b.total_hbp || 0), 0);
  const totalAB  = batting.reduce((s, b) => s + (b.total_ab  || 0), 0);
  const totalSAC = batting.reduce((s, b) => s + (b.total_sac || 0), 0);
  // Note: batting is already filtered to is_our_team=0 (opponent only) above.
  const obpDenom = totalAB + totalBB + totalHBP + totalSAC;
  const teamOBP  = obpDenom > 0 ? ((totalH + totalBB + totalHBP) / obpDenom).toFixed(3) : null;
  const teamAVG  = totalAB > 0 ? (totalH / totalAB).toFixed(3) : null;

  const gamesStr = games.map(g =>
    `${g.game_date || '?'} vs ${g.opponent_name || 'Unknown'}: ${g.result || '?'} ${g.score_us ?? '?'}-${g.score_them ?? '?'}`
  ).join('\n');

  const battingStr = batting.slice(0, 15).map(b =>
    `${b.player_name}: ${b.games}G ${b.total_ab}AB ${b.total_h}H ` +
    `${b.total_2b ?? 0}2B ${b.total_3b ?? 0}3B ${b.total_hr ?? 0}HR ${b.total_rbi}RBI ` +
    `${b.total_bb}BB ${b.total_so}SO ${b.total_hbp ?? 0}HBP ` +
    `AVG:${fmtAvg(b.batting_avg)} OBP:${fmtAvg(b.obp)} SLG:${fmtAvg(b.slg)}`
  ).join('\n');

  const advBattingStr = (playerAdvanced || []).map(p => {
    const sd = p.swingDecisions || {};
    const swingLine = ['0-0','1-0','0-2','1-2','3-2'].map(c => {
      const d = sd[c];
      return d ? `${c}:Sw${d.swing_pct}%/TK${d.take_k_pct}%` : '';
    }).filter(Boolean).join(' ');
    return `${p.player_name}: GB%:${fmtNum(p.gb_pct,1)} FB%:${fmtNum(p.fb_pct,1)} LD%:${fmtNum(p.ld_pct,1)} ` +
           `K%:${fmtNum(p.k_pct,1)} BB%:${fmtNum(p.bb_pct,1)} BA/RISP:${fmtAvg(p.ba_risp)} ` +
           `Spray[LF:${fmtNum(p.spray_lf_pct,0)}% CF:${fmtNum(p.spray_cf_pct,0)}% RF:${fmtNum(p.spray_rf_pct,0)}% ` +
           `Pull3B:${fmtNum(p.spray_3b_pct,0)}% SS:${fmtNum(p.spray_ss_pct,0)}% ` +
           `2B:${fmtNum(p.spray_2b_pct,0)}% 1B:${fmtNum(p.spray_1b_pct,0)}% P/C:${fmtNum(p.spray_pc_pct,0)}%] ` +
           `Counts[${swingLine}]`;
  }).join('\n');

  const pitchingStr = pitching.slice(0, 8).map(p => {
    const velo = pitcherVelo[p.player_name];
    const veloNote = velo && velo.veloString ? ` [${velo.veloString}]` : '';
    return `${p.player_name}: ${p.games}G ${p.total_ip}IP BF:${p.total_bf ?? '?'} ` +
      `H:${p.total_h} R:${p.total_r} ER:${p.total_er} BB:${p.total_bb} SO:${p.total_so} ` +
      `ERA:${fmtNum(p.era)} WHIP:${fmtNum(p.whip,3)} K/BB:${fmtNum(p.k_bb_ratio)}${veloNote}`;
  }).join('\n');

  const advPitchingStr = (bundle.ourPitchers || []).map(p =>
    `${p.player_name}: S%:${fmtNum(p.s_pct,1)} SO/7:${fmtNum(p.so_per7)} BB/7:${fmtNum(p.bb_per7)} ` +
    `GB%:${fmtNum(p.gb_pct,1)} FB%:${fmtNum(p.fb_pct,1)} GO/AO:${fmtNum(p.go_ao)} ` +
    `P/IP:${fmtNum(p.p_per_ip,1)} WP:${p.wp ?? 0} BK:${p.bk ?? 0}`
  ).join('\n');

  const oppPitStr = (oppPitchers || []).map(p =>
    `${p.player_name}: S%:${fmtNum(p.s_pct,1)} SO/7:${fmtNum(p.so_per7)} BB/7:${fmtNum(p.bb_per7)} ` +
    `GB%:${fmtNum(p.gb_pct,1)} ERA:${fmtNum(p.era)} WHIP:${fmtNum(p.whip,3)}`
  ).join('\n');

  const verifiedFactsBlock = buildVerifiedFactsBlock(bundle, batting, pitching);

  // ── PitchSmart Analysis ──────────────────────────────────────────────────
  const pitchSmart = computePitchSmartEligibility(bundle, options);
  const { ageGroup, psGroup, psRules, referenceDate, recentGames } = pitchSmart;
  const pitchSmartEligibility = pitchSmart.pitchers;
  const gameDateTs = dateAtNoon(referenceDate);

  const pitchSmartStr = pitchSmartEligibility.length > 0
    ? `=== PITCHSMART ELIGIBILITY (Age Group: ${ageGroup}U, PitchSmart Group: ${psGroup}) ===
PitchSmart Rest Requirements for ${psGroup}: ${JSON.stringify(psRules?.rest)}
Max pitches allowed: ${psRules?.max}
Game date / reference date: ${referenceDate}
Games found in last 96 hours: ${recentGames.map(g => `${g.game_date} vs ${g.opponent_name}`).join(', ') || 'none'}
${pitchSmart.dateDataSuspect ? `\n*** DATA QUALITY WARNING ***\n${pitchSmart.dateDataWarning}\nYou MUST open the pitching availability discussion with this caveat, in plain language, before stating any eligibility conclusions.\n` : ''}
Per-pitcher recent activity:
${pitchSmartEligibility.map(p =>
  `${p.name}: ${p.pitches} pitches on ${p.mostRecentGameDate} vs ${p.mostRecentOpponent} → ` +
  (p.isEligible
    ? `ELIGIBLE (${p.restNeeded} rest days required, eligible ${p.eligibleDate || 'now'})`
    : `NOT ELIGIBLE — requires ${p.restNeeded} rest days → eligible again ${p.eligibleDate}`)
).join('\n')}

IMPORTANT: Apply PitchSmart rules carefully in your pitchingAnalysis. List eligible pitchers separately from ineligible ones. For every pitcher who threw in the last 96 hours, state the date they pitched, pitch count, rest days required, and eligible date.${pitchSmart.dateDataSuspect ? ' Because of the data quality warning above, present these as provisional/unverified rather than certain.' : ''}`
    : `=== PITCHSMART ELIGIBILITY ===
No scouted-team pitcher activity found in the last 96 hours for ${team.team_name}.
All pitchers presumed eligible based on available data.
Note: PitchSmart eligibility cannot be fully confirmed without recent game pitch count data.`;

  // ── Weather / Field Conditions Section ──────────────────────────────────
  const weatherSection = gameLocation
    ? `=== GAME LOCATION & CONDITIONS REQUEST ===
Game Location: ${gameLocation}
Game Date: ${gameDateTs.toISOString().slice(0,10)}

In your response, include a "weatherAndConditions" field with:
- A 5-day weather forecast for ${gameLocation} starting ${gameDateTs.toISOString().slice(0,10)}
- Wind speed and direction forecast for game day
- Temperature range
- Precipitation probability
- Expected / primary field type if known or inferable
- A grass field impact report: infield speed, footing, drainage/mud, bunt/ground-ball implications, and outfield ball speed
- A turf field impact report: surface speed, bounce, heat/rubber pellets, wet-turf traction, sliding, and defensive implications
- Any game-day strategic recommendations based on conditions (e.g., wind blowing out to LF favors pull hitters, wet infield slows grounders, turf plays fast after rain, etc.)

Use your knowledge of the location and typical conditions to provide the best forecast you can. If you cannot determine exact weather, provide the typical seasonal conditions for that location and time of year and note that a live forecast was not available.`
    : '';

  return `Analyze this baseball team and return a complete JSON scouting report.

CRITICAL STAT ACCURACY REQUIREMENT:
Use VERIFIED TEAM FACTS as the source of truth for all season totals. Do not cite raw play-event counts or all-game event distributions as team stats. If a side-specific tendency is not validated, say it is unavailable.

TEAM: ${team.team_name}
CLASSIFICATION: ${team.classification || 'Unknown'} | AGE: ${team.age_group || '?'}U | LOCATION: ${team.city || ''} ${team.state || ''}
GAMES ANALYZED: ${meta.gamesAnalyzed}
GENERATED: ${meta.generatedAt}
RECORD: ${wins}W-${losses}L${ties > 0 ? `-${ties}T` : ''} (WIN%: ${winPct ?? 'N/A'})
TEAM AVG: ${teamAVG ?? 'N/A'} | TEAM OBP: ${teamOBP ?? 'N/A'}

GAME RESULTS:
${gamesStr || 'No game results available'}

=== OUR TEAM BATTING (box score aggregates) ===
${battingStr || 'No batting data'}

=== OUR TEAM BATTING (advanced — GB/FB/LD, spray, swing decisions) ===
${advBattingStr || 'No advanced batting data'}

=== OUR TEAM PITCHING (box score aggregates) ===
${pitchingStr || 'No pitching data'}

=== OUR TEAM PITCHING (advanced — S%, SO/7, BB/7, batted ball) ===
${advPitchingStr || 'No advanced pitching data'}

=== OPPONENT PITCHERS WE FACED ===
${oppPitStr || 'No opponent pitching data'}

=== PITCHER VELOCITY — INNING BY INNING (from Perfect Game tracking) ===
${Object.keys(pitcherVelo).length > 0
  ? Object.entries(pitcherVelo)
      .sort((a,b) => (b[1].topFB||0) - (a[1].topFB||0))
      .map(([name,v]) => {
        const inningDetail = v.byInning && Object.keys(v.byInning).length > 1
          ? Object.keys(v.byInning).sort((a,b) => Number(a)-Number(b))
              .map(i => `Inn${i}: avg ${v.byInning[i].avg} mph (max ${v.byInning[i].max}, ${v.byInning[i].pitches} pitches)`)
              .join(' | ')
          : null;
        return [
          `${name}: Top FB ${v.topFB} mph | Avg FB ${v.avgFB} mph | Trend: ${v.trend}`,
          inningDetail ? `  By inning: ${inningDetail}` : `  (inning-by-inning data unavailable)`,
          v.trendNote ? `  TREND: ${v.trendNote}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n')
  : 'No PG velocity data available.'}

${verifiedFactsBlock}

${pitchSmartStr}

${weatherSection}

Return this EXACT JSON schema — fill every field, null if truly unknown:

{
  "reportMeta": {
    "teamName": "string",
    "gamesAnalyzed": number,
    "dataConfidence": "low|medium|high",
    "confidenceNote": "one sentence on confidence based on sample size"
  },
  "overallSummary": "2-3 sentence executive summary of this team's identity",
  "record": { "wins": number, "losses": number, "winPct": number },

  "pitchingAnalysis": {
    "staffDepth": "deep|adequate|thin",
    "staffNotes": "2-3 sentences on the pitching staff overall",
    "fatigueRisk": "one sentence on overuse risk",
    "keyStrengths": ["string", "string"],
    "keyWeaknesses": ["string", "string"],
    "pitchSmartSummary": {
      "eligiblePitchers": ["name", "name"],
      "ineligiblePitchers": [
        { "name": "string", "pitchesThrown": number, "eligibleDate": "YYYY-MM-DD", "note": "string" }
      ],
      "notes": "1-2 sentences on pitching availability and fatigue risk for this game"
    },
    "pitchers": [
      {
        "name": "string",
        "role": "ace|starter|reliever|unknown",
        "ip": number_or_null,
        "era": number_or_null,
        "whip": number_or_null,
        "k_bb": number_or_null,
        "s_pct": number_or_null,
        "so_per7": number_or_null,
        "bb_per7": number_or_null,
        "gb_pct": number_or_null,
        "p_per_ip": number_or_null,
        "pitchSmartEligible": true_or_false,
        "eligibleDate": "YYYY-MM-DD or null if eligible now",
        "threat": "high|medium|low",
        "commandProfile": "one sentence on strike-throwing and command",
        "note": "one sentence scouting note"
      }
    ]
  },

  "battingAnalysis": {
    "teamAvg": number_or_null,
    "teamOBP": number_or_null,
    "approachNotes": "2-3 sentences on offensive approach and tendencies",
    "keyStrengths": ["string", "string"],
    "keyWeaknesses": ["string", "string"],
    "vulnerabilities": "one sentence on exploitable weaknesses",
    "protectedHitters": [
      {
        "name": "string",
        "threat": "high|medium|low",
        "sprayTendency": "pull-heavy|balanced|oppo|middle",
        "note": "one sentence on why they are dangerous"
      }
    ]
  },

  "tendencyAnalysis": {
    "offensiveStyle": "contact|power|balanced|speed|unknown",
    "groundBallTendency": "high|medium|low|unknown",
    "strikeoutRate": "high|medium|low|unknown",
    "walkRate": "high|medium|low|unknown",
    "stolenBaseActivity": "high|medium|low|unknown",
    "keyPatterns": ["string", "string", "string"]
  },

  "gamePlan": {
    "pitchingStrategy": "3-4 sentences — how to attack their lineup",
    "defensiveAlignment": "2 sentences — where to position defense based on spray data",
    "offensiveApproach": "2-3 sentences — how to approach their pitching staff",
    "baserunning": "1-2 sentences on base path strategy",
    "keyMatchups": ["string", "string"],
    "thingsToAvoid": ["string", "string"]
  },

  "weatherAndConditions": ${gameLocation ? `{
    "location": "string",
    "gameDate": "string",
    "forecast": [
      { "date": "YYYY-MM-DD", "high": number, "low": number, "conditions": "string", "precipPct": number }
    ],
    "gameDayWind": { "speed": "string", "direction": "string", "note": "string" },
    "fieldType": "grass|turf|unknown",
    "fieldConditions": "one sentence on expected overall field conditions",
    "grassFieldReport": "2-3 sentences on how the weather affects grass/dirt fields",
    "turfFieldReport": "2-3 sentences on how the weather affects turf fields",
    "strategicNotes": "2-3 sentences on how conditions affect game strategy",
    "dataSource": "forecast|historical_typical|estimated"
  }` : 'null'},

  "playerBreakdowns": [
    {
      "name": "string",
      "primaryRole": "hitter|pitcher|two-way",
      "stats": {
        "avg": number_or_null, "obp": number_or_null, "slg": number_or_null,
        "ops": number_or_null, "hr": number_or_null, "rbi": number_or_null,
        "xbh": number_or_null, "k_pct": number_or_null, "bb_pct": number_or_null,
        "gb_pct": number_or_null, "ba_risp": number_or_null, "era": number_or_null,
        "s_pct": number_or_null, "so_per7": number_or_null, "bb_per7": number_or_null
      },
      "sprayProfile": {
        "lf_pct": number_or_null, "cf_pct": number_or_null, "rf_pct": number_or_null,
        "pull_pct": number_or_null, "oppo_pct": number_or_null,
        "tendency": "pull-heavy|balanced|oppo|middle",
        "defenseNote": "one sentence on positioning"
      },
      "swingDecisions": {
        "firstPitchSwing": number_or_null, "firstPitchTakeK": number_or_null,
        "twoStrikeSwing": number_or_null, "fullCountSwing": number_or_null,
        "profile": "aggressive-early|patient|two-strike-battler|free-swinger"
      },
      "scoutingNote": "2 sentences — how to pitch him and where to defend him",
      "threatLevel": "high|medium|low"
    }
  ],

  "fieldingSummary": {
    "catchingCS_pct": number_or_null,
    "notes": "one sentence on defensive reliability",
    "runGameRecommendation": "run|don't run|situational"
  }
}`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function analyzeTeam(teamId, options = {}) {
  console.log(`\n[analyzer] Preparing analysis for team ${teamId}...`);

  // Rebuild advanced stats from stored game data before fetching the bundle.
  // generate-report.js exposes --skip-recalc / ANALYZER_SKIP_RECALC, but the
  // analyzer previously fetched stale player_advanced_stats rows first.
  if (!options.skipRecalculate && typeof pipeline.recalculateTeamStats === 'function') {
    console.log('[analyzer] Recalculating advanced stats before report bundle...');
    await pipeline.recalculateTeamStats(teamId, {
      invertTeamSide: options.invertTeamSide === true,
    });
  } else if (options.skipRecalculate) {
    console.log('[analyzer] Advanced-stats recalculation skipped by option.');
  }

  console.log(`[analyzer] Fetching bundle for team ${teamId}...`);
  const bundle = await pipeline.getTeamBundle(teamId);
  if (!bundle || !bundle.team) throw new Error(`No team found with id: ${teamId}`);

  console.log(`[analyzer] Team: ${bundle.team.team_name}`);
  console.log(`[analyzer] Games: ${bundle.meta.gamesAnalyzed}`);
  console.log(`[analyzer] Scouted batters (box): ${(bundle.batting || []).length}`);
  console.log(`[analyzer] Scouted batters (advanced): ${(bundle.playerAdvanced || []).length}`);
  console.log(`[analyzer] Scouted pitchers (advanced): ${(bundle.ourPitchers || []).length}`);
  console.log(`[analyzer] Opp pitchers faced: ${(bundle.oppPitchers || []).length}`);
  if (options.gameLocation) console.log(`[analyzer] Game location: ${options.gameLocation}`);
  if (options.gameDate)     console.log(`[analyzer] Game date: ${options.gameDate}`);

  if (bundle.meta.gamesAnalyzed === 0) {
    throw new Error(`${bundle.team.team_name} has no games yet. Run the scraper first.`);
  }

  console.log(`[analyzer] Sending to Claude (${CLAUDE_MODEL})...`);

  const analysis = await callClaude(SYSTEM_PROMPT, buildAnalysisPrompt(bundle, options));
  const pitchSmart = computePitchSmartEligibility(bundle, options);

  analysis._pitchSmartEligibility = pitchSmart;
  analysis._gameContext = {
    gameLocation: options.gameLocation || null,
    gameDate: pitchSmart.referenceDate || options.gameDate || null,
  };

  analysis._bundle      = bundle;
  analysis._teamId      = teamId;
  analysis._generatedAt = new Date().toISOString();
  analysis._playerAdvanced = bundle.playerAdvanced || [];
  analysis._ourPitchers    = bundle.ourPitchers    || [];
  analysis._oppPitchers    = bundle.oppPitchers    || [];

  const gms    = bundle.games || [];
  const wins   = gms.filter(g => g.result === 'W').length;
  const losses = gms.filter(g => g.result === 'L').length;
  const withResult = gms.filter(g => g.result && g.result !== '?').length;
  analysis._record = {
    wins, losses,
    ties:   gms.filter(g => g.result === 'T').length,
    winPct: withResult > 0 ? parseFloat((wins / withResult).toFixed(3)) : null,
  };

  // NOTE: is_our_team is a real boolean in Supabase — see comment in buildAnalysisPrompt.
  const bat      = (bundle.batting || []).filter(b => !b.is_our_team);
  const totalH   = bat.reduce((s, b) => s + (b.total_h   || 0), 0);
  const totalBB  = bat.reduce((s, b) => s + (b.total_bb  || 0), 0);
  const totalHBP = bat.reduce((s, b) => s + (b.total_hbp || 0), 0);
  const totalAB  = bat.reduce((s, b) => s + (b.total_ab  || 0), 0);
  const totalSAC = bat.reduce((s, b) => s + (b.total_sac || 0), 0);
  const obpDenom = totalAB + totalBB + totalHBP + totalSAC;
  analysis._teamStats = {
    avg: totalAB > 0 ? parseFloat((totalH / totalAB).toFixed(3)) : null,
    obp: obpDenom > 0 ? parseFloat(((totalH + totalBB + totalHBP) / obpDenom).toFixed(3)) : null,
  };

  console.log(`[analyzer] Done. Confidence: ${analysis.reportMeta?.dataConfidence}`);
  return analysis;
}

async function analyzeAllTeams(options = {}) {
  const teams   = db.getAllTeams();
  const results = [];
  for (const team of teams) {
    try {
      const b = pipeline.getTeamBundle(team.id);
      if (b.meta.gamesAnalyzed === 0) { console.log(`[analyzer] Skipping ${team.team_name} — no games.`); continue; }
      const analysis = await analyzeTeam(team.id, options);
      results.push({ teamId: team.id, teamName: team.team_name, analysis });
    } catch (err) {
      console.error(`[analyzer] Failed for ${team.team_name}: ${err.message}`);
      results.push({ teamId: team.id, teamName: team.team_name, error: err.message });
    }
  }
  return results;
}

module.exports = { analyzeTeam, analyzeAllTeams, callClaude, buildAnalysisPrompt, parseClaudeJson, extractJsonCandidate, computePitchSmartEligibility };