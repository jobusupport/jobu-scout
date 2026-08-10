'use strict';

/**
 * baseball-engine.js — High School Slice 2B: pure baseball-domain engine.
 *
 * ── What this is ─────────────────────────────────────────────────────────
 * A pure, dependency-free wrapper around the three existing legacy
 * baseball-domain modules:
 *   - ../normalizer.js        (normalizeGameData)
 *   - ../game-reconstructor.js (reconstructGame, reconstructTeamGames)
 *   - ../stats-engine.js      (processGames)
 *
 * None of those three files are modified by this module. Each is already
 * pure (no DB, network, filesystem, or UI dependency was found anywhere in
 * them — confirmed by grep and by the dependency-boundary test alongside
 * this file). This module does not reimplement their parsing/statistical
 * logic; it only translates at the boundary between an explicit, safe
 * public contract and each legacy function's own input/output shape.
 *
 * ── Why this module exists ──────────────────────────────────────────────
 * game-reconstructor.js's internal bucketing is driven by
 * `isScoutedRow(row)`, which is true when `row.is_our_team === false` — the
 * OPPOSITE of the naive reading of that field name. A caller who (naturally)
 * writes `isOurTeam: true` on their own team's rows finds those rows land in
 * `result.opponent`, not `result.scouted`. This is not hypothetical: it is
 * empirically reproduced in
 * test/legacy-engine-characterization.test.js ("OWNERSHIP INVERSION
 * HAZARD"). stats-engine.js's processGames() has a related but different
 * hazard: when no own-side roster can be determined, batters default to
 * "own" but pitchers default to "opponent" — an undocumented asymmetry
 * (also characterized in
 * test/legacy-stats-engine-characterization.test.js).
 *
 * src/high-school-import-service.js already solved exactly this problem for
 * its own domain, ad hoc, via `isHighSchoolTeam` +
 * `invertRowOwnershipForReconstruction()`. This module generalizes that same
 * pattern — translate an explicit boolean at ONE tested boundary point,
 * never let legacy ambiguity leak past it — into a reusable, product-agnostic
 * form so future callers (Travel or High School) don't each have to
 * reinvent it.
 *
 * ── Public contract ──────────────────────────────────────────────────────
 * Every batting/pitching row passed into this module's functions MUST carry
 * an explicit `own` boolean: `true` if the row belongs to the side the
 * caller considers their own team, `false` if it belongs to the opponent.
 * A row with no `own` field, or a non-boolean `own` value, is REJECTED
 * (thrown, not defaulted) — this module never guesses ownership the way the
 * wrapped legacy fallbacks sometimes do.
 *
 * `own`/`opponent` (team identity) is fully independent of home/away
 * (venue). A team can be `own:true` and `home`, `own:true` and `away`,
 * etc. — this module never infers one from the other. Home/away continues
 * to flow through unchanged as each row's existing `TeamSide`/`teamSide`
 * field.
 *
 * All returned result objects use the vocabulary `own`/`opponent`
 * (`ownSide`, `own: {...}`, `opponentSide`, `opponent: {...}`,
 * `ownBatters`, `opponentBatters`, `ownPitchers`, `opponentPitchers`) —
 * never the legacy `scouted`/`isOurTeam` naming, so no ambiguity can leak
 * past this module's boundary in either direction.
 *
 * ── Determinism / purity ────────────────────────────────────────────────
 * No network, database, filesystem, environment-variable, or global-mutable
 * state is read or written anywhere in this module (see
 * test/baseball-engine-dependency-boundary.test.js, which greps this file's
 * own source and its require graph to prove it). Inputs are never mutated
 * (each row is shallow-copied before its `own` field is translated). Given
 * the same input, output is byte-for-byte identical across repeated calls,
 * with one narrow, explicitly documented exception inherited unchanged from
 * normalizer.js: `normalizeBaseballGame`'s returned `game.capturedAt` field
 * is a live wall-clock timestamp (an audit field, not a statistic) — see
 * that legacy file's own normalizeGameMeta().
 *
 * ── Errors ───────────────────────────────────────────────────────────────
 * Thrown errors are plain `Error` instances with a short, non-sensitive
 * message (row index and missing-field name only — never player names, team
 * names, or full row contents), so they are safe to surface to logs.
 *
 * ── Explicitly out of scope for this module (deferred to a future slice) ──
 * No integration with the High School persistence schema or its import
 * tables. No database, network, or AI/report-generation code. No change to
 * pipeline.js or any other existing caller — this module is additive only.
 */

const { reconstructGame, reconstructTeamGames } = require('../game-reconstructor');
const { normalizeGameData } = require('../normalizer');
const { processGames } = require('../stats-engine');

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

// Translates one explicit-`own` row into game-reconstructor.js's expected
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

function toReconstructionInput(capturedGame) {
  const batting = capturedGame?.boxScore?.batting || [];
  const pitching = capturedGame?.boxScore?.pitching || [];
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

// ─── Public: game-reconstructor.js wrapper ─────────────────────────────────

/**
 * Reconstructs one game's own/opponent batting + pitching totals from play-
 * by-play and validates them against the box score. Pure pass-through to
 * game-reconstructor.js's reconstructGame() after an explicit own/opponent
 * boundary translation.
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

/**
 * Reconstructs and aggregates own/opponent totals across many games for one
 * team. Pure pass-through to game-reconstructor.js's reconstructTeamGames()
 * after the same explicit own/opponent boundary translation.
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
  const translatedGames = capturedGames.map((game) => toReconstructionInput(game));
  const { summary, gameResults } = reconstructTeamGames(teamId, translatedGames);
  return {
    summary,
    gameResults: gameResults.map(toEngineGameResult),
  };
}

// ─── Public: stats-engine.js wrapper ───────────────────────────────────────

// stats-engine.js's processGames() reads isOurTeam directly and
// non-inverted (own:true means isOurTeam:true, confirmed empirically in
// test/legacy-stats-engine-characterization.test.js) -- so this translation
// is a straight rename, not an inversion. It still REQUIRES the explicit
// `own` boolean rather than accepting stats-engine.js's own silent
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
 * Computes advanced per-player/per-pitcher statistics from play-by-play
 * text across many games. Pure pass-through to stats-engine.js's
 * processGames() after an explicit own/opponent boundary translation.
 *
 * @param {object[]} capturedGames - Each game's boxScore rows (whichever of
 *   the combined `batting`/`pitching` or split `awayBatting`/`homeBatting`/
 *   `awayPitching`/`homePitching` shapes is present) must carry an explicit
 *   `own` boolean per row.
 * @returns {{ ownBatters: object, opponentBatters: object, ownPitchers: object, opponentPitchers: object, unattributedErrors: { ownSide: number, opponentSide: number } }}
 */
function computeBaseballStats(capturedGames = []) {
  if (!Array.isArray(capturedGames)) {
    throw new Error('baseball-engine: capturedGames must be an array');
  }
  const translatedGames = capturedGames.map(toStatsEngineGame);
  const legacyResult = processGames(translatedGames);
  return {
    ownBatters: legacyResult.players,
    opponentBatters: legacyResult.opponentBatters,
    ownPitchers: legacyResult.ourPitchers,
    opponentPitchers: legacyResult.pitchers,
    unattributedErrors: {
      ownSide: legacyResult.unattributedErrors.ourSide,
      opponentSide: legacyResult.unattributedErrors.opponentSide,
    },
  };
}

// ─── Public: normalizer.js wrapper ─────────────────────────────────────────

/**
 * Converts raw GameChanger-scraped JSON into normalized batting/pitching/
 * play rows. Pure pass-through to normalizer.js's normalizeGameData(),
 * requiring `ownSide` as an explicit argument (never read from
 * `rawJson.meta.ourSide` implicitly) so the caller's own/opponent intent is
 * always visible at this module's boundary, and adds an explicit `own`
 * boolean alongside each returned row (normalizer.js's own `isOurTeam`
 * 1/0/null field is left in place, unchanged, for callers that already
 * depend on it).
 *
 * normalizer.js's own isOurTeam semantics were empirically confirmed
 * (test/legacy-normalizer-own-opponent-characterization.test.js) to already
 * be non-inverted (isOurTeam:1 means "matches ownSide"), unlike
 * game-reconstructor.js -- this wrapper exists for contract consistency and
 * to make `ownSide` mandatory and explicit, not to fix an inversion bug.
 *
 * @param {object} rawJson - Raw scraped JSON ({ meta, boxScore, plays }).
 * @param {string} teamId
 * @param {'home'|'away'} ownSide - Which venue side is the caller's own
 *   team for this specific game. Required; never defaulted or guessed.
 * @param {{ invertOwnership?: boolean }} [options]
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
  const result = normalizeGameData(rawJsonWithExplicitSide, teamId, { invertTeamSide: options.invertOwnership === true });
  const addOwn = (row) => ({ ...row, own: row.isOurTeam === 1 ? true : row.isOurTeam === 0 ? false : null });
  return {
    game: result.game,
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
  _internals: { toReconstructionInput, toStatsEngineGame, requireExplicitOwnBoolean },
};
