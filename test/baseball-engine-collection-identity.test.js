'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconstructBaseballTeamGames,
  computeBaseballStats,
  _internals,
} = require('../src/engine/baseball-engine');

function snapshot(gameId, options = {}) {
  const {
    hits = 1,
    plays = 0,
    complete = false,
    playerId = 'p-a',
    meta = {},
    own = true,
    side = 'home',
  } = options;
  const gameMeta = {
    complete,
    gameDate: '2026-04-01',
    homeTeam: 'Synthetic Home',
    awayTeam: 'Synthetic Away',
    ...meta,
  };
  if (gameId != null) gameMeta.gameId = gameId;
  const batter = { Player: 'A Sample', own, TeamSide: side, AB: hits, H: hits };
  if (playerId != null) batter.playerId = playerId;
  return {
    meta: gameMeta,
    boxScore: { batting: [batter], pitching: [] },
    plays: Array.from({ length: plays }, (_, index) => ({
      ...(playerId == null ? {} : { batterId: playerId }),
      inning: `Bottom ${index + 1}`,
      text: 'Single. A Sample singles to left field, D Pitcher pitching.',
    })),
  };
}

function scheduleGame(startTime, options = {}) {
  return snapshot(null, { ...options, meta: { startTime, ...(options.meta || {}) } });
}

test('identical unresolved records remain two logical games and are never fingerprint-deduplicated', () => {
  const game = snapshot(null);
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 2);
  assert.equal(result.gameResults.length, 2);
  assert.deepEqual(result.gameResults.map(({ identity }) => identity.resolved), [false, false]);
  assert.deepEqual(result.gameResults.map(({ identity }) => identity.reconciliation.automaticDeduplication), [false, false]);
  assert.notEqual(result.gameResults[0].identity.key, result.gameResults[1].identity.key);
});

test('indistinguishable unresolved doubleheader games remain separate', () => {
  const first = snapshot(null, { meta: { event: 'Synthetic doubleheader' } });
  const second = structuredClone(first);
  const result = reconstructBaseballTeamGames('team', [first, second]);
  assert.equal(result.summary.games, 2);
  assert.ok(result.gameResults.every(({ identity }) => identity.method === 'unresolvedScoped'));
});

test('reordering identical unresolved inputs produces the same complete output', () => {
  const first = snapshot(null);
  const second = structuredClone(first);
  assert.deepEqual(
    reconstructBaseballTeamGames('team', [first, second]),
    reconstructBaseballTeamGames('team', [second, first]),
  );
});

test('a replay with a proven durable identity is deduplicated', () => {
  const game = snapshot('source-1', { plays: 1 });
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'deduplicated');
  assert.equal(result.gameResults[0].identity.reconciliation.candidateCount, 2);
});

test('a content fingerprint is diagnostic only and never establishes resolved identity', () => {
  const identity = _internals.canonicalGameIdentity(snapshot(null));
  assert.equal(identity.resolved, false);
  assert.equal(identity.key, null);
  assert.equal(typeof identity.fingerprint, 'string');
});

test('a compatible partial and complete snapshot reconciles without conflict', () => {
  const partial = snapshot('source-2', { hits: 1, plays: 1 });
  delete partial.meta.awayTeam;
  const complete = snapshot('source-2', { hits: 2, plays: 2, complete: true, meta: { scoreUs: 4, scoreThem: 2 } });
  complete.boxScore.batting.push({ Player: 'Opponent Sample', own: false, TeamSide: 'away', AB: 2, H: 0 });
  const result = reconstructBaseballTeamGames('team', [partial, complete]);
  assert.equal(result.summary.officialBatting.h, 2);
  assert.deepEqual(result.gameResults[0].identity.reconciliation.conflictFields, []);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'reconciled');
});

test('conflicting final scores sharing a durable identity are surfaced', () => {
  const left = snapshot('source-score', { complete: true, meta: { scoreUs: 4, scoreThem: 2 } });
  const right = snapshot('source-score', { complete: true, meta: { scoreUs: 5, scoreThem: 2 } });
  const reconciliation = reconstructBaseballTeamGames('team', [left, right]).gameResults[0].identity.reconciliation;
  assert.equal(reconciliation.status, 'conflict');
  assert.deepEqual(reconciliation.conflictFields, ['scoreUs']);
  assert.equal(reconciliation.candidateFingerprints.length, 2);
});

test('conflicting team and ownership facts sharing a durable identity are surfaced', () => {
  const left = snapshot('source-team');
  const right = snapshot('source-team', { own: false, meta: { homeTeam: 'Different Home' } });
  const reconciliation = reconstructBaseballTeamGames('team', [left, right]).gameResults[0].identity.reconciliation;
  assert.equal(reconciliation.status, 'conflict');
  assert.deepEqual(reconciliation.conflictFields, ['homeTeam', 'ownership.home']);
});

test('conflict reconciliation is deterministic regardless of input order', () => {
  const left = snapshot('source-order', { complete: true, meta: { scoreUs: 4, scoreThem: 2 } });
  const right = snapshot('source-order', { complete: true, meta: { scoreUs: 5, scoreThem: 2 } });
  assert.deepEqual(
    reconstructBaseballTeamGames('team', [left, right]),
    reconstructBaseballTeamGames('team', [right, left]),
  );
});

test('blank, whitespace, and missing schedule discriminators all remain unresolved', () => {
  for (const discriminator of [undefined, '', '   ']) {
    const game = scheduleGame(discriminator);
    if (discriminator === undefined) delete game.meta.startTime;
    const identity = _internals.canonicalGameIdentity(game);
    assert.equal(identity.resolved, false);
    assert.equal(identity.method, 'unresolvedScoped');
  }
});

test('blank higher-priority identity fields do not hide meaningful documented fallbacks', () => {
  const game = scheduleGame('10:00 AM', {
    meta: { sourceGameId: ' ', gameId: 'durable-fallback', scheduledStart: ' ', homeTeamId: '' },
  });
  const durable = _internals.canonicalGameIdentity(game);
  assert.equal(durable.method, 'sourceGameId');
  assert.equal(durable.key, 'source:["durable-fallback"]');

  delete game.meta.gameId;
  const schedule = _internals.canonicalGameIdentity(game);
  assert.equal(schedule.method, 'scheduleComposite');
  assert.equal(schedule.resolved, true);
});

test('same-date games with blank start times do not collapse', () => {
  const game = scheduleGame('   ');
  assert.equal(reconstructBaseballTeamGames('team', [game, structuredClone(game)]).summary.games, 2);
});

test('a complete normalized schedule composite resolves and separates games', () => {
  const first = scheduleGame(' 10:00 AM ');
  const second = scheduleGame('1:00 PM');
  const result = reconstructBaseballTeamGames('team', [first, structuredClone(first), second]);
  assert.equal(result.summary.games, 2);
  assert.ok(result.gameResults.every(({ identity }) => identity.resolved && identity.method === 'scheduleComposite'));
  assert.match(result.gameResults[0].identity.key, /^fallback:\{/);
});

test('fallback identity normalizes whitespace and case without changing meaning', () => {
  const first = scheduleGame(' 10:00 AM ', { meta: { homeTeam: 'SYNTHETIC   HOME' } });
  const second = scheduleGame('10:00 am', { meta: { homeTeam: 'synthetic home' } });
  assert.equal(_internals.canonicalGameIdentity(first).key, _internals.canonicalGameIdentity(second).key);
});

test('structured fallback keys cannot collide when values contain delimiters', () => {
  const left = scheduleGame('C', { meta: { homeTeam: 'A|B', awayTeam: 'D' } });
  const right = scheduleGame('C', { meta: { homeTeam: 'A', awayTeam: 'B|D' } });
  assert.notEqual(_internals.canonicalGameIdentity(left).key, _internals.canonicalGameIdentity(right).key);
});

test('schedule-composite and unresolved collection identities remain distinct in stats', () => {
  const first = scheduleGame('10:00', { plays: 1, playerId: null });
  const second = scheduleGame('13:00', { plays: 1, playerId: null });
  const resolved = computeBaseballStats([second, first]);
  assert.equal(Object.keys(resolved.unresolvedBatters).length, 2);
  assert.ok(Object.values(resolved.unresolvedBatters).every((player) => player.games === 1));
  assert.deepEqual(resolved.gameIdentities.map(({ method }) => method), ['scheduleComposite', 'scheduleComposite']);

  const ambiguousA = snapshot(null, { plays: 1, playerId: null, hits: 1 });
  const ambiguousB = snapshot(null, { plays: 1, playerId: null, hits: 2 });
  const unresolved = computeBaseballStats([ambiguousB, ambiguousA]);
  assert.equal(unresolved.gameIdentities.length, 2);
  assert.ok(unresolved.gameIdentities.every(({ method, resolved: isResolved }) => method === 'unresolvedScoped' && !isResolved));
  assert.equal(Object.keys(unresolved.unresolvedBatters).length, 2);
  assert.deepEqual(unresolved, computeBaseballStats([ambiguousA, ambiguousB]));
});

test('a durable replay counts as one statistical game and exposes durable provenance', () => {
  const game = snapshot('source-stats', { plays: 1 });
  const stats = computeBaseballStats([game, structuredClone(game)]);
  assert.equal(stats.ownBatters['p-a'].PA, 1);
  assert.equal(stats.ownBatters['p-a'].games, 1);
  assert.equal(stats.gameIdentities.length, 1);
  assert.deepEqual(
    { method: stats.gameIdentities[0].method, durable: stats.gameIdentities[0].durable },
    { method: 'sourceGameId', durable: true },
  );
});

test('identity helpers do not mutate input', () => {
  const game = snapshot('source-pure');
  const before = structuredClone(game);
  assert.equal(_internals.canonicalGameIdentity(game).key, 'source:["source-pure"]');
  _internals.reconcileGameCollection([game, structuredClone(game)]);
  assert.deepEqual(game, before);
});

test('shared start time cannot hide distinct game-number or doubleheader ordinals', () => {
  const byGameNumber = [
    scheduleGame('10:00 AM', { meta: { gameNumber: 1 } }),
    scheduleGame('10:00 AM', { meta: { gameNumber: 2 } }),
  ];
  const byDoubleheaderLabel = [
    scheduleGame('10:00 AM', { meta: { doubleheaderGame: 'Game 1' } }),
    scheduleGame('10:00 AM', { meta: { doubleheaderGame: 'Game 2' } }),
  ];
  assert.equal(reconstructBaseballTeamGames('team', byGameNumber).summary.games, 2);
  assert.equal(reconstructBaseballTeamGames('team', byDoubleheaderLabel).summary.games, 2);
});

test('schedule placeholders never establish fallback identity', () => {
  for (const placeholder of ['TBA', ' tba ', 'TBD', 'unknown', 'N/A', 'none', '-']) {
    const identity = _internals.canonicalGameIdentity(scheduleGame(placeholder));
    assert.equal(identity.resolved, false, placeholder);
    assert.equal(identity.method, 'unresolvedScoped', placeholder);
  }
});

test('supported equivalent date and time forms identify one replay', () => {
  const canonical = scheduleGame('10:00 AM');
  const equivalent = scheduleGame('10:00AM', { meta: { gameDate: '04/01/2026' } });
  assert.equal(_internals.canonicalGameIdentity(canonical).key, _internals.canonicalGameIdentity(equivalent).key);
  assert.equal(reconstructBaseballTeamGames('team', [canonical, equivalent]).summary.games, 1);
});

test('case and whitespace variants of final status beat a larger compatible partial snapshot', () => {
  for (const status of ['Final', ' FINAL ', 'final']) {
    const completed = snapshot('case-final', { hits: 2, meta: { status, scoreUs: 4, scoreThem: 2 } });
    const partial = snapshot('case-final', { hits: 1, plays: 5, meta: { status: 'in_progress' } });
    partial.boxScore.batting.push({ Player: 'Extra Partial Row', own: false, TeamSide: 'away', AB: 1, H: 1 });
    const forward = reconstructBaseballTeamGames('team', [partial, completed]);
    const reverse = reconstructBaseballTeamGames('team', [completed, partial]);
    assert.deepEqual(forward, reverse);
    assert.equal(forward.summary.officialBatting.h, 2, status);
    assert.equal(forward.gameResults[0].identity.reconciliation.status, 'reconciled');
  }
});

// ── Correction: fallback identity must survive metadata enrichment ─────────
//
// Prior defect (fixed by this correction): the fallback identity KEY used to
// embed every discriminator present in a given snapshot verbatim. Two
// snapshots of the SAME physical game -- an early scrape missing an optional
// discriminator (field/venue/event/gameNumber/...) and a later, more
// complete scrape supplying it -- therefore produced two DIFFERENT exact
// keys and were treated as two separate games instead of one reconciled
// game. Every test below fails against SHA b7becec2 for exactly this reason.
//
// The fix separates three concerns (see baseball-engine.js's
// clusterFallbackIdentities/relateDiscriminators/unionDiscriminators): (1)
// durable identity is unchanged -- exact and authoritative; (2) fallback
// EVIDENCE is the full discriminator set (start/gameNumber/doubleheaderGame/
// scheduleOrdinal/field/venue/event); (3) fallback RECONCILIATION groups
// records by proof (a shared, equal discriminator) rather than by exact key
// equality, and refuses to merge whenever more than one candidate is
// individually compatible -- so an unproven match is never arbitrarily
// attached to one of several possibilities.

test('an early snapshot without a field reconciles with a later snapshot that supplies one', () => {
  const early = scheduleGame('10:00 AM');
  const later = scheduleGame('10:00 AM', { meta: { field: 'Field 3' } });
  const result = reconstructBaseballTeamGames('team', [early, later]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'reconciled');
});

test('an early snapshot without a venue reconciles with a later snapshot that supplies one', () => {
  const early = scheduleGame('10:00 AM');
  const later = scheduleGame('10:00 AM', { meta: { venue: 'Main Complex' } });
  const result = reconstructBaseballTeamGames('team', [early, later]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'reconciled');
});

test('an early snapshot without an event reconciles with a later snapshot that supplies one', () => {
  const early = scheduleGame('10:00 AM');
  const later = scheduleGame('10:00 AM', { meta: { event: 'Spring Classic' } });
  const result = reconstructBaseballTeamGames('team', [early, later]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'reconciled');
});

test('an early snapshot without gameNumber reconciles when it has exactly one compatible candidate', () => {
  const early = scheduleGame('10:00 AM');
  const later = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const result = reconstructBaseballTeamGames('team', [early, later]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'reconciled');
});

test('an early incomplete snapshot plus two later Game-1/Game-2 candidates stays ambiguous, not collapsed into either, and is excluded from authoritative totals', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const forward = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const reverse = reconstructBaseballTeamGames('team', [gameTwo, early, gameOne]);
  // Game 1 and Game 2 directly conflict with each other (gameNumber 1 vs 2),
  // so the whole 3-member component -- early, gameOne, gameTwo -- is one
  // non-clique component: the engine cannot prove which, if any, of the two
  // candidate games "early" belongs to, so NONE of the three is safe to
  // count as an authoritative game (see finalizeAmbiguousComponent).
  assert.equal(forward.summary.games, 0, 'no member of an unproven ambiguous component may count as an authoritative game');
  assert.equal(forward.summary.ambiguousInputRecords, 3);
  assert.equal(forward.summary.ambiguousComponents, 1);
  assert.equal(forward.summary.excludedFromOfficialTotals, 3);
  assert.deepEqual(forward, reverse, 'ambiguity resolution must be deterministic under input reversal');
  // All three input records are still preserved exactly once in gameResults,
  // just tagged as excluded from official totals rather than discarded.
  assert.equal(forward.gameResults.length, 3);
  assert.ok(forward.gameResults.every((r) => r.excludedFromOfficialTotals === true));
  const early_out = forward.gameResults.find((r) => !('gameNumber' in r.identity.discriminators));
  assert.equal(early_out.identity.reconciliation.status, 'ambiguous');
  assert.equal(early_out.identity.reconciliation.candidateCount, 3);
  const gameOne_out = forward.gameResults.find((r) => r.identity.discriminators.gameNumber === '1');
  const gameTwo_out = forward.gameResults.find((r) => r.identity.discriminators.gameNumber === '2');
  assert.ok(gameOne_out && gameTwo_out, 'Game 1 and Game 2 must both still be present and distinguishable in diagnostics');
});

test('same start time with explicit Game 1 and Game 2 remains two games (doubleheader protection not weakened)', () => {
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  assert.equal(reconstructBaseballTeamGames('team', [gameOne, gameTwo]).summary.games, 2);
});

test('differing doubleheader ordinals remain separate (doubleheader protection not weakened)', () => {
  const gameOne = scheduleGame('10:00 AM', { meta: { doubleheaderGame: 'Game 1' } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { doubleheaderGame: 'Game 2' } });
  assert.equal(reconstructBaseballTeamGames('team', [gameOne, gameTwo]).summary.games, 2);
});

test('a conflicting field between two otherwise-matching snapshots surfaces conflict, never a silent merge', () => {
  const a = scheduleGame('10:00 AM', { meta: { field: 'Field 3' } });
  const b = scheduleGame('10:00 AM', { meta: { field: 'Field 4' } });
  const result = reconstructBaseballTeamGames('team', [a, b]);
  assert.equal(result.summary.games, 2, 'a real field disagreement must keep the games separate, not reconcile them');
});

test('adding optional metadata to a proven replay does not change game totals', () => {
  const early = scheduleGame('10:00 AM', { hits: 3, plays: 2 });
  const later = scheduleGame('10:00 AM', { hits: 3, plays: 2, meta: { field: 'Field 3', venue: 'Main Complex' } });
  const result = reconstructBaseballTeamGames('team', [early, later]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.summary.officialBatting.h, 3, 'enrichment must not double- or half-count the replay');
});

test('reversing input order for an enrichment pair produces semantically equivalent output', () => {
  const early = scheduleGame('10:00 AM');
  const later = scheduleGame('10:00 AM', { meta: { field: 'Field 3' } });
  const forward = reconstructBaseballTeamGames('team', [early, later]);
  const reverse = reconstructBaseballTeamGames('team', [later, early]);
  assert.deepEqual(forward, reverse);
});

test('durable-ID snapshots remain governed by durable identity, not the fallback clustering rewrite', () => {
  const early = snapshot('source-enrich', { hits: 1 });
  const later = snapshot('source-enrich', { hits: 1, meta: { field: 'Field 3' } });
  const result = reconstructBaseballTeamGames('team', [early, later]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.gameResults[0].identity.method, 'sourceGameId');
  assert.equal(result.gameResults[0].identity.durable, true);
});

test('identical unresolved games remain separate under the new clustering path too', () => {
  const game = snapshot(null);
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 2);
});

test('delimiter-bearing and special-string schedule evidence cannot collide across an enrichment merge', () => {
  const left = scheduleGame('C', { meta: { homeTeam: 'A|B', awayTeam: 'D' } });
  const right = scheduleGame('C', { meta: { homeTeam: 'A', awayTeam: 'B|D' } });
  const leftEnriched = scheduleGame('C', { meta: { homeTeam: 'A|B', awayTeam: 'D', field: 'Field __proto__' } });
  const result = reconstructBaseballTeamGames('team', [left, right, leftEnriched]);
  assert.equal(result.summary.games, 2, 'A|B/D and A/B|D must never collide even after one of them gains extra evidence');
});

test('numeric and string game-number discriminators follow the documented canonical equivalence rule', () => {
  const numeric = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const stringForm = scheduleGame('10:00 AM', { meta: { gameNumber: '1' } });
  assert.equal(_internals.canonicalGameIdentity(numeric).key, _internals.canonicalGameIdentity(stringForm).key);
  assert.equal(reconstructBaseballTeamGames('team', [numeric, stringForm]).summary.games, 1);
});

test('enrichment reconciliation does not mutate any input record', () => {
  const early = scheduleGame('10:00 AM');
  const later = scheduleGame('10:00 AM', { meta: { field: 'Field 3' } });
  const beforeEarly = structuredClone(early);
  const beforeLater = structuredClone(later);
  reconstructBaseballTeamGames('team', [early, later]);
  assert.deepEqual(early, beforeEarly);
  assert.deepEqual(later, beforeLater);
});

// ── Correction: ambiguous components must not contaminate authoritative
//    statistics, and ambiguity metadata must never leak across unrelated
//    components ─────────────────────────────────────────────────────────
//
// Prior defects (fixed by this correction), both introduced by the previous
// correction pass (SHA 0e9eff3):
//
//   (1) An ambiguous fallback component (e.g. an early incomplete snapshot
//       individually compatible with both a Game-1 and a Game-2 candidate
//       that conflict with each other) preserved every member as its own
//       separate "game" and fed ALL of them into reconstructTeamGames /
//       processGames -- so a byte-identical RE-SCRAPE of the ambiguous
//       snapshot inflated summary.games and every batting/pitching/fielding
//       total by however many times it was re-scraped. This was NOT fixed
//       by fingerprint-deduplicating the duplicates (that would silently
//       reintroduce the doubleheader-collapse defect this whole correction
//       chain exists to prevent -- content equality is not proof of logical
//       game identity). Instead, an ambiguous component's members are now
//       marked `authoritative: false` and excluded entirely from
//       summary.games / officialBatting / officialPitching / player
//       accumulation, while still being preserved -- each exactly once,
//       never fingerprint-merged -- in gameResults/gameIdentities, tagged
//       `excludedFromOfficialTotals: true`.
//   (2) `candidateCount`/`candidateFingerprints` for an ambiguous record
//       were computed from EVERY ambiguous component in the whole
//       collection pooled together, not just the specific component that
//       record belongs to -- so two entirely unrelated ambiguous situations
//       (different dates, different teams) reported each other's sibling
//       counts. Metadata is now computed strictly from each component's own
//       `members` (see finalizeAmbiguousComponent), and each record carries
//       a content-derived `componentId` so a caller can group records back
//       into their true component.

function fieldingGame(meta, { batterId = 'away-hitter', fielderId = 'own-fielder' } = {}) {
  return {
    meta: { complete: false, gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', ...meta },
    boxScore: {
      batting: [
        { Player: 'Own Batter', own: true, TeamSide: 'home', playerId: 'own-fielder', AB: 1, H: 1 },
        { Player: 'Away Hitter', own: false, TeamSide: 'away', playerId: 'away-hitter', AB: 1, H: 0 },
      ],
      pitching: [
        { Player: 'Own Pitcher', own: true, TeamSide: 'home', playerId: 'own-pitcher' },
      ],
    },
    plays: [
      { inning: 'Top 1', batterId, fielderId, text: 'Error. Away Hitter reaches on an error by shortstop, Own Pitcher pitching.' },
    ],
  };
}

test('an ambiguous component containing an exact duplicate does not inflate authoritative game totals', () => {
  const early = scheduleGame('10:00 AM');
  const earlyDup = structuredClone(early);
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early, earlyDup, gameOne, gameTwo]);
  assert.equal(result.summary.games, 0, 'no member of the unproven component may count as an authoritative game');
  assert.equal(result.summary.ambiguousInputRecords, 4, 'all 4 records -- including the duplicate -- are visible as excluded');
});

test('an ambiguous component containing an exact duplicate does not inflate batting totals', () => {
  const early = scheduleGame('10:00 AM', { hits: 1 });
  const earlyDup = structuredClone(early);
  const gameOne = scheduleGame('10:00 AM', { hits: 1, meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { hits: 1, meta: { gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early, earlyDup, gameOne, gameTwo]);
  assert.equal(result.summary.officialBatting.h, 0, 'ambiguous batting evidence must never reach official totals');
});

test('an ambiguous component containing an exact duplicate does not inflate pitching totals', () => {
  const early = fieldingGame({ startTime: '10:00 AM' });
  const earlyDup = structuredClone(early);
  const gameOne = fieldingGame({ startTime: '10:00 AM', gameNumber: 1 });
  const gameTwo = fieldingGame({ startTime: '10:00 AM', gameNumber: 2 });
  const result = reconstructBaseballTeamGames('team', [early, earlyDup, gameOne, gameTwo]);
  assert.equal(result.summary.games, 0);
  assert.equal(result.summary.officialPitching.bf, 0, 'ambiguous pitching evidence must never reach official totals');
});

test('an ambiguous component containing an exact duplicate does not inflate fielding-error totals', () => {
  const early = fieldingGame({ startTime: '10:00 AM' });
  const earlyDup = structuredClone(early);
  const gameOne = fieldingGame({ startTime: '10:00 AM', gameNumber: 1 });
  const gameTwo = fieldingGame({ startTime: '10:00 AM', gameNumber: 2 });
  const stats = computeBaseballStats([early, earlyDup, gameOne, gameTwo]);
  assert.equal(stats.ownBatters['own-fielder']?.E ?? 0, 0, 'ambiguous fielding-error evidence must never reach a player total');
  assert.deepEqual(stats.unattributedErrors, { ownSide: 0, opponentSide: 0 });
});

test('an ambiguous component containing an exact duplicate does not inflate player game counts', () => {
  const early = { meta: { complete: false, gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', startTime: '10:00 AM' }, boxScore: { batting: [{ Player: 'A Sample', own: true, TeamSide: 'home', playerId: 'p-a', AB: 1, H: 1 }], pitching: [] }, plays: [{ batterId: 'p-a', text: 'Single. A Sample singles to left field, D Pitcher pitching.' }] };
  const earlyDup = structuredClone(early);
  const gameOne = scheduleGame('10:00 AM', { plays: 1, meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { plays: 1, meta: { gameNumber: 2 } });
  const stats = computeBaseballStats([early, earlyDup, gameOne, gameTwo]);
  assert.equal(stats.ownBatters['p-a']?.games ?? 0, 0, 'an ambiguous component must not add to a player\'s games-played count');
});

test('every ambiguous input record remains represented exactly once in diagnostic output, and is never fingerprint-deduplicated', () => {
  const early = scheduleGame('10:00 AM');
  const earlyDup = structuredClone(early);
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early, earlyDup, gameOne, gameTwo]);
  assert.equal(result.gameResults.length, 4, 'all 4 input records, including the duplicate, must each appear exactly once');
  const keys = result.gameResults.map((r) => r.identity.key);
  assert.equal(new Set(keys).size, 4, 'every record must have a distinct key -- duplicates are never fingerprint-merged');
  assert.ok(result.gameResults.every((r) => r.identity.reconciliation.status === 'ambiguous'));
});

test('two legitimate indistinguishable unresolved games remain separate and are not counted as ambiguous', () => {
  const game = snapshot(null);
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 2, 'unresolved (no schedule evidence at all) is a distinct state from ambiguous, and keeps its existing authoritative-count behavior');
  assert.equal(result.summary.ambiguousInputRecords, 0);
  assert.ok(result.gameResults.every((r) => r.identity.reconciliation.status === 'unresolved'));
});

test('two legitimate indistinguishable doubleheader-flavored games remain separate and are not counted as ambiguous', () => {
  const game = snapshot(null, { meta: { event: 'Synthetic doubleheader' } });
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 2);
  assert.equal(result.summary.ambiguousInputRecords, 0);
  assert.ok(result.gameResults.every(({ identity }) => identity.method === 'unresolvedScoped'));
});

test('a proven durable-ID replay still deduplicates into one authoritative game', () => {
  const game = snapshot('source-authoritative', { plays: 1 });
  const result = reconstructBaseballTeamGames('team', [game, structuredClone(game)]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.summary.ambiguousInputRecords, 0);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'deduplicated');
  assert.equal(result.gameResults[0].excludedFromOfficialTotals, false);
});

test('a proven fallback replay (enrichment) still reconciles into one authoritative game', () => {
  const early = scheduleGame('10:00 AM');
  const later = scheduleGame('10:00 AM', { meta: { field: 'Field 3' } });
  const result = reconstructBaseballTeamGames('team', [early, later]);
  assert.equal(result.summary.games, 1);
  assert.equal(result.summary.ambiguousInputRecords, 0);
  assert.equal(result.gameResults[0].identity.reconciliation.status, 'reconciled');
  assert.equal(result.gameResults[0].excludedFromOfficialTotals, false);
});

test('ambiguous and authoritative counts are clearly distinguished in the summary', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const provenReplay = snapshot('source-mixed', { plays: 1 });
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo, provenReplay, structuredClone(provenReplay)]);
  assert.equal(result.summary.games, 1, 'only the durable proven replay counts as an authoritative game');
  assert.equal(result.summary.ambiguousInputRecords, 3);
  assert.equal(result.summary.excludedFromOfficialTotals, 3);
  assert.equal(result.gameResults.length, 4, '1 authoritative record + 3 preserved ambiguous records');
});

test('callers can determine authoritative totals are incomplete because of ambiguity', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const ambiguousResult = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  assert.ok(ambiguousResult.summary.excludedFromOfficialTotals > 0, 'a caller must be able to tell totals are incomplete');
  const cleanResult = reconstructBaseballTeamGames('team', [snapshot('source-clean')]);
  assert.equal(cleanResult.summary.excludedFromOfficialTotals, 0, 'a fully-resolved collection reports zero exclusions');
});

test('ambiguous-component reconciliation is deterministic under alternate input ordering, including metadata', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const orderings = [
    [early, gameOne, gameTwo],
    [gameTwo, gameOne, early],
    [gameOne, early, gameTwo],
    [gameTwo, early, gameOne],
  ];
  const outputs = orderings.map((order) => JSON.stringify(reconstructBaseballTeamGames('team', order)));
  assert.ok(outputs.every((output) => output === outputs[0]), 'every permutation must produce byte-identical output');
});

test('repeating the same ambiguous input additional times does not silently change authoritative totals', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const withOneCopy = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const withThreeCopies = reconstructBaseballTeamGames('team', [early, structuredClone(early), structuredClone(early), gameOne, gameTwo]);
  assert.equal(withOneCopy.summary.games, 0);
  assert.equal(withThreeCopies.summary.games, 0, 'repeating the ambiguous snapshot must not silently make it, or anything else, authoritative');
  assert.equal(withOneCopy.summary.officialBatting.h, withThreeCopies.summary.officialBatting.h, 'both must be 0 -- the repeat count is visible only in ambiguousInputRecords, never in official totals');
  assert.equal(withThreeCopies.summary.ambiguousInputRecords, 5);
});

test('removing a duplicate input does not make an ambiguous component appear resolved', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const withDuplicate = reconstructBaseballTeamGames('team', [early, structuredClone(early), gameOne, gameTwo]);
  const withoutDuplicate = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  assert.equal(withDuplicate.summary.games, 0);
  assert.equal(withoutDuplicate.summary.games, 0, 'the component remains just as unproven with or without the duplicate');
  assert.ok(withDuplicate.gameResults.every((r) => r.identity.reconciliation.status === 'ambiguous'));
  assert.ok(withoutDuplicate.gameResults.every((r) => r.identity.reconciliation.status === 'ambiguous'));
});

test('ambiguous-component exclusion does not mutate any input record', () => {
  const early = scheduleGame('10:00 AM');
  const earlyDup = structuredClone(early);
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const before = [early, earlyDup, gameOne].map((g) => structuredClone(g));
  computeBaseballStats([early, earlyDup, gameOne]);
  reconstructBaseballTeamGames('team', [early, earlyDup, gameOne]);
  assert.deepEqual([early, earlyDup, gameOne], before);
});

// ── Correction: ambiguity metadata must never leak across unrelated
//    foundational partitions or disconnected components ──────────────────

test('two unrelated ambiguous components (different dates) report only their own candidates', () => {
  const early1 = scheduleGame('10:00 AM', { meta: { gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away' } });
  const g1a = scheduleGame('10:00 AM', { meta: { gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 1 } });
  const g2a = scheduleGame('10:00 AM', { meta: { gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 2 } });
  const early2 = scheduleGame('11:00 AM', { meta: { gameDate: '2026-05-01', homeTeam: 'Home B', awayTeam: 'Away B' } });
  const g1b = scheduleGame('11:00 AM', { meta: { gameDate: '2026-05-01', homeTeam: 'Home B', awayTeam: 'Away B', gameNumber: 1 } });
  const g2b = scheduleGame('11:00 AM', { meta: { gameDate: '2026-05-01', homeTeam: 'Home B', awayTeam: 'Away B', gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early1, g1a, g2a, early2, g1b, g2b]);
  assert.equal(result.gameResults.length, 6);
  for (const { identity } of result.gameResults) {
    assert.equal(identity.reconciliation.candidateCount, 3, 'candidate count must reflect only this record\'s own 3-member component');
    assert.equal(identity.reconciliation.candidateFingerprints.length, 3);
  }
  const componentIds = new Set(result.gameResults.map(({ identity }) => identity.reconciliation.componentId));
  assert.equal(componentIds.size, 2, 'exactly 2 distinct components, one per date');
});

test('candidate counts do not include records from a different team on the same date', () => {
  const early1 = scheduleGame('10:00 AM', { meta: { homeTeam: 'Team Alpha', awayTeam: 'Team Beta' } });
  const g1a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Team Alpha', awayTeam: 'Team Beta', gameNumber: 1 } });
  const g2a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Team Alpha', awayTeam: 'Team Beta', gameNumber: 2 } });
  const early2 = scheduleGame('10:00 AM', { meta: { homeTeam: 'Team Gamma', awayTeam: 'Team Delta' } });
  const g1b = scheduleGame('10:00 AM', { meta: { homeTeam: 'Team Gamma', awayTeam: 'Team Delta', gameNumber: 1 } });
  const g2b = scheduleGame('10:00 AM', { meta: { homeTeam: 'Team Gamma', awayTeam: 'Team Delta', gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early1, g1a, g2a, early2, g1b, g2b]);
  for (const { identity } of result.gameResults) {
    assert.equal(identity.reconciliation.candidateCount, 3);
  }
  const componentIds = new Set(result.gameResults.map(({ identity }) => identity.reconciliation.componentId));
  assert.equal(componentIds.size, 2, 'same date, but different teams -- still 2 fully isolated components');
});

test('disconnected ambiguous components within ONE foundational partition remain metadata-isolated', () => {
  // Same date/home/away for all 6, but two totally disjoint discriminator
  // vocabularies (gameNumber-based vs. doubleheaderGame-based) so the two
  // triples never proof-connect to each other, forming 2 separate
  // components inside a single (date, home, away) partition.
  const earlyGN = scheduleGame(undefined, { meta: { scheduleOrdinal: 'gn-anchor' } });
  const g1 = scheduleGame(undefined, { meta: { scheduleOrdinal: 'gn-anchor', gameNumber: 1 } });
  const g2 = scheduleGame(undefined, { meta: { scheduleOrdinal: 'gn-anchor', gameNumber: 2 } });
  const earlyDH = scheduleGame(undefined, { meta: { scheduleOrdinal: 'dh-anchor' } });
  const dh1 = scheduleGame(undefined, { meta: { scheduleOrdinal: 'dh-anchor', doubleheaderGame: 'Game 1' } });
  const dh2 = scheduleGame(undefined, { meta: { scheduleOrdinal: 'dh-anchor', doubleheaderGame: 'Game 2' } });
  const result = reconstructBaseballTeamGames('team', [earlyGN, g1, g2, earlyDH, dh1, dh2]);
  assert.equal(result.gameResults.length, 6);
  for (const { identity } of result.gameResults) {
    assert.equal(identity.reconciliation.candidateCount, 3, 'each disconnected component must report only its own 3 members');
  }
  const componentIds = new Set(result.gameResults.map(({ identity }) => identity.reconciliation.componentId));
  assert.equal(componentIds.size, 2, '2 disconnected components inside 1 shared foundational partition');
});

test('a duplicate fingerprint inside a component follows the documented multiplicity rule', () => {
  const early = scheduleGame('10:00 AM');
  const earlyDup = structuredClone(early);
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early, earlyDup, gameOne, gameTwo]);
  const { candidateCount, candidateFingerprints } = result.gameResults[0].identity.reconciliation;
  assert.equal(candidateCount, 4, 'candidateCount counts records, including the duplicate');
  assert.equal(candidateFingerprints.length, 3, 'candidateFingerprints lists UNIQUE fingerprints -- multiplicity is visible only via the gap between the two counts');
});

test('candidate fingerprints are deterministically ordered regardless of input order', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const forward = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]).gameResults[0].identity.reconciliation.candidateFingerprints;
  const reverse = reconstructBaseballTeamGames('team', [gameTwo, gameOne, early]).gameResults[0].identity.reconciliation.candidateFingerprints;
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward, [...forward].sort());
});

test('global key disambiguation remains collision-safe across two unrelated ambiguous components sharing a duplicated fingerprint', () => {
  const early1 = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away' } });
  const early1Dup = structuredClone(early1);
  const g1a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 1 } });
  const g2a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 2 } });
  const early2 = scheduleGame('10:00 AM', { meta: { homeTeam: 'Home B', awayTeam: 'Away B' } });
  const early2Dup = structuredClone(early2);
  const g1b = scheduleGame('10:00 AM', { meta: { homeTeam: 'Home B', awayTeam: 'Away B', gameNumber: 1 } });
  const g2b = scheduleGame('10:00 AM', { meta: { homeTeam: 'Home B', awayTeam: 'Away B', gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early1, early1Dup, g1a, g2a, early2, early2Dup, g1b, g2b]);
  assert.equal(result.gameResults.length, 8);
  const keys = result.gameResults.map((r) => r.identity.key);
  assert.equal(new Set(keys).size, 8, 'every record across both components must have a globally unique key');
});

test('each ambiguous record references the correct component identifier', () => {
  const early = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away' } });
  const g1a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 1 } });
  const g2a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 2 } });
  const unrelated = scheduleGame('11:00 AM', { meta: { homeTeam: 'Home B', awayTeam: 'Away B' } });
  const g1b = scheduleGame('11:00 AM', { meta: { homeTeam: 'Home B', awayTeam: 'Away B', gameNumber: 1 } });
  const g2b = scheduleGame('11:00 AM', { meta: { homeTeam: 'Home B', awayTeam: 'Away B', gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early, g1a, g2a, unrelated, g1b, g2b]);
  const groupA = result.gameResults.filter((r) => r.identity.discriminators.start === '10:00');
  const groupB = result.gameResults.filter((r) => r.identity.discriminators.start === '11:00');
  const componentIdsA = new Set(groupA.map((r) => r.identity.reconciliation.componentId));
  const componentIdsB = new Set(groupB.map((r) => r.identity.reconciliation.componentId));
  assert.equal(componentIdsA.size, 1, 'all 3 records of group A share one componentId');
  assert.equal(componentIdsB.size, 1, 'all 3 records of group B share one componentId');
  assert.notEqual([...componentIdsA][0], [...componentIdsB][0], 'the two components must have different identifiers');
});

test('ambiguity-metadata scoping does not mutate any input record', () => {
  const early1 = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away' } });
  const g1a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 1 } });
  const g2a = scheduleGame('10:00 AM', { meta: { homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', gameNumber: 2 } });
  const early2 = scheduleGame('11:00 AM', { meta: { homeTeam: 'Home B', awayTeam: 'Away B' } });
  const before = [early1, g1a, g2a, early2].map((g) => structuredClone(g));
  reconstructBaseballTeamGames('team', [early1, g1a, g2a, early2]);
  assert.deepEqual([early1, g1a, g2a, early2], before);
});

// ── Correction: a malformed ambiguous record must not abort the whole
//    reconstructBaseballTeamGames() call and discard already-computed
//    authoritative results for proven games ─────────────────────────────
//
// Prior defect (fixed by this correction): reconstructBaseballTeamGames
// diagnostically reconstructs every ambiguous record for display
// (excludedFromOfficialTotals: true) via an unguarded
// reconstructBaseballGame(game) call. Because domain validation
// (requireExplicitOwnBoolean / assertNoContradictorySideMetadata) throws on
// malformed box-score data, and nothing validates box-score shape before a
// record enters reconcileGameCollection, a single malformed record that
// also happens to be schedule-ambiguous threw an exception that propagated
// out of the WHOLE function -- discarding the summary/gameResults for every
// proven, valid game in the same collection. Every test below fails against
// SHA 7abaaba for exactly this reason.
//
// Fixed with a narrow per-record error boundary (reconstructAmbiguousDiagnostic
// in baseball-engine.js): only the diagnostic reconstruction of one already-
// excluded ambiguous record is wrapped; authoritative reconstruction is never
// wrapped and still throws exactly as before for a malformed AUTHORITATIVE
// game. A failed ambiguous diagnostic is preserved (never dropped, never
// silently reported as successful, never given fabricated stats) with a
// stable `diagnosticReconstruction: { status: 'error', code, message }`
// shape that structurally cannot be confused with a real game result.

function malformedNoOwn(startTime, extraMeta = {}) {
  return {
    meta: { complete: false, gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', startTime, ...extraMeta },
    boxScore: { batting: [{ Player: 'Bad Row', TeamSide: 'home', AB: 1, H: 1 }], pitching: [] }, // no `own`
    plays: [],
  };
}
function malformedContradictorySide(startTime, extraMeta = {}) {
  return {
    meta: { complete: false, gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', startTime, ...extraMeta },
    boxScore: {
      batting: [
        { Player: 'A', own: true, TeamSide: 'home', AB: 1, H: 1 },
        { Player: 'B', own: false, TeamSide: 'home', AB: 1, H: 0 },
      ],
      pitching: [],
    },
    plays: [],
  };
}
function malformedBoxScoreStructure(startTime, extraMeta = {}) {
  return {
    meta: { complete: false, gameDate: '2026-04-01', homeTeam: 'Synthetic Home', awayTeam: 'Synthetic Away', startTime, ...extraMeta },
    boxScore: { batting: ['not-a-row-object'], pitching: [] },
    plays: [],
  };
}
function provenDurableGame(id, hits = 1) {
  return {
    meta: { gameId: id, complete: false },
    boxScore: { batting: [{ Player: 'Proven Batter', own: true, TeamSide: 'home', playerId: 'proven-id', AB: hits, H: hits }], pitching: [{ Player: 'Proven Pitcher', own: true, TeamSide: 'home', playerId: 'proven-pitcher-id', BF: 1 }] },
    plays: [{ batterId: 'proven-id', inning: 'Bottom 1', text: 'Single. Proven Batter singles to left field, Opp Pitcher pitching.' }],
  };
}
function ambiguousTriple(malformedFactory) {
  const early = malformedFactory('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  return [early, gameOne, gameTwo];
}

test('a valid authoritative game plus one malformed ambiguous record returns successfully', () => {
  const proven = provenDurableGame('source-good');
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  assert.doesNotThrow(() => reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]));
});

test('the valid authoritative game remains in summary.games', () => {
  const proven = provenDurableGame('source-good');
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  assert.equal(result.summary.games, 1);
});

test('the authoritative game batting totals remain correct', () => {
  const proven = provenDurableGame('source-good', 3);
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  assert.equal(result.summary.officialBatting.h, 3);
});

test('the authoritative game pitching totals remain correct', () => {
  const proven = provenDurableGame('source-good', 1);
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  assert.equal(result.summary.officialPitching.bf, 1);
});

test('the authoritative game fielding-relevant reconstruction totals remain correct', () => {
  const proven = provenDurableGame('source-good', 1);
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  const provenResult = result.gameResults.find((r) => r.identity.method === 'sourceGameId');
  assert.equal(provenResult.own.boxBatting.h, 1);
  assert.equal(provenResult.excludedFromOfficialTotals, false);
});

test('the authoritative game player game count remains correct via computeBaseballStats', () => {
  const proven = provenDurableGame('source-good', 1);
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const stats = computeBaseballStats([proven, early, gameOne, gameTwo]);
  assert.equal(stats.ownBatters['proven-id'].games, 1);
});

test('the malformed ambiguous record remains represented exactly once, marked excluded', () => {
  const proven = provenDurableGame('source-good');
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  const failed = result.gameResults.filter((r) => r.diagnosticReconstruction?.status === 'error');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].excludedFromOfficialTotals, true);
});

test('the failed diagnostic carries a stable error status and code', () => {
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const failed = result.gameResults.find((r) => r.diagnosticReconstruction?.status === 'error');
  assert.equal(failed.diagnosticReconstruction.status, 'error');
  assert.equal(failed.diagnosticReconstruction.code, 'AMBIGUOUS_RECONSTRUCTION_FAILED');
  assert.equal(typeof failed.diagnosticReconstruction.message, 'string');
});

test('the failed diagnostic message contains no stack trace or filesystem path', () => {
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const failed = result.gameResults.find((r) => r.diagnosticReconstruction?.status === 'error');
  const { message } = failed.diagnosticReconstruction;
  assert.ok(!/\.js:\d+:\d+/.test(message), 'must not contain a file:line:col stack frame');
  assert.ok(!/at\s+\w+.*\(/.test(message), 'must not contain a stack-frame-shaped substring');
  assert.ok(!/[A-Za-z]:\\|\/(home|Users)\//.test(message), 'must not contain an absolute filesystem path');
  assert.ok(!('stack' in failed.diagnosticReconstruction));
});

test('a missing `own` boolean produces an isolated diagnostic failure', () => {
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const failed = result.gameResults.find((r) => r.diagnosticReconstruction?.status === 'error');
  assert.match(failed.diagnosticReconstruction.message, /own.*boolean/i);
  assert.equal(result.summary.games, 0);
});

test('contradictory side metadata produces an isolated diagnostic failure', () => {
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedContradictorySide);
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const failed = result.gameResults.find((r) => r.diagnosticReconstruction?.status === 'error');
  assert.ok(failed, 'a contradictory-side-metadata ambiguous record must produce a failed diagnostic, not throw');
  assert.match(failed.diagnosticReconstruction.message, /contradictory side metadata/i);
});

test('an invalid ambiguous box-score structure produces an isolated diagnostic failure', () => {
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedBoxScoreStructure);
  assert.doesNotThrow(() => reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]));
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const failed = result.gameResults.find((r) => r.diagnosticReconstruction?.status === 'error');
  assert.ok(failed, 'an invalid box-score row shape must produce a failed diagnostic, not throw');
});

test('one malformed and one valid ambiguous diagnostic in the same component are handled independently', () => {
  const early = malformedNoOwn('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const byStatus = { ok: 0, error: 0 };
  for (const r of result.gameResults) byStatus[r.diagnosticReconstruction.status] += 1;
  assert.deepEqual(byStatus, { ok: 2, error: 1 });
});

test('multiple malformed ambiguous records each receive their own independent failure record', () => {
  const badA = malformedNoOwn('10:00 AM', { field: 'Field A' });
  const badB = malformedContradictorySide('10:00 AM', { field: 'Field B' });
  const anchor = scheduleGame('10:00 AM');
  // Both bad records and the anchor share `start`, forming one ambiguous
  // component only if they also conflict with something -- give each a
  // DIFFERENT gameNumber sibling so the whole group is a non-clique.
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [badA, badB, anchor, gameOne, gameTwo]);
  const failed = result.gameResults.filter((r) => r.diagnosticReconstruction?.status === 'error');
  assert.equal(failed.length, 2, 'both malformed records must each surface their own failure');
  assert.equal(result.summary.failedAmbiguousDiagnostics, 2);
  assert.equal(new Set(failed.map((r) => r.identity.key)).size, 2, 'each failure must have its own distinct key');
});

test('a malformed ambiguous record cannot alter authoritative totals', () => {
  const proven = provenDurableGame('source-good', 2);
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const withMalformed = reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  const withoutAmbiguous = reconstructBaseballTeamGames('team', [proven]);
  assert.equal(withMalformed.summary.games, withoutAmbiguous.summary.games);
  assert.equal(withMalformed.summary.officialBatting.h, withoutAmbiguous.summary.officialBatting.h);
});

test('reversing input order produces semantically identical output for a mix including a malformed ambiguous record', () => {
  const proven = provenDurableGame('source-good');
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const forward = reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  const reverse = reconstructBaseballTeamGames('team', [gameTwo, gameOne, early, proven]);
  assert.deepEqual(forward, reverse);
});

test('inputs remain deeply unmodified after a malformed ambiguous record is diagnosed', () => {
  const proven = provenDurableGame('source-good');
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const before = [proven, early, gameOne, gameTwo].map((g) => structuredClone(g));
  reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]);
  assert.deepEqual([proven, early, gameOne, gameTwo], before);
});

test('an authoritative (non-ambiguous) malformed game still throws -- the ambiguous error boundary must not swallow it', () => {
  const badAuthoritative = { meta: { gameId: 'source-bad' }, boxScore: { batting: [{ Player: 'Bad', TeamSide: 'home', AB: 1, H: 1 }], pitching: [] }, plays: [] }; // no `own`, but durable -> authoritative
  assert.throws(
    () => reconstructBaseballTeamGames('team', [badAuthoritative]),
    /missing the required explicit "own" boolean/,
  );
});

test('computeBaseballStats remains unaffected by the error boundary and never reconstructs ambiguous records', () => {
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  assert.doesNotThrow(() => computeBaseballStats([early, gameOne, gameTwo]));
  const stats = computeBaseballStats([early, gameOne, gameTwo]);
  assert.deepEqual(stats.ownBatters, {});
  assert.equal(stats.ambiguousInputRecords, 3);
  assert.equal(stats.officialTotalsComplete, false);
});

test('an all-ambiguous collection with one malformed diagnostic reports truthful exclusion and failure counts', () => {
  const [early, gameOne, gameTwo] = ambiguousTriple(malformedNoOwn);
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  assert.equal(result.summary.games, 0);
  assert.equal(result.summary.ambiguousInputRecords, 3);
  assert.equal(result.summary.failedAmbiguousDiagnostics, 1);
  assert.equal(result.summary.officialTotalsComplete, false);
  assert.equal(result.gameResults.length, 3);
});

test('empty input retains the documented complete/zero behavior', () => {
  const result = reconstructBaseballTeamGames('team', []);
  assert.equal(result.summary.games, 0);
  assert.equal(result.summary.ambiguousInputRecords, 0);
  assert.equal(result.summary.failedAmbiguousDiagnostics, 0);
  assert.equal(result.summary.officialTotalsComplete, true);
  assert.equal(result.gameResults.length, 0);

  const stats = computeBaseballStats([]);
  assert.equal(stats.ambiguousInputRecords, 0);
  assert.equal(stats.officialTotalsComplete, true);
});

test('officialTotalsComplete is true only when no input was excluded from official totals, across empty/authoritative-only/ambiguous-only/mixed collections', () => {
  const proven = provenDurableGame('source-complete');
  const [early, gameOne, gameTwo] = ambiguousTriple(() => scheduleGame('10:00 AM'));

  assert.equal(reconstructBaseballTeamGames('team', []).summary.officialTotalsComplete, true, 'empty');
  assert.equal(reconstructBaseballTeamGames('team', [proven]).summary.officialTotalsComplete, true, 'authoritative-only');
  assert.equal(reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]).summary.officialTotalsComplete, false, 'ambiguous-only');
  assert.equal(reconstructBaseballTeamGames('team', [proven, early, gameOne, gameTwo]).summary.officialTotalsComplete, false, 'mixed');

  assert.equal(computeBaseballStats([]).officialTotalsComplete, true, 'empty (stats)');
  assert.equal(computeBaseballStats([proven]).officialTotalsComplete, true, 'authoritative-only (stats)');
  assert.equal(computeBaseballStats([early, gameOne, gameTwo]).officialTotalsComplete, false, 'ambiguous-only (stats)');
  assert.equal(computeBaseballStats([proven, early, gameOne, gameTwo]).officialTotalsComplete, false, 'mixed (stats)');
});

test('a successful ambiguous diagnostic reconstruction does not make official totals complete', () => {
  // All 3 members of this ambiguous component are well-formed (diagnostic
  // reconstruction succeeds for every one of them) -- officialTotalsComplete
  // must still be false, because "diagnostic success" and "authoritative
  // completeness" are different questions.
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const result = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  assert.equal(result.summary.failedAmbiguousDiagnostics, 0, 'sanity check: nothing actually failed');
  assert.ok(result.gameResults.every((r) => r.diagnosticReconstruction.status === 'ok'));
  assert.equal(result.summary.officialTotalsComplete, false);
});

test('an unresolved (non-ambiguous) record follows the existing authoritative contract, unaffected by this correction', () => {
  const unresolved = { meta: { complete: false }, boxScore: { batting: [{ Player: 'Solo', own: true, TeamSide: 'home', AB: 1, H: 1 }], pitching: [] }, plays: [] };
  const result = reconstructBaseballTeamGames('team', [unresolved, structuredClone(unresolved)]);
  assert.equal(result.summary.games, 2, 'unresolved records remain authoritative, unlike ambiguous ones');
  assert.equal(result.summary.ambiguousInputRecords, 0);
  assert.equal(result.summary.officialTotalsComplete, true);
});

test('a non-Error thrown value is normalized to a safe, deterministic string', () => {
  assert.equal(_internals.normalizeThrownValue(new Error('plain error')), 'plain error');
  assert.equal(_internals.normalizeThrownValue('a plain string throw'), 'a plain string throw');
  assert.equal(
    _internals.normalizeThrownValue({ weird: 'object' }),
    'non-Error value thrown during ambiguous diagnostic reconstruction',
  );
  assert.equal(
    _internals.normalizeThrownValue(42),
    'non-Error value thrown during ambiguous diagnostic reconstruction',
  );
  assert.equal(
    _internals.normalizeThrownValue(undefined),
    'non-Error value thrown during ambiguous diagnostic reconstruction',
  );
});
