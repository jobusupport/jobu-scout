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
  '7-8':   { max: 50,  rest: { 1: 0, 20: 1, 35: 2, 50: 3 } },
  '9-10':  { max: 75,  rest: { 1: 0, 26: 1, 51: 2, 66: 3 } },
  '11-12': { max: 85,  rest: { 1: 0, 26: 1, 51: 2, 66: 3 } },
  '13-14': { max: 95,  rest: { 1: 0, 36: 1, 61: 2, 76: 3 } },
  '15-16': { max: 95,  rest: { 1: 0, 36: 1, 61: 2, 76: 3 } },
  '17-18': { max: 105, rest: { 1: 0, 36: 1, 61: 2, 76: 3 } },
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

function computePitchSmartEligibility(bundle, options = {}) {
  const team = bundle.team || {};
  const ageGroup = team.age_group || '14';
  const psGroup = getPitchSmartGroup(ageGroup);
  const psRules = PITCHSMART_RULES[psGroup];
  const referenceDate = options.gameDate || new Date().toISOString().slice(0, 10);
  const referenceTs = dateAtNoon(referenceDate);

  const allPitchLines = bundle.recentPitchingLines || [];

  // ── Determine which is_our_team flag belongs to the scouted team ───────────
  // Pre-reingest rows have is_our_team=1; post-reingest rows have is_our_team=0.
  // Whichever value has more distinct player names is the scouted team's side.
  const countByFlag = { 0: new Set(), 1: new Set() };
  for (const line of allPitchLines) {
    countByFlag[line.is_our_team === 1 ? 1 : 0].add(line.player_name);
  }
  const scoutedIsOurTeam = countByFlag[1].size >= countByFlag[0].size ? 1 : 0;
  const scoutedLines = allPitchLines.filter(l => (l.is_our_team === 1 ? 1 : 0) === scoutedIsOurTeam);

  // ── Find the most recent game dates this team played (up to their last 2 dates) ──
  // We use the most recent game dates in the data, NOT a fixed calendar window,
  // because scouted teams may not have played recently relative to the report date.
  const allGameDates = [...new Set(
    scoutedLines.map(l => l.game_date).filter(Boolean)
  )].sort((a, b) => dateAtNoon(b) - dateAtNoon(a)); // newest first

  // Take pitching lines from the most recent 2 distinct game dates only.
  // This is the correct PitchSmart lookback: what did they throw in their last
  // 1-2 outings, and how many days rest do they need before our game?
  const lookbackDates = new Set(allGameDates.slice(0, 2));

  const pitcherRecentPitches = {};
  for (const line of scoutedLines) {
    if (!line.game_date || !lookbackDates.has(line.game_date)) continue;

    if (!pitcherRecentPitches[line.player_name]) {
      pitcherRecentPitches[line.player_name] = { pitches: 0, games: [] };
    }

    const pitches = Number(line.pitch_count) > 0
      ? Number(line.pitch_count)
      : Math.round((Number(line.bf) || 0) * 3.8);

    pitcherRecentPitches[line.player_name].pitches += pitches;
    pitcherRecentPitches[line.player_name].games.push({
      date: line.game_date,
      pitches,
      opponent: line.opponent_name || 'Unknown',
      ip: line.ip || null,
    });
  }

  const pitchers = Object.entries(pitcherRecentPitches).map(([name, data]) => {
    const pitches = data.pitches;
    const restNeeded = getRequiredRestDays(pitches, ageGroup);
    const mostRecentGame = data.games
      .slice()
      .sort((a, b) => dateAtNoon(b.date) - dateAtNoon(a.date))[0];

    // Days of rest already accrued between their last outing and our game date
    const lastPitchedTs = dateAtNoon(mostRecentGame.date);
    const daysSince = Math.floor((referenceTs - lastPitchedTs) / (1000 * 60 * 60 * 24));

    // Eligible date = last pitched date + required rest days + 1
    const eligibleDate = restNeeded === 0
      ? mostRecentGame.date
      : addCalendarDays(mostRecentGame.date, restNeeded + 1);
    const isEligible = dateAtNoon(eligibleDate) <= referenceTs;

    return {
      name,
      pitches,
      restNeeded,
      daysSince,
      isEligible,
      eligibleDate,
      mostRecentGameDate: mostRecentGame.date,
      mostRecentOpponent: mostRecentGame.opponent,
      games: data.games,
    };
  }).sort((a, b) => {
    // Not eligible first, then by most recent outing date, then by pitch count
    if (a.isEligible !== b.isEligible) return a.isEligible ? 1 : -1;
    return dateAtNoon(b.mostRecentGameDate) - dateAtNoon(a.mostRecentGameDate)
      || b.pitches - a.pitches;
  });

  // The "recent games" context for the report header
  const recentGames = [...lookbackDates].map(d => ({ game_date: d }));

  return {
    ageGroup,
    psGroup,
    psRules,
    referenceDate: referenceTs.toISOString().slice(0, 10),
    lookbackDates: [...lookbackDates].sort(),
    recentGames,
    pitchers,
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

function buildAnalysisPrompt(bundle, options = {}) {
  const { team, games, tendencies, meta,
          playerAdvanced = [], oppPitchers = [] } = bundle;

  // Filter bundle.batting and bundle.pitching to opponent-only rows (is_our_team=0).
  // Without this filter, every player from every game appears in the report regardless
  // of which team they played for.
  const batting  = (bundle.batting  || []).filter(b => b.is_our_team === 0);
  const pitching = (bundle.pitching || []).filter(p => p.is_our_team === 0);

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

  const tendencyStr = tendencies.map(t =>
    `${t.event_type}: ${t.count} (${t.pct}%)`
  ).join('\n');

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

Per-pitcher recent activity:
${pitchSmartEligibility.map(p =>
  `${p.name}: ${p.pitches} pitches on ${p.mostRecentGameDate} vs ${p.mostRecentOpponent} → ` +
  (p.isEligible
    ? `ELIGIBLE (${p.restNeeded} rest days required, eligible ${p.eligibleDate || 'now'})`
    : `NOT ELIGIBLE — requires ${p.restNeeded} rest days → eligible again ${p.eligibleDate}`)
).join('\n')}

IMPORTANT: Apply PitchSmart rules carefully in your pitchingAnalysis. List eligible pitchers separately from ineligible ones. For every pitcher who threw in the last 96 hours, state the date they pitched, pitch count, rest days required, and eligible date.`
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

=== PLAY-BY-PLAY EVENT DISTRIBUTION ===
${tendencyStr || 'No play data'}

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
  console.log(`\n[analyzer] Fetching bundle for team ${teamId}...`);

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

  const bat      = (bundle.batting || []).filter(b => b.is_our_team === 0);
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