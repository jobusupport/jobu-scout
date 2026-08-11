'use strict';

/**
 * High School Slice 2B pure baseball-domain orchestration.
 *
 * Authoritative calculations live in normalize-core.js, reconstruct-core.js,
 * and stats-core.js. This module owns the explicit public contracts around
 * those cores: own/opponent translation, game identity and collection
 * reconciliation, deterministic normalization options, and result vocabulary.
 *
 * Legacy Travel entry points remain narrow compatibility adapters over the
 * same core modules. Neither this module nor the cores perform database,
 * network, filesystem, deployment, or persistence work.
 *
 * Collection identity is conservative. A durable source game ID wins.
 * Otherwise every schedule discriminator must be meaningful before a
 * composite identity is resolved. Unresolved games are retained separately,
 * including byte-identical snapshots, so ambiguous doubleheaders cannot be
 * collapsed. Resolved duplicate snapshots expose reconciliation provenance
 * and material conflicts instead of silently hiding disagreement.
 *
 * Player accumulation is durable-ID-first. When no durable player ID can be
 * resolved, stats-core keeps the result in an explicit game-scoped unresolved
 * bucket rather than merging it into another player by display name.
 */

const { reconstructGame, reconstructTeamGames } = require('./reconstruct-core');
const { normalizeGameData } = require('./normalize-core');
const { processGames } = require('./stats-core');

// ─── Shared ownership-translation helpers ──────────────────────────────────

function requireExplicitOwnBoolean(row, rowKind, index) {
  if (!row || typeof row !== 'object') {
    throw new Error(`baseball-engine: ${rowKind}[${index}] must be an object`);
  }
  if (!Object.prototype.hasOwnProperty.call(row, 'own')) {
    throw new Error(`baseball-engine: ${rowKind}[${index}] is missing the required explicit "own" boolean; ownership is never guessed or defaulted`);
  }
  if (typeof row.own !== 'boolean') {
    throw new Error(`baseball-engine: ${rowKind}[${index}].own must be a boolean (true for the caller's own team, false for the opponent)`);
  }
  return row.own;
}

// Translates one explicit-`own` row into reconstruct-core.js's compatibility
// shape. reconstructGame's isScoutedRow() treats is_our_team === false as
// the "scouted" bucket -- so own:true (this row is ours) must become
// is_our_team:false to land in "scouted", and own:false (opponent) must
// become is_our_team:true. This single inversion point is the ONE place,
// tested in isolation below, that performs it.
function toReconstructionRow(row, rowKind, index) {
  const own = requireExplicitOwnBoolean(row, rowKind, index);
  const { own: _own, isOurTeam: _legacyIsOurTeam, is_our_team: _legacySnakeIsOurTeam, ...rest } = row;
  return { ...rest, is_our_team: !own };
}

// Contradictory-metadata guard: reconstruct-core.js's own scoutedSide/
// opponentSide resolution (buildRosterContext) treats each bucket's venue
// side independently -- if a caller supplies rows where the SAME TeamSide
// (venue) carries both own:true and own:false rows, the underlying legacy
// function does not detect this; it silently resolves ownSide and
// opponentSide to the SAME venue value, which is logically incoherent (two
// teams cannot both play at the venue in one game) but was not previously
// rejected. This is exactly the kind of caller error the explicit
// own/opponent contract exists to catch rather than paper over, so it is
// checked and rejected here, at the one place both reconstructBaseballGame
// and reconstructBaseballTeamGames funnel through.
function assertNoContradictorySideMetadata(capturedGame, rowKind, rows) {
  const ownByVenue = new Map(); // normalized TeamSide -> own boolean seen there
  rows.forEach((row, index) => {
    const venue = String(row?.TeamSide ?? row?.teamSide ?? '').trim().toLowerCase();
    if (!venue || typeof row?.own !== 'boolean') return; // unresolvable venue can't be checked; requireExplicitOwnBoolean already covers missing `own`
    const existing = ownByVenue.get(venue);
    if (existing === undefined) {
      ownByVenue.set(venue, row.own);
      return;
    }
    if (existing !== row.own) {
      throw new Error(`baseball-engine: contradictory side metadata in ${rowKind}[${index}] -- this game already has a row with TeamSide "${venue}" and own:${existing}, but this row has TeamSide "${venue}" and own:${row.own}. A single venue side cannot be both own and opponent within one game.`);
    }
  });
}

function toReconstructionInput(capturedGame) {
  const batting = capturedGame?.boxScore?.batting || [];
  const pitching = capturedGame?.boxScore?.pitching || [];
  assertNoContradictorySideMetadata(capturedGame, 'boxScore.batting', batting);
  assertNoContradictorySideMetadata(capturedGame, 'boxScore.pitching', pitching);
  return {
    ...capturedGame,
    boxScore: {
      ...capturedGame?.boxScore,
      batting: batting.map((row, i) => toReconstructionRow(row, 'boxScore.batting', i)),
      pitching: pitching.map((row, i) => toReconstructionRow(row, 'boxScore.pitching', i)),
    },
  };
}

// Renames reconstructGame's scouted/opponent output vocabulary to this
// module's own/opponent vocabulary. A pure rename -- no numeric value is
// recomputed or altered.
function toEngineGameResult(legacyResult) {
  const { scouted, scoutedSide, opponent, opponentSide, ...rest } = legacyResult;
  return {
    ...rest,
    ownSide: scoutedSide,
    opponentSide,
    own: scouted,
    opponent,
  };
}

// ─── Public reconstruction orchestration ───────────────────────────────────

/**
 * Reconstructs one game's own/opponent batting + pitching totals from play-
 * by-play and validates them against the box score through the authoritative
 * reconstruction core after an explicit own/opponent boundary translation.
 *
 * @param {object} capturedGame - { meta, boxScore: { batting[], pitching[] }, plays[] }.
 *   Every boxScore.batting/pitching row must carry an explicit `own` boolean.
 * @returns {object} Same shape as reconstructGame()'s return value, with
 *   `scouted`/`scoutedSide` renamed to `own`/`ownSide`. `opponent`/
 *   `opponentSide` are unchanged (the legacy names for those were never
 *   ambiguous).
 */
function reconstructBaseballGame(capturedGame) {
  const legacyResult = reconstructGame(toReconstructionInput(capturedGame));
  return toEngineGameResult(legacyResult);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function meaningfulIdentityPart(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized || ['unknown', '__pending__', 'tbd', 'n/a'].includes(normalized.toLowerCase())) return null;
  return normalized;
}

function firstMeaningfulIdentityPart(...values) {
  for (const value of values) {
    const normalized = meaningfulIdentityPart(value);
    if (normalized) return normalized;
  }
  return null;
}

function canonicalGameIdentity(game) {
  const meta = game?.meta || {};
  const durableId = firstMeaningfulIdentityPart(meta.sourceGameId, meta.gameId, game?.sourceGameId, game?.gameId);
  if (durableId) {
    return { key: `source:${stableStringify([durableId])}`, resolved: true, method: 'sourceGameId', durable: true };
  }
  const date = firstMeaningfulIdentityPart(meta.gameDate, meta.date, game?.gameDate, game?.date);
  const home = firstMeaningfulIdentityPart(meta.homeTeamId, meta.homeTeam, meta.homeTeamName)?.toLowerCase();
  const away = firstMeaningfulIdentityPart(meta.awayTeamId, meta.awayTeam, meta.awayTeamName)?.toLowerCase();
  const discriminator = firstMeaningfulIdentityPart(meta.scheduledStart, meta.startTime, meta.gameNumber, meta.doubleheaderGame)?.toLowerCase();
  if (date && home && away && discriminator) {
    return { key: `fallback:${stableStringify([date, home, away, discriminator])}`, resolved: true, method: 'scheduleComposite', durable: false };
  }
  return {
    key: null,
    resolved: false,
    method: 'unresolvedScoped',
    durable: false,
    fingerprint: stableStringify(game),
    reason: 'no durable source ID or sufficiently discriminating schedule composite',
  };
}

function snapshotScore(game) {
  const box = game?.boxScore || {};
  const rows = ['batting', 'pitching', 'awayBatting', 'homeBatting', 'awayPitching', 'homePitching']
    .reduce((sum, key) => sum + (Array.isArray(box[key]) ? box[key].length : 0), 0);
  const plays = Array.isArray(game?.plays) ? game.plays.length : Array.isArray(game?.plays?.events) ? game.plays.events.length : 0;
  const complete = game?.meta?.status === 'final' || game?.meta?.complete === true ? 1000000 : 0;
  return complete + rows * 1000 + plays;
}

function isFinalSnapshot(game) {
  return String(game?.meta?.status || '').trim().toLowerCase() === 'final' || game?.meta?.complete === true;
}

function snapshotFacts(game) {
  const meta = game?.meta || {};
  const fact = (...values) => firstMeaningfulIdentityPart(...values);
  const ownership = {};
  for (const kind of ['batting', 'pitching', 'awayBatting', 'homeBatting', 'awayPitching', 'homePitching']) {
    for (const row of game?.boxScore?.[kind] || []) {
      const side = fact(row?.TeamSide ?? row?.teamSide);
      if (side && typeof row?.own === 'boolean') ownership[side.toLowerCase()] = row.own;
    }
  }
  return {
    homeTeam: fact(meta.homeTeamId, meta.homeTeam, meta.homeTeamName)?.toLowerCase() ?? null,
    awayTeam: fact(meta.awayTeamId, meta.awayTeam, meta.awayTeamName)?.toLowerCase() ?? null,
    ownership,
    scoreUs: fact(meta.scoreUs, meta.score_us),
    scoreThem: fact(meta.scoreThem, meta.score_them),
    homeScore: fact(meta.homeScore, meta.home_score),
    awayScore: fact(meta.awayScore, meta.away_score),
  };
}

function materialSnapshotConflicts(candidates) {
  const conflicts = new Set();
  const facts = candidates.map(({ game }) => ({ final: isFinalSnapshot(game), facts: snapshotFacts(game) }));
  const compare = (field, onlyFinal = false) => {
    const values = new Set(facts.filter((entry) => !onlyFinal || entry.final).map((entry) => entry.facts[field]).filter((value) => value !== null));
    if (values.size > 1) conflicts.add(field);
  };
  compare('homeTeam');
  compare('awayTeam');
  compare('scoreUs', true);
  compare('scoreThem', true);
  compare('homeScore', true);
  compare('awayScore', true);
  const ownershipSides = new Set(facts.flatMap((entry) => Object.keys(entry.facts.ownership)));
  for (const side of ownershipSides) {
    const values = new Set(facts
      .map((entry) => entry.facts.ownership[side])
      .filter((value) => typeof value === 'boolean'));
    if (values.size > 1) conflicts.add(`ownership.${side}`);
  }
  return [...conflicts].sort();
}

function reconcileGameCollection(games) {
  const resolvedBuckets = new Map();
  const unresolved = [];
  for (const game of games) {
    const identity = canonicalGameIdentity(game);
    const candidate = { game, identity, score: snapshotScore(game), serial: stableStringify(game) };
    if (!identity.resolved) {
      unresolved.push(candidate);
      continue;
    }
    if (!resolvedBuckets.has(identity.key)) resolvedBuckets.set(identity.key, []);
    resolvedBuckets.get(identity.key).push(candidate);
  }

  const reconciled = [];
  for (const [key, candidates] of resolvedBuckets) {
    candidates.sort((a, b) => b.score - a.score || a.serial.localeCompare(b.serial));
    const selected = candidates[0];
    const uniqueFingerprints = [...new Set(candidates.map((candidate) => candidate.serial))];
    const conflictFields = materialSnapshotConflicts(candidates);
    const status = conflictFields.length ? 'conflict'
      : uniqueFingerprints.length === 1 ? (candidates.length > 1 ? 'deduplicated' : 'single')
        : 'reconciled';
    reconciled.push({
      game: selected.game,
      identity: {
        ...selected.identity,
        reconciliation: {
          status,
          candidateCount: candidates.length,
          conflictFields,
          candidateFingerprints: uniqueFingerprints.sort(),
          selectedFingerprint: selected.serial,
        },
      },
    });
  }

  unresolved.sort((a, b) => a.serial.localeCompare(b.serial));
  const ordinalByFingerprint = new Map();
  for (const candidate of unresolved) {
    const ordinal = (ordinalByFingerprint.get(candidate.serial) || 0) + 1;
    ordinalByFingerprint.set(candidate.serial, ordinal);
    const key = `unresolved:${stableStringify([candidate.serial, ordinal])}`;
    reconciled.push({
      game: candidate.game,
      identity: {
        ...candidate.identity,
        key,
        scopeOrdinal: ordinal,
        reconciliation: {
          status: 'unresolved',
          candidateCount: 1,
          conflictFields: [],
          candidateFingerprints: [candidate.serial],
          selectedFingerprint: candidate.serial,
          automaticDeduplication: false,
        },
      },
    });
  }

  return reconciled.sort((a, b) => a.identity.key.localeCompare(b.identity.key));
}

/**
 * Reconstructs and aggregates own/opponent totals across many games for one
 * team through the authoritative reconstruction core after collection
 * reconciliation and explicit own/opponent boundary translation.
 *
 * @param {string} teamId
 * @param {object[]} capturedGames
 * @returns {{ summary: object, gameResults: object[] }} `gameResults` uses
 *   this module's own/opponent vocabulary (see toEngineGameResult above).
 *   `summary` is passed through from reconstructTeamGames() unchanged
 *   (its own/opponent framing was already unambiguous: it reports on
 *   whichever games were handed to it, aggregated from each game's already-
 *   translated `scouted` bucket).
 */
function reconstructBaseballTeamGames(teamId, capturedGames = []) {
  if (!Array.isArray(capturedGames)) {
    throw new Error('baseball-engine: capturedGames must be an array');
  }
  const reconciled = reconcileGameCollection(capturedGames);
  const translatedGames = reconciled.map(({ game }) => toReconstructionInput(game));
  const { summary, gameResults } = reconstructTeamGames(teamId, translatedGames);
  return {
    summary,
    gameResults: gameResults.map((result, index) => ({ ...toEngineGameResult(result), identity: reconciled[index].identity })),
  };
}

// ─── Public statistics orchestration ──────────────────────────────────────

// stats-core.js's processGames() reads isOurTeam directly and
// non-inverted (own:true means isOurTeam:true, confirmed empirically in
// test/legacy-stats-engine-characterization.test.js) -- so this translation
// is a straight rename, not an inversion. It still REQUIRES the explicit
// `own` boolean rather than accepting the compatibility mode's silent
// roster-fallback (own-batter-unknown -> track all; own-pitcher-unknown ->
// treat as opponent), which this module's callers must not inherit
// unknowingly.
function toStatsEngineRow(row, rowKind, index) {
  const own = requireExplicitOwnBoolean(row, rowKind, index);
  const { own: _own, isOurTeam: _legacyIsOurTeam, ...rest } = row;
  return { ...rest, isOurTeam: own };
}

function toStatsEngineGame(capturedGame) {
  const box = capturedGame?.boxScore || {};
  const mapSide = (rows, rowKind) => (Array.isArray(rows) ? rows.map((row, i) => toStatsEngineRow(row, rowKind, i)) : rows);
  return {
    ...capturedGame,
    boxScore: {
      ...box,
      batting: mapSide(box.batting, 'boxScore.batting'),
      pitching: mapSide(box.pitching, 'boxScore.pitching'),
      awayBatting: mapSide(box.awayBatting, 'boxScore.awayBatting'),
      homeBatting: mapSide(box.homeBatting, 'boxScore.homeBatting'),
      awayPitching: mapSide(box.awayPitching, 'boxScore.awayPitching'),
      homePitching: mapSide(box.homePitching, 'boxScore.homePitching'),
    },
  };
}

/**
 * Computes advanced player statistics through the authoritative stats core.
 * Durable player IDs control accumulation whenever available; unresolved
 * identities remain separate and carry explicit context.
 *
 * @param {object[]} capturedGames - Games whose box-score rows carry an
 *   explicit own boolean and may carry a durable playerId.
 * @returns {object} Own/opponent batter and pitcher maps, unresolved maps,
 *   game reconciliation provenance, and unattributed error counts.
 */
function computeBaseballStats(capturedGames = []) {
  if (!Array.isArray(capturedGames)) {
    throw new Error('baseball-engine: capturedGames must be an array');
  }
  const reconciled = reconcileGameCollection(capturedGames);
  const translatedGames = reconciled.map(({ game, identity }) => toStatsEngineGame({
    ...game,
    meta: { ...(game?.meta || {}), engineGameIdentity: identity },
  }));
  const legacyResult = processGames(translatedGames);
  return {
    ownBatters: legacyResult.players,
    opponentBatters: legacyResult.opponentBatters,
    ownPitchers: legacyResult.ourPitchers,
    opponentPitchers: legacyResult.pitchers,
    unresolvedBatters: legacyResult.unresolvedBatters,
    unresolvedPitchers: legacyResult.unresolvedPitchers,
    gameIdentities: reconciled.map(({ identity }) => identity),
    unattributedErrors: {
      ownSide: legacyResult.unattributedErrors.ourSide,
      opponentSide: legacyResult.unattributedErrors.opponentSide,
    },
  };
}

// ─── Public normalization orchestration ───────────────────────────────────

/**
 * Converts raw GameChanger-scraped JSON into normalized batting/pitching/
 * play rows through the authoritative normalization core,
 * requiring `ownSide` as an explicit argument (never read from
 * `rawJson.meta.ourSide` implicitly) so the caller's own/opponent intent is
 * always visible at this module's boundary, and adds an explicit `own`
 * boolean on each returned row, replacing the core compatibility `isOurTeam`
 * 1/0/null field entirely -- `own` is this module's sole public ownership
 * field across all four operations; normalizer.js's legacy field name is
 * never exposed, for the same reason reconstructBaseballGame/
 * computeBaseballStats never expose `is_our_team`/`isOurTeam` either (see
 * test/baseball-engine-explicit-side-contract.test.js).
 *
 * The legacy normalizer's isOurTeam semantics were empirically confirmed
 * (test/legacy-normalizer-own-opponent-characterization.test.js) to already
 * be non-inverted (isOurTeam:1 means "matches ownSide"), unlike
 * reconstruct-core's compatibility contract -- this function exists for contract consistency and
 * to make `ownSide` mandatory and explicit, not to fix an inversion bug.
 *
 * @param {object} rawJson - Raw scraped JSON ({ meta, boxScore, plays }).
 * @param {string} teamId
 * @param {'home'|'away'} ownSide - Which venue side is the caller's own
 *   team for this specific game. Required; never defaulted or guessed.
 * @param {{ invertOwnership?: boolean, referenceYear?: number, capturedAt?: string }} [options]
 * @returns {{ game: object, battingLines: object[], pitchingLines: object[], playEvents: object[] }}
 */
function normalizeBaseballGame(rawJson, teamId, ownSide, options = {}) {
  if (ownSide !== 'home' && ownSide !== 'away') {
    throw new Error('baseball-engine: ownSide is required and must be exactly "home" or "away"');
  }
  if (!rawJson || typeof rawJson !== 'object') {
    throw new Error('baseball-engine: rawJson must be an object');
  }
  const rawJsonWithExplicitSide = {
    ...rawJson,
    meta: { ...(rawJson.meta || {}), ourSide: ownSide },
  };
  const result = normalizeGameData(rawJsonWithExplicitSide, teamId, {
    invertTeamSide: options.invertOwnership === true,
    referenceYear: options.referenceYear,
    capturedAt: options.capturedAt,
  });
  // Replaces normalizer.js's legacy isOurTeam field with this module's own
  // `own` boolean -- own is the ONLY public ownership field this module
  // ever returns, on any of its four operations.
  const addOwn = (row) => {
    const { isOurTeam, ...rest } = row;
    return { ...rest, own: isOurTeam === 1 ? true : isOurTeam === 0 ? false : null };
  };
  // capturedAt is caller-supplied audit metadata, not an engine result.
  // The core never creates it from the wall clock and this public contract
  // deliberately omits it even when a caller supplied one.
  const { capturedAt: _capturedAt, ...gameWithoutCapturedAt } = result.game;
  return {
    game: gameWithoutCapturedAt,
    battingLines: result.battingLines.map(addOwn),
    pitchingLines: result.pitchingLines.map(addOwn),
    playEvents: result.playEvents,
  };
}

module.exports = {
  reconstructBaseballGame,
  reconstructBaseballTeamGames,
  computeBaseballStats,
  normalizeBaseballGame,
  // Exposed for the dependency-boundary/unit tests only -- not part of the
  // stable public contract other modules should depend on.
  _internals: { toReconstructionInput, toStatsEngineGame, requireExplicitOwnBoolean, canonicalGameIdentity, reconcileGameCollection, stableStringify },
};
