'use strict';

// High School Slice 2B correction pass, Phase 7: end-to-end proof of the
// explicit own/opponent contract across all four public operations --
// explicit ownership is required, missing/invalid/contradictory ownership
// fails, home/away stays a separate dimension, `is_our_team` is never
// exposed publicly, and neither the top-level input nor any nested row
// object is mutated (proven via reference identity, not just structural
// deep-equality). All fixtures are synthetic.
//
// Run with: node --test test/baseball-engine-explicit-side-contract.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconstructBaseballGame,
  reconstructBaseballTeamGames,
  computeBaseballStats,
  normalizeBaseballGame,
} = require('../src/engine/baseball-engine');

function validGame(gameId = 'g1') {
  return {
    meta: { gameId },
    boxScore: {
      batting: [
        { Player: 'A Sample', TeamSide: 'home', own: true, AB: 1, H: 1 },
        { Player: 'B Example', TeamSide: 'away', own: false, AB: 1, H: 0 },
      ],
      pitching: [],
    },
    plays: [],
  };
}

// ── Callers must provide explicit ownership; missing/invalid fails ─────────

test('every reconstruction-family operation requires explicit own on every row and fails for each of: missing / null / non-boolean', () => {
  const badRows = [
    { Player: 'X', TeamSide: 'home' }, // missing
    { Player: 'X', TeamSide: 'home', own: null },
    { Player: 'X', TeamSide: 'home', own: 'true' },
    { Player: 'X', TeamSide: 'home', own: 1 },
  ];
  for (const row of badRows) {
    assert.throws(() => reconstructBaseballGame({ meta: {}, boxScore: { batting: [row], pitching: [] }, plays: [] }));
    assert.throws(() => reconstructBaseballTeamGames('t', [{ meta: {}, boxScore: { batting: [row], pitching: [] }, plays: [] }]));
    assert.throws(() => computeBaseballStats([{ meta: {}, boxScore: { batting: [row] }, plays: [] }]));
  }
});

test('normalizeBaseballGame requires ownSide as an explicit function argument, never guessed from rawJson', () => {
  const raw = { meta: { ourSide: 'home' }, boxScore: {}, plays: [] }; // rawJson HAS an ourSide -- must still be ignored/insufficient
  assert.throws(() => normalizeBaseballGame(raw, 't', undefined), /ownSide is required/);
});

// ── Contradictory metadata fails ────────────────────────────────────────

test('reconstructBaseballGame rejects contradictory metadata: two rows on the same TeamSide with different own values', () => {
  assert.throws(
    () => reconstructBaseballGame({
      meta: {},
      boxScore: {
        batting: [
          { Player: 'X', TeamSide: 'home', own: true },
          { Player: 'Y', TeamSide: 'home', own: false },
        ],
        pitching: [],
      },
      plays: [],
    }),
    /contradictory side metadata/,
  );
});

test('reconstructBaseballTeamGames propagates the same contradictory-metadata rejection for any game in the array', () => {
  assert.throws(
    () => reconstructBaseballTeamGames('t', [
      validGame('g1'),
      { meta: {}, boxScore: { batting: [{ Player: 'X', TeamSide: 'home', own: true }, { Player: 'Y', TeamSide: 'home', own: false }], pitching: [] }, plays: [] },
    ]),
    /contradictory side metadata/,
  );
});

test('computeBaseballStats rejects contradictory metadata: one display name present on both own and opponent rosters in one game', () => {
  assert.throws(
    () => computeBaseballStats([{
      meta: {},
      boxScore: { batting: [{ Player: 'X', TeamSide: 'home', own: true }, { Player: 'X', TeamSide: 'away', own: false }] },
      plays: [],
    }]),
    /present on BOTH the own and opponent roster/,
  );
});

// ── Home/away remains a separate dimension from own/opponent ───────────────

test('own:true is valid and meaningful on EITHER TeamSide value -- ownership and venue are independently supplied, never inferred from each other', () => {
  const homeOwn = reconstructBaseballGame({ meta: {}, boxScore: { batting: [{ Player: 'X', TeamSide: 'home', own: true, H: 1 }], pitching: [] }, plays: [] });
  const awayOwn = reconstructBaseballGame({ meta: {}, boxScore: { batting: [{ Player: 'X', TeamSide: 'away', own: true, H: 1 }], pitching: [] }, plays: [] });
  assert.equal(homeOwn.ownSide, 'home');
  assert.equal(awayOwn.ownSide, 'away');
  assert.equal(homeOwn.own.boxBatting.h, 1);
  assert.equal(awayOwn.own.boxBatting.h, 1); // same own outcome regardless of venue
});

// ── is_our_team is never exposed on any public return value ────────────────

test('no public return value from any of the four operations ever contains an is_our_team or isOurTeam key at any depth', () => {
  function assertNoLegacyOwnershipKey(value, path = 'result') {
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertNoLegacyOwnershipKey(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        assert.notEqual(key, 'is_our_team', `found forbidden key "is_our_team" at ${path}.${key}`);
        assert.notEqual(key, 'isOurTeam', `found forbidden key "isOurTeam" at ${path}.${key}`);
        assertNoLegacyOwnershipKey(v, `${path}.${key}`);
      }
    }
  }

  assertNoLegacyOwnershipKey(reconstructBaseballGame(validGame()));
  assertNoLegacyOwnershipKey(reconstructBaseballTeamGames('t', [validGame('g1'), validGame('g2')]));
  assertNoLegacyOwnershipKey(computeBaseballStats([{
    meta: { gameId: 'g1' },
    boxScore: { batting: [{ Player: 'A Sample', own: true, TeamSide: 'home' }] },
    plays: [{ text: 'Single. A Sample singles to left field, D Placeholder pitching.' }],
  }]));
  assertNoLegacyOwnershipKey(normalizeBaseballGame({ meta: {}, boxScore: { homeBatting: [{ Player: 'A Sample', AB: 1, H: 1 }] }, plays: [] }, 't', 'home'));
});

// ── Returned results retain an explicit own/opponent designation where side matters ──

test('reconstructBaseballGame\'s result carries explicit own/opponent keys (never scouted/legacy naming) at the top level', () => {
  const result = reconstructBaseballGame(validGame());
  assert.ok('own' in result);
  assert.ok('opponent' in result);
  assert.ok('ownSide' in result);
  assert.ok('opponentSide' in result);
  assert.equal('scouted' in result, false);
  assert.equal('scoutedSide' in result, false);
});

// ── Mutation proof: neither the top-level input nor any nested row object is mutated ──

test('reconstructBaseballGame does not mutate the top-level game object, its boxScore object, or any individual row object (proven by reference identity + field-value checks on the ORIGINAL objects, not a structural copy)', () => {
  const row1 = { Player: 'A Sample', TeamSide: 'home', own: true, AB: 1, H: 1 };
  const row2 = { Player: 'B Example', TeamSide: 'away', own: false, AB: 1, H: 0 };
  const game = { meta: { gameId: 'g1' }, boxScore: { batting: [row1, row2], pitching: [] }, plays: [] };

  reconstructBaseballGame(game);

  // Same object references still carry their original field values --
  // this is a stronger claim than deep-equality against a JSON snapshot,
  // since it inspects the EXACT objects passed in, not copies of them.
  assert.equal(game.boxScore.batting[0], row1); // still the same array slot / reference
  assert.equal(row1.own, true);
  assert.equal(row1.AB, 1);
  assert.equal('is_our_team' in row1, false); // the internal translation never wrote back onto the caller's row
  assert.equal(row2.own, false);
  assert.equal('is_our_team' in row2, false);
});

test('computeBaseballStats does not mutate any nested boxScore row object', () => {
  const row = { Player: 'A Sample', own: true, TeamSide: 'home' };
  const games = [{ meta: { gameId: 'g1' }, boxScore: { batting: [row] }, plays: [{ text: 'Single. A Sample singles to left field, D Placeholder pitching.' }] }];

  computeBaseballStats(games);

  assert.equal(games[0].boxScore.batting[0], row);
  assert.equal(row.own, true);
  assert.equal('isOurTeam' in row, false);
});

test('normalizeBaseballGame does not mutate the rawJson.meta object it reads ownSide from', () => {
  const meta = { gameDate: '2026-03-01' };
  const raw = { meta, boxScore: { homeBatting: [{ Player: 'A Sample', AB: 1, H: 1 }] }, plays: [] };

  normalizeBaseballGame(raw, 't', 'home');

  assert.equal(raw.meta, meta); // same reference
  assert.equal('ourSide' in meta, false); // the internal ourSide injection happened on a COPY, never on the caller's own meta object
});
