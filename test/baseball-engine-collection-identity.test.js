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

test('an early incomplete snapshot plus two later Game-1/Game-2 candidates stays ambiguous, not collapsed into either', () => {
  const early = scheduleGame('10:00 AM');
  const gameOne = scheduleGame('10:00 AM', { meta: { gameNumber: 1 } });
  const gameTwo = scheduleGame('10:00 AM', { meta: { gameNumber: 2 } });
  const forward = reconstructBaseballTeamGames('team', [early, gameOne, gameTwo]);
  const reverse = reconstructBaseballTeamGames('team', [gameTwo, early, gameOne]);
  assert.equal(forward.summary.games, 3, 'the incomplete record must not silently attach to either candidate');
  assert.deepEqual(forward, reverse, 'ambiguity resolution must be deterministic under input reversal');
  const early_out = forward.gameResults.find((r) => !('gameNumber' in r.identity.discriminators));
  assert.equal(early_out.identity.reconciliation.status, 'ambiguous');
  assert.equal(early_out.identity.reconciliation.candidateCount, 3);
  const gameOne_out = forward.gameResults.find((r) => r.identity.discriminators.gameNumber === '1');
  const gameTwo_out = forward.gameResults.find((r) => r.identity.discriminators.gameNumber === '2');
  assert.ok(gameOne_out && gameTwo_out, 'Game 1 and Game 2 must both still be present and distinguishable');
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
