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
 * ── Architecture: this is a boundary-translation wrapper, not an extracted
 *    computational core — stated plainly, not left to be inferred ────────
 * Every function in this file is one of exactly three things: (1) a rename
 * of a field or bucket name (e.g. legacy `scouted` -> `own`), (2) an
 * inversion of one boolean at one tested point (`own` -> `is_our_team`),
 * or (3) an added VALIDATION/GUARD (explicit-own enforcement,
 * contradictory-side-metadata rejection, duplicate-identity rejection,
 * capturedAt isolation) that runs before or after an unmodified call into
 * a legacy function. Zero event-type classification, zero play-by-play
 * text parsing, zero box-score totaling, zero rate-stat formulas (BA/OBP/
 * SLG/OPS/K%/etc.), and zero roster alias-matching logic live in this
 * file — all of that remains, unchanged and unduplicated, exclusively in
 * normalizer.js / game-reconstructor.js / stats-engine.js, which stay the
 * sole authoritative implementation of every baseball calculation this
 * module exposes. Because this module never reimplements a formula, there
 * is no second copy of any calculation to drift out of sync with the
 * legacy one — a change to a legacy formula changes this module's output
 * identically and automatically, with no parallel code to keep in sync.
 * Leaving the three legacy files unmodified is the appropriate choice
 * here specifically because the defect this slice fixes (ambiguous
 * ownership semantics at the CALLER boundary) was never a calculation
 * defect — every characterized formula was already correct — so the
 * narrowest fix that fully addresses it is a boundary translation, not a
 * rewrite of validated statistical code that Travel production
 * (pipeline.js, src/validate-team-stats.js) also depends on unchanged.
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
 * the same input, EVERY value returned by every function in this module's
 * public contract is deeply, unconditionally identical across repeated
 * calls — proven by an explicit full-object deep-equality test per public
 * operation in test/baseball-engine.test.js (not merely "the suite passed
 * twice").
 *
 * normalizer.js's own normalizeGameMeta() stamps a `capturedAt` field with
 * `meta.capturedAt || new Date().toISOString()` — a live wall-clock read
 * whenever the caller doesn't supply one, which would otherwise be the one
 * non-deterministic value in this module's output. `normalizeBaseballGame`
 * deliberately strips that field from its returned `game` object before
 * returning (see the comment at that call site) rather than exposing it —
 * it is DB-audit metadata, not a value this pure engine computes, so it is
 * isolated outside the engine's contract entirely instead of being
 * "documented as an exception" to a determinism guarantee that must
 * otherwise hold without exception.
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

// Contradictory-metadata guard: game-reconstructor.js's own scoutedSide/
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

// ── Durable-identity guard ──────────────────────────────────────────────
//
// stats-engine.js's processGames() keys every player's accumulated
// statistics by RESOLVED DISPLAY NAME STRING (`players[pa.batter]`, etc.)
// -- there is no durable-ID concept anywhere in that file, and this is
// inherited unchanged, not fixed, since play-by-play text itself carries
// no ID, only a name (see test/legacy-stats-engine-characterization.test.js
// for the underlying legacy behavior this rests on). Empirically: two
// DIFFERENT real players who happen to share one display name on one
// side, in one game or across games, are silently merged into a single
// accumulator entry by the wrapped legacy engine -- their plate
// appearances, hits, etc. are combined as if they were one person.
//
// This guard cannot fix that merge (the play-by-play text this engine
// receives has no way to say which of two identically-named players a
// given play belongs to -- that information does not exist in the source
// data at all). What it CAN safely do, and does, is refuse to silently
// accept input where the hazard is provable: if a caller supplies an
// optional `playerId` per row and two DIFFERENT non-null playerIds share
// one display name on the same side (own/opponent, batting/pitching),
// that is definitive proof of two different real people -- this function
// throws rather than let stats-engine.js merge them. If no playerId is
// supplied at all, the collision is undetectable from this data alone and
// the caller inherits the legacy limitation, documented here rather than
// silently assumed safe (see computeBaseballStats' own JSDoc "Durable
// identity" section below).
//
// When no collision is found and a name's rows all agree on one
// playerId, that ID is attached to the corresponding output entry as
// `.playerId` -- a non-breaking courtesy so callers who did supply IDs
// can key their own downstream storage by ID even though stats-engine.js's
// internal accumulator could not.
function collectSideRows(box, kind) {
  const capKind = kind.charAt(0).toUpperCase() + kind.slice(1);
  return [...(box?.[kind] || []), ...(box?.[`away${capKind}`] || []), ...(box?.[`home${capKind}`] || [])];
}

function checkDurableIdentityAndBuildIdMap(capturedGames) {
  // bucketKey -> displayName -> { playerId: string|null, firstSeen: 'games[i].boxScore.<kind>[j]' }
  const buckets = { 'true|batting': new Map(), 'false|batting': new Map(), 'true|pitching': new Map(), 'false|pitching': new Map() };

  capturedGames.forEach((game, gameIndex) => {
    const box = game?.boxScore || {};
    for (const kind of ['batting', 'pitching']) {
      // CROSS-SIDE collision check, within this one game only: unlike
      // game-reconstructor.js (which disambiguates same-named players on
      // opposing rosters via inning-derived offense/defense side --
      // proven in test/baseball-engine-game-integrity-matrix.test.js), the
      // wrapped stats-engine.js has NO side-aware play attribution at all.
      // Its own/opponent bucketing for a given play is a bare
      // `ourBatterNames.has(pa.batter)` name-set-membership check -- if the
      // same display name is a member of BOTH the own and opponent roster
      // sets for this game, every play mentioning that name is silently
      // attributed to "own", even when it was actually the opponent's
      // player (empirically confirmed directly against the unmodified
      // legacy engine in
      // test/legacy-stats-engine-characterization.test.js). This cannot be
      // fixed by an ID -- the underlying play-by-play text carries no ID,
      // and by the time processGames() has already resolved and
      // accumulated a play, the misattribution has already happened. The
      // only safe boundary action is to detect the collision up front and
      // refuse it.
      const ownNames = new Set();
      const opponentNames = new Set();
      collectSideRows(box, kind).forEach((row) => {
        if (!row || typeof row !== 'object' || typeof row.own !== 'boolean') return;
        const name = String(row.Player || row.Name || '').trim();
        if (!name) return;
        (row.own ? ownNames : opponentNames).add(name);
      });
      for (const name of ownNames) {
        if (opponentNames.has(name)) {
          throw new Error(`baseball-engine: computeBaseballStats games[${gameIndex}].boxScore.${kind} has one display name present on BOTH the own and opponent roster for this game. stats-engine.js's play-to-side attribution is a bare name-set membership check with no side-awareness (unlike game-reconstructor.js) and would silently attribute every one of that name's plays to "own", even ones that belonged to the opponent. This module rejects the input rather than risk that misattribution. Ensure display names do not collide across own and opponent rosters within one game.`);
        }
      }

      collectSideRows(box, kind).forEach((row, rowIndex) => {
        if (!row || typeof row !== 'object' || typeof row.own !== 'boolean') return;
        const name = String(row.Player || row.Name || '').trim();
        if (!name) return;
        const playerId = row.playerId != null ? String(row.playerId) : null;
        const bucket = buckets[`${row.own}|${kind}`];
        const location = `games[${gameIndex}].boxScore.${kind}[${rowIndex}]`;
        const existing = bucket.get(name);
        if (!existing) {
          bucket.set(name, { playerId, firstSeen: location });
          return;
        }
        if (existing.playerId && playerId && existing.playerId !== playerId) {
          throw new Error(`baseball-engine: computeBaseballStats found two rows with different playerId values sharing one display name on the same side (own:${row.own}, ${kind}) -- ${existing.firstSeen} and ${location}. stats-engine.js's accumulator keys players by display name and would silently merge their statistics into one entry; this module rejects the input instead, since the supplied playerIds prove they are two different real people.`);
        }
        // If exactly one of the two rows carries a playerId, adopt it (a
        // caller may only tag identity on some rows); if neither carries
        // one, the collision remains undetectable and is not rejected.
        if (!existing.playerId && playerId) existing.playerId = playerId;
      });
    }
  });

  return buckets;
}

/**
 * Computes advanced per-player/per-pitcher statistics from play-by-play
 * text across many games. Pure pass-through to stats-engine.js's
 * processGames() after an explicit own/opponent boundary translation.
 *
 * ── Durable identity ──────────────────────────────────────────────────
 * stats-engine.js's own accumulator keys players by resolved display name,
 * not by ID (see the "Durable-identity guard" comment above this
 * function). This wrapper adds one safety property on top, no more: if an
 * optional `playerId` is supplied per boxScore row and two rows on the
 * same side share a display name with two DIFFERENT playerId values, this
 * function throws rather than let the legacy accumulator silently merge
 * their statistics. When no collision is detected, a name's resolved
 * `playerId` (if every contributing row agreed on one) is attached to its
 * output entry as `.playerId`. If no playerId is ever supplied, this
 * function cannot detect or prevent a same-name collision -- that residual
 * limitation is inherited from the wrapped legacy engine and documented,
 * not hidden.
 *
 * @param {object[]} capturedGames - Each game's boxScore rows (whichever of
 *   the combined `batting`/`pitching` or split `awayBatting`/`homeBatting`/
 *   `awayPitching`/`homePitching` shapes is present) must carry an explicit
 *   `own` boolean per row, and may optionally carry a `playerId`.
 * @returns {{ ownBatters: object, opponentBatters: object, ownPitchers: object, opponentPitchers: object, unattributedErrors: { ownSide: number, opponentSide: number } }}
 */
function computeBaseballStats(capturedGames = []) {
  if (!Array.isArray(capturedGames)) {
    throw new Error('baseball-engine: capturedGames must be an array');
  }
  const idBuckets = checkDurableIdentityAndBuildIdMap(capturedGames);
  const translatedGames = capturedGames.map(toStatsEngineGame);
  const legacyResult = processGames(translatedGames);
  const attachIds = (statMap, bucketKey) => {
    const bucket = idBuckets[bucketKey];
    for (const [name, stats] of Object.entries(statMap)) {
      const known = bucket.get(name);
      if (known?.playerId) stats.playerId = known.playerId;
    }
    return statMap;
  };
  return {
    ownBatters: attachIds(legacyResult.players, 'true|batting'),
    opponentBatters: attachIds(legacyResult.opponentBatters, 'false|batting'),
    ownPitchers: attachIds(legacyResult.ourPitchers, 'true|pitching'),
    opponentPitchers: attachIds(legacyResult.pitchers, 'false|pitching'),
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
 * boolean on each returned row, replacing normalizer.js's own `isOurTeam`
 * 1/0/null field entirely -- `own` is this module's sole public ownership
 * field across all four operations; normalizer.js's legacy field name is
 * never exposed, for the same reason reconstructBaseballGame/
 * computeBaseballStats never expose `is_our_team`/`isOurTeam` either (see
 * test/baseball-engine-explicit-side-contract.test.js).
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
  // Replaces normalizer.js's legacy isOurTeam field with this module's own
  // `own` boolean -- own is the ONLY public ownership field this module
  // ever returns, on any of its four operations.
  const addOwn = (row) => {
    const { isOurTeam, ...rest } = row;
    return { ...rest, own: isOurTeam === 1 ? true : isOurTeam === 0 ? false : null };
  };
  // capturedAt is deliberately dropped: normalizer.js's normalizeGameMeta()
  // stamps it with `meta.capturedAt || new Date().toISOString()` -- a live
  // wall-clock read whenever the caller doesn't supply one. That would make
  // this function's own return value non-deterministic across two calls
  // with identical input (see the "capturedAt is dropped, not surfaced"
  // determinism test in test/baseball-engine.test.js). It is DB-audit
  // metadata, not a computed value this engine is responsible for, so it is
  // isolated out here rather than exposed on the pure engine's return
  // value. A caller that still wants it can read `result.game.capturedAt`
  // by calling normalizer.js's normalizeGameData() directly.
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
  _internals: { toReconstructionInput, toStatsEngineGame, requireExplicitOwnBoolean },
};
