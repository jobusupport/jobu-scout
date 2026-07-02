'use strict';

/**
 * game-reconstructor.js
 *
 * Reconstructs side-specific baseball totals from GameChanger play-by-play and
 * validates them against the official box-score rows already stored in the DB.
 *
 * Product rule:
 *   - Box score totals are the official source for season stat totals.
 *   - Play-by-play is used for advanced tendencies only when it can be
 *     side-attributed and measured against the box score.
 *   - Raw all-game event counts are diagnostic only and should never be passed
 *     to the LLM as team facts.
 */

const HIT_EVENTS = new Set(['single', 'double', 'triple', 'home_run']);
const AB_EVENTS = new Set([
  'single', 'double', 'triple', 'home_run',
  'strikeout', 'ground_out', 'fly_out', 'line_out', 'pop_out', 'foul_out',
  'fielders_choice', 'error',
]);
const NON_AB_EVENTS = new Set(['walk', 'ibb', 'hbp', 'sac_fly', 'sac_bunt']);
const LABEL_ONLY = new Set([
  'single', 'double', 'triple', 'home run', 'strikeout', 'walk', 'hit by pitch',
  'ground out', 'fly out', 'line out', 'pop out', 'foul out', 'passed ball',
  'wild pitch', 'fielder\'s choice', 'sacrifice fly', 'sacrifice bunt', 'error',
]);

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function toNum(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '-' || trimmed.toUpperCase() === 'N/A') return fallback;
    const n = Number(trimmed.replace(/,/g, '').replace(/%$/, ''));
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function emptyBattingTotals() {
  return {
    pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, so: 0, hbp: 0,
    doubles: 0, triples: 0, hr: 0, sb: 0, sac: 0,
    ground_out: 0, fly_out: 0, line_out: 0, pop_out: 0,
    batted_balls: 0,
  };
}

function emptyPitchingDefenseTotals() {
  return {
    wp: 0, pb: 0, bk: 0, pickoff: 0,
    batters_faced_from_pbp: 0,
    strikeouts: 0, walks: 0, hbp: 0,
    ground_outs_allowed: 0, fly_outs_allowed: 0, line_outs_allowed: 0,
  };
}

function addInto(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'number') target[key] = (target[key] || 0) + value;
  }
  return target;
}

function getRaw(row, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
    const lower = key.toLowerCase();
    const upper = key.toUpperCase();
    if (row[lower] !== undefined && row[lower] !== null && row[lower] !== '') return row[lower];
    if (row[upper] !== undefined && row[upper] !== null && row[upper] !== '') return row[upper];
  }
  return null;
}

function playerNameFromRow(row) {
  return clean(row.Player || row.Name || row.player_name || row.playerName || '');
}

function teamSideFromRow(row) {
  return clean(row.TeamSide || row.teamSide || row.team_side || '').toLowerCase();
}

function isScoutedRow(row) {
  return row.isOurTeam === false || row.is_our_team === false || row.is_our_team === 0;
}

function boxBattingTotals(rows = []) {
  const totals = emptyBattingTotals();
  for (const row of rows) {
    totals.ab      += toNum(getRaw(row, 'AB'));
    totals.r       += toNum(getRaw(row, 'R'));
    totals.h       += toNum(getRaw(row, 'H'));
    totals.rbi     += toNum(getRaw(row, 'RBI'));
    totals.bb      += toNum(getRaw(row, 'BB'));
    totals.so      += toNum(getRaw(row, 'SO', 'K'));
    totals.hbp     += toNum(getRaw(row, 'HBP'));
    totals.doubles += toNum(getRaw(row, '2B', 'Doubles'));
    totals.triples += toNum(getRaw(row, '3B', 'Triples'));
    totals.hr      += toNum(getRaw(row, 'HR', 'Home Runs'));
    totals.sb      += toNum(getRaw(row, 'SB'));
    totals.sac     += toNum(getRaw(row, 'SAC', 'Sac', 'SF'));
  }
  totals.pa = totals.ab + totals.bb + totals.hbp + totals.sac;
  return totals;
}

function boxPitchingTotals(rows = []) {
  return rows.reduce((totals, row) => {
    totals.bf      += toNum(getRaw(row, 'BF'));
    totals.pc      += toNum(getRaw(row, 'PC', 'Pitches'));
    totals.strikes += toNum(getRaw(row, 'STR', 'Strikes'));
    totals.h       += toNum(getRaw(row, 'H'));
    totals.r       += toNum(getRaw(row, 'R'));
    totals.er      += toNum(getRaw(row, 'ER'));
    totals.bb      += toNum(getRaw(row, 'BB'));
    totals.so      += toNum(getRaw(row, 'SO', 'K'));
    totals.hr      += toNum(getRaw(row, 'HR'));
    totals.wp      += toNum(getRaw(row, 'WP'));
    totals.hbp     += toNum(getRaw(row, 'HBP'));
    return totals;
  }, { bf: 0, pc: 0, strikes: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, wp: 0, hbp: 0 });
}

function makeAliasMap(players) {
  const map = new Map();
  const lastNameCounts = new Map();

  for (const player of players) {
    const parts = clean(player).split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const last = parts[parts.length - 1];
    lastNameCounts.set(norm(last), (lastNameCounts.get(norm(last)) || 0) + 1);
  }

  function add(alias, full) {
    const key = norm(alias);
    if (!key) return;
    if (!map.has(key)) map.set(key, full);
  }

  for (const full of players) {
    const parts = clean(full).split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const first = parts[0];
    const last = parts[parts.length - 1];
    add(full, full);
    add(`${first[0]} ${last}`, full);
    add(`${first[0]}. ${last}`, full);
    if (lastNameCounts.get(norm(last)) === 1) add(last, full);
  }

  return map;
}

function buildRosterContext(game) {
  const batting = game.boxScore?.batting || [];
  const pitching = game.boxScore?.pitching || [];
  const scoutedPlayers = new Set();
  const opponentPlayers = new Set();
  const scoutedSides = new Set();
  const opponentSides = new Set();

  for (const row of [...batting, ...pitching]) {
    const name = playerNameFromRow(row);
    const side = teamSideFromRow(row);
    if (!name) continue;
    if (isScoutedRow(row)) {
      scoutedPlayers.add(name);
      if (side) scoutedSides.add(side);
    } else {
      opponentPlayers.add(name);
      if (side) opponentSides.add(side);
    }
  }

  const scoutedSide = scoutedSides.size === 1 ? [...scoutedSides][0] : null;
  const opponentSide = opponentSides.size === 1 ? [...opponentSides][0] : null;

  return {
    scoutedSide,
    opponentSide,
    scoutedAliasMap: makeAliasMap([...scoutedPlayers]),
    opponentAliasMap: makeAliasMap([...opponentPlayers]),
    scoutedPlayers: [...scoutedPlayers],
    opponentPlayers: [...opponentPlayers],
  };
}

function sideFromRawSide(rawSide, ctx) {
  const side = clean(rawSide).toLowerCase();
  if (!side) return 'unknown';
  if (ctx.scoutedSide && side === ctx.scoutedSide) return 'scouted';
  if (ctx.opponentSide && side === ctx.opponentSide) return 'opponent';
  return 'unknown';
}

function offenseSideFromInning(inning, ctx) {
  const text = clean(inning).toLowerCase();
  const battingRawSide = text.startsWith('top') ? 'away' : text.startsWith('bottom') ? 'home' : null;
  return sideFromRawSide(battingRawSide, ctx);
}

function defenseSideFromOffense(offenseSide) {
  if (offenseSide === 'scouted') return 'opponent';
  if (offenseSide === 'opponent') return 'scouted';
  return 'unknown';
}

function detectEventType(description) {
  const t = clean(description).toLowerCase();
  if (!t) return null;

  const starts = [
    ['hit by pitch', 'hbp'],
    ['fielder\'s choice', 'fielders_choice'],
    ['fielders choice', 'fielders_choice'],
    ['home run', 'home_run'],
    ['ground out', 'ground_out'],
    ['line out', 'line_out'],
    ['fly out', 'fly_out'],
    ['pop out', 'pop_out'],
    ['foul out', 'foul_out'],
    ['intentional walk', 'ibb'],
    ['sacrifice fly', 'sac_fly'],
    ['sac fly', 'sac_fly'],
    ['sacrifice bunt', 'sac_bunt'],
    ['sac bunt', 'sac_bunt'],
    ['strikeout', 'strikeout'],
    ['single', 'single'],
    ['double', 'double'],
    ['triple', 'triple'],
    ['walk', 'walk'],
    ['error', 'error'],
  ];
  for (const [prefix, type] of starts) if (t.startsWith(prefix)) return type;

  const phrases = [
    [/\bis hit by pitch\b/, 'hbp'],
    [/\bwalks\b/, 'walk'],
    [/\bintentionally walks\b/, 'ibb'],
    [/\bstrikes out\b/, 'strikeout'],
    [/\bsingles\b/, 'single'],
    [/\bdoubles\b/, 'double'],
    [/\btriples\b/, 'triple'],
    [/\bhomers\b|\bhits a home run\b/, 'home_run'],
    [/\bgrounds out\b|\bgrounds into\b/, 'ground_out'],
    [/\bflies out\b/, 'fly_out'],
    [/\blines out\b/, 'line_out'],
    [/\bpops out\b/, 'pop_out'],
    [/\breaches on an? error\b|\bon an? error\b/, 'error'],
    [/\bsacrifice fly\b|\bsac fly\b/, 'sac_fly'],
    [/\bsacrifice bunt\b|\bsac bunt\b|\bbunts\b/, 'sac_bunt'],
  ];
  for (const [regex, type] of phrases) if (regex.test(t)) return type;

  return null;
}

function isLabelOnlyDescription(description) {
  const t = norm(description);
  if (!t) return true;
  if (LABEL_ONLY.has(t)) return true;
  // Rows that only contain an event label and score/out prefix, no narrative.
  return !/[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2}\s+(?:walks|singles|doubles|triples|homers|strikes out|is hit by pitch|grounds out|flies out|lines out|pops out|reaches|bunts)/.test(description);
}

function splitNarrative(description) {
  const t = clean(description);
  const match = t.match(/^(.*?)\.\s+([A-Z].*)$/s);
  return match ? { pitchPart: match[1], narrative: match[2] } : { pitchPart: '', narrative: t };
}

function extractNamedActor(text, eventType) {
  const narrative = clean(text);
  if (!narrative) return null;

  const verbByEvent = {
    single: 'singles',
    double: 'doubles',
    triple: 'triples',
    home_run: 'homers|hits a home run',
    strikeout: 'strikes out|is out on foul tip',
    walk: 'walks',
    ibb: 'intentionally walks|walks',
    hbp: 'is hit by pitch',
    ground_out: 'grounds out|grounds into',
    fly_out: 'flies out',
    line_out: 'lines out',
    pop_out: 'pops out',
    foul_out: 'is out on foul',
    fielders_choice: 'grounds into|reaches on a fielder',
    error: 'reaches on an? error|on an? error',
    sac_fly: 'sacrifice fly|flies out',
    sac_bunt: 'sacrifice bunt|bunts',
  };

  const verb = verbByEvent[eventType] || '[a-z]+';
  const namePattern = `([A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]+){0,2})`;
  const re = new RegExp(`${namePattern}\\s+(?:${verb})`);
  const m = narrative.match(re);
  if (m) return clean(m[1]);

  const leading = narrative.match(/^([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+[a-z]/);
  return leading ? clean(leading[1]) : null;
}

function extractPitcher(text) {
  const m = clean(text).match(/,\s*([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+pitching\b/);
  return m ? clean(m[1]) : null;
}

function resolvePlayerSide(rawName, offenseSide, ctx) {
  const key = norm(rawName);
  if (!key) return { player: null, side: offenseSide || 'unknown', matched: false };

  const scouted = ctx.scoutedAliasMap.get(key);
  const opponent = ctx.opponentAliasMap.get(key);

  if (scouted && opponent) return { player: offenseSide === 'opponent' ? opponent : scouted, side: offenseSide, matched: true };
  if (scouted) return { player: scouted, side: 'scouted', matched: true };
  if (opponent) return { player: opponent, side: 'opponent', matched: true };
  return { player: rawName, side: offenseSide || 'unknown', matched: false };
}

function parsePlay(play, ctx) {
  const description = clean(play.text || play.description || '');
  if (!description || isLabelOnlyDescription(description)) return null;

  const eventType = detectEventType(description);
  if (!eventType) return null;

  const { pitchPart, narrative } = splitNarrative(description);
  const offenseSideByInning = offenseSideFromInning(play.inning || play.inning_label, ctx);
  const batterRaw = extractNamedActor(narrative, eventType) || extractNamedActor(description, eventType);
  const pitcherRaw = extractPitcher(narrative) || extractPitcher(description);
  const batterResolved = resolvePlayerSide(batterRaw, offenseSideByInning, ctx);
  const pitcherResolved = resolvePlayerSide(pitcherRaw, defenseSideFromOffense(batterResolved.side || offenseSideByInning), ctx);
  const offenseSide = batterResolved.side !== 'unknown' ? batterResolved.side : offenseSideByInning;
  const defenseSide = pitcherResolved.side !== 'unknown' ? pitcherResolved.side : defenseSideFromOffense(offenseSide);

  const hasPitchSequence = /\b(?:Ball|Strike|Foul|In play)\b/i.test(pitchPart || description);
  return {
    eventType,
    batterRaw,
    batter: batterResolved.player,
    batterMatched: batterResolved.matched,
    pitcherRaw,
    pitcher: pitcherResolved.player,
    pitcherMatched: pitcherResolved.matched,
    offenseSide,
    defenseSide,
    hasPitchSequence,
    description,
    inning: play.inning || play.inning_label || null,
  };
}

function applyPA(totals, parsed) {
  totals.pa += 1;
  const e = parsed.eventType;
  if (AB_EVENTS.has(e)) totals.ab += 1;
  if (HIT_EVENTS.has(e)) totals.h += 1;
  if (e === 'double') totals.doubles += 1;
  if (e === 'triple') totals.triples += 1;
  if (e === 'home_run') totals.hr += 1;
  if (e === 'walk' || e === 'ibb') totals.bb += 1;
  if (e === 'strikeout') totals.so += 1;
  if (e === 'hbp') totals.hbp += 1;
  if (e === 'sac_fly' || e === 'sac_bunt') totals.sac += 1;
  if (e === 'ground_out') totals.ground_out += 1;
  if (e === 'fly_out') totals.fly_out += 1;
  if (e === 'line_out') totals.line_out += 1;
  if (e === 'pop_out') totals.pop_out += 1;
  if (['ground_out', 'fly_out', 'line_out', 'pop_out'].includes(e)) totals.batted_balls += 1;
}

function applyDefenseEvent(totals, parsed) {
  const text = parsed.description;
  const wildPitchCount = (text.match(/\bwild pitch\b/gi) || []).length;
  const passedBallCount = (text.match(/\bpassed ball\b/gi) || []).length;
  const balkCount = (text.match(/\bbalk\b/gi) || []).length;
  const pickoffCount = (text.match(/\bpickoff\b/gi) || []).length;
  totals.wp += wildPitchCount;
  totals.pb += passedBallCount;
  totals.bk += balkCount;
  totals.pickoff += pickoffCount;
  if (parsed.eventType === 'strikeout') totals.strikeouts += 1;
  if (parsed.eventType === 'walk' || parsed.eventType === 'ibb') totals.walks += 1;
  if (parsed.eventType === 'hbp') totals.hbp += 1;
  if (parsed.eventType === 'ground_out') totals.ground_outs_allowed += 1;
  if (parsed.eventType === 'fly_out') totals.fly_outs_allowed += 1;
  if (parsed.eventType === 'line_out') totals.line_outs_allowed += 1;
}

function deltaTotals(box, reconstructed) {
  const keys = ['pa', 'ab', 'h', 'bb', 'so', 'hbp', 'doubles', 'triples', 'hr'];
  const deltas = {};
  for (const key of keys) deltas[key] = (reconstructed[key] || 0) - (box[key] || 0);
  return deltas;
}

function isValidated(deltas, hasPlayByPlay) {
  if (!hasPlayByPlay) return false;
  const strictKeys = ['ab', 'h', 'bb', 'so', 'hbp'];
  return strictKeys.every(key => Math.abs(deltas[key] || 0) <= 1);
}

function summarizeQuality(result) {
  const warnings = [];
  if (!result.hasPlayByPlay) warnings.push('No play-by-play rows for this game; official totals use box score only.');
  if (result.hasPlayByPlay && !result.scouted.validation.battingMatchesBox) {
    warnings.push('Play-by-play reconstruction differs from scouted-team box score; official totals use box score and advanced tendencies are lower confidence.');
  }
  return warnings;
}

function reconstructGame(game) {
  const ctx = buildRosterContext(game);
  const boxScoutedBattingRows = (game.boxScore?.batting || []).filter(isScoutedRow);
  const boxOpponentBattingRows = (game.boxScore?.batting || []).filter(row => !isScoutedRow(row));
  const boxScoutedPitchingRows = (game.boxScore?.pitching || []).filter(isScoutedRow);
  const boxOpponentPitchingRows = (game.boxScore?.pitching || []).filter(row => !isScoutedRow(row));

  const result = {
    gameId: game.meta?.gameId || game.id || null,
    gameDate: game.meta?.gameDate || game.game_date || null,
    opponentName: game.meta?.opponentName || game.opponent_name || null,
    scoutedSide: ctx.scoutedSide,
    opponentSide: ctx.opponentSide,
    hasBoxScore: boxScoutedBattingRows.length > 0 || boxScoutedPitchingRows.length > 0,
    hasPlayByPlay: (game.plays || []).length > 0,
    scouted: {
      boxBatting: boxBattingTotals(boxScoutedBattingRows),
      boxPitching: boxPitchingTotals(boxScoutedPitchingRows),
      reconstructedBatting: emptyBattingTotals(),
      reconstructedPitchingDefense: emptyPitchingDefenseTotals(),
      validation: {},
    },
    opponent: {
      boxBatting: boxBattingTotals(boxOpponentBattingRows),
      boxPitching: boxPitchingTotals(boxOpponentPitchingRows),
      reconstructedBatting: emptyBattingTotals(),
      reconstructedPitchingDefense: emptyPitchingDefenseTotals(),
      validation: {},
    },
    parsedPlateAppearances: 0,
    skippedPlays: 0,
    duplicateSkips: 0,
    unmatchedBatters: 0,
    unmatchedPitchers: 0,
  };

  const keptKeys = new Set();
  let previous = null;

  for (const play of (game.plays || [])) {
    const parsed = parsePlay(play, ctx);
    if (!parsed) { result.skippedPlays += 1; continue; }

    const dedupeKey = [parsed.inning, parsed.eventType, norm(parsed.batter), norm(parsed.pitcher)].join('|');
    const likelyDuplicate = previous && previous.dedupeKey === dedupeKey && (!parsed.hasPitchSequence || previous.hasPitchSequence);
    if (likelyDuplicate || keptKeys.has(`${dedupeKey}|${norm(parsed.description)}`)) {
      result.duplicateSkips += 1;
      continue;
    }
    keptKeys.add(`${dedupeKey}|${norm(parsed.description)}`);
    previous = { dedupeKey, hasPitchSequence: parsed.hasPitchSequence };

    if (!parsed.batterMatched && parsed.batterRaw) result.unmatchedBatters += 1;
    if (!parsed.pitcherMatched && parsed.pitcherRaw) result.unmatchedPitchers += 1;

    if (parsed.offenseSide === 'scouted') {
      applyPA(result.scouted.reconstructedBatting, parsed);
    } else if (parsed.offenseSide === 'opponent') {
      applyPA(result.opponent.reconstructedBatting, parsed);
    }

    if (parsed.defenseSide === 'scouted') {
      applyDefenseEvent(result.scouted.reconstructedPitchingDefense, parsed);
    } else if (parsed.defenseSide === 'opponent') {
      applyDefenseEvent(result.opponent.reconstructedPitchingDefense, parsed);
    }
    result.parsedPlateAppearances += AB_EVENTS.has(parsed.eventType) || NON_AB_EVENTS.has(parsed.eventType) ? 1 : 0;
  }

  result.scouted.validation.battingDelta = deltaTotals(result.scouted.boxBatting, result.scouted.reconstructedBatting);
  result.opponent.validation.battingDelta = deltaTotals(result.opponent.boxBatting, result.opponent.reconstructedBatting);
  result.scouted.validation.battingMatchesBox = isValidated(result.scouted.validation.battingDelta, result.hasPlayByPlay);
  result.opponent.validation.battingMatchesBox = isValidated(result.opponent.validation.battingDelta, result.hasPlayByPlay);
  result.warnings = summarizeQuality(result);

  return result;
}

function summarizeTeamValidation(teamId, games, gameResults) {
  const officialBatting = emptyBattingTotals();
  const reconstructedBatting = emptyBattingTotals();
  const officialPitching = { bf: 0, pc: 0, strikes: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, wp: 0, hbp: 0 };
  const reconstructedPitchingDefense = emptyPitchingDefenseTotals();

  for (const r of gameResults) {
    addInto(officialBatting, r.scouted.boxBatting);
    addInto(reconstructedBatting, r.scouted.reconstructedBatting);
    addInto(officialPitching, r.scouted.boxPitching);
    addInto(reconstructedPitchingDefense, r.scouted.reconstructedPitchingDefense);
  }

  const gamesWithBox = gameResults.filter(r => r.hasBoxScore).length;
  const gamesWithPbp = gameResults.filter(r => r.hasPlayByPlay).length;
  const validatedGames = gameResults.filter(r => r.scouted.validation.battingMatchesBox).length;
  const mismatchGames = gameResults.filter(r => r.hasPlayByPlay && !r.scouted.validation.battingMatchesBox).length;
  const playCoverage = gameResults.length ? gamesWithPbp / gameResults.length : 0;
  const validationRate = gamesWithPbp ? validatedGames / gamesWithPbp : 0;
  const confidence = validationRate >= 0.85 && playCoverage >= 0.85 ? 'high'
    : validationRate >= 0.6 && playCoverage >= 0.6 ? 'medium'
    : 'low';

  const warnings = [];
  if (gamesWithPbp < gameResults.length) warnings.push(`${gameResults.length - gamesWithPbp} game(s) lack play-by-play; official totals use box score.`);
  if (mismatchGames > 0) warnings.push(`${mismatchGames} game(s) have play-by-play/box-score mismatches; official totals use box score.`);

  return {
    teamId,
    games: gameResults.length,
    boxScoreGames: gamesWithBox,
    playByPlayGames: gamesWithPbp,
    validatedGames,
    mismatchGames,
    confidence,
    officialBatting,
    officialPitching,
    reconstructedBatting,
    reconstructedPitchingDefense,
    deltas: deltaTotals(officialBatting, reconstructedBatting),
    tendencies: {
      scoutedBatting: {
        hbp: officialBatting.hbp,
        walks: officialBatting.bb,
        strikeouts: officialBatting.so,
        groundOutsValidatedPbp: reconstructedBatting.ground_out,
        flyOutsValidatedPbp: reconstructedBatting.fly_out,
        lineOutsValidatedPbp: reconstructedBatting.line_out,
        note: 'Official BB/HBP/SO totals come from box score. Batted-ball tendencies are from side-attributed play-by-play and should be treated as lower confidence if mismatchGames > 0.',
      },
      scoutedPitchingDefense: {
        wildPitchesFromBoxScore: officialPitching.wp,
        wildPitchesFromSideAttributedPbp: reconstructedPitchingDefense.wp,
        passedBallsFromSideAttributedPbp: reconstructedPitchingDefense.pb,
        pickoffsFromSideAttributedPbp: reconstructedPitchingDefense.pickoff,
        note: 'WP/PB/Pickoff tendencies are side-attributed from play-by-play when available; do not use raw all-game event totals.',
      },
    },
    warnings,
  };
}

function reconstructTeamGames(teamId, games = []) {
  const gameResults = games.map(reconstructGame);
  const summary = summarizeTeamValidation(teamId, games, gameResults);
  return { summary, gameResults };
}

module.exports = {
  reconstructGame,
  reconstructTeamGames,
  buildRosterContext,
  parsePlay,
  detectEventType,
  boxBattingTotals,
  boxPitchingTotals,
};
