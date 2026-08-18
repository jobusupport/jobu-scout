'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  HS_BASEBALL_ENGINE_VERSION,
  MAX_HS_ENGINE_COLLECTION_BYTES,
  canonicalSerialize,
  assertCollectionPayloadWithinLimit,
  mapHighSchoolEngineCollection,
} = require('../src/high-school-engine-persistence-mapper');

const IDS = {
  orgId: '11111111-1111-4111-8111-111111111111',
  programId: '22222222-2222-4222-8222-222222222222',
  teamId: '33333333-3333-4333-8333-333333333333',
  seasonId: '44444444-4444-4444-8444-444444444444',
  importRunId: '55555555-5555-4555-8555-555555555555',
  playerId: '66666666-6666-4666-8666-666666666666',
};

const context = { ...IDS, sourceProvider: 'gamechanger' };
delete context.playerId;
const rosterMemberships = [{ playerId: IDS.playerId, gcExternalPlayerId: 'gc-own-1' }];

function game(id = 'game-1', options = {}) {
  const meta = {
    gameDate: '2026-04-01',
    homeTeam: 'Synthetic High',
    awayTeam: 'Synthetic Rival',
    ourSide: 'home',
    capturedAt: '2026-04-01T20:00:00.000Z',
    ...(options.meta || {}),
  };
  if (id !== null) meta.sourceGameId = id;
  return {
    meta,
    boxScore: {
      batting: options.batting || [
        { Player: 'Alex Sample', TeamSide: 'home', isHighSchoolTeam: true, playerId: 'gc-own-1' },
        { Player: 'Alex Sample', TeamSide: 'away', isHighSchoolTeam: false, playerId: 'gc-opp-1' },
      ],
      pitching: options.pitching || [],
    },
    plays: options.plays || [
      { inning: 'Bottom 1', batterId: 'gc-own-1', text: 'Single. Alex Sample singles to left field, Pat Fixture pitching.' },
      { inning: 'Top 2', batterId: 'gc-opp-1', text: 'Double. Alex Sample doubles to right field, Pat Fixture pitching.' },
    ],
  };
}

function mapped(games, roster = rosterMemberships) {
  return mapHighSchoolEngineCollection({ context, capturedGames: games, rosterMemberships: roster });
}

test('maps durable identity, invokes authoritative engine outputs, and records the stable engine version', () => {
  const result = mapped([game()]);
  assert.equal(result.dto.engineVersion, HS_BASEBALL_ENGINE_VERSION);
  assert.equal(result.dto.observations[0].identityMethod, 'sourceGameId');
  assert.equal(result.dto.observations[0].identityStatus, 'single');
  assert.equal(result.dto.observations[0].sourceGameRef, 'game-1');
  assert.equal(result.dto.teamTotals.games, 1);
  assert.match(result.dto.inputSetHash, /^[0-9a-f]{64}$/);
  assert.match(result.dto.contentHash, /^[0-9a-f]{64}$/);
});

test('maps compatible fallback evidence and preserves enrichment discriminators', () => {
  const first = game(null, { meta: { startTime: '10:00 AM' } });
  const enriched = game(null, { meta: { startTime: '10:00 AM', field: 'North' } });
  const result = mapped([first, enriched]).dto;
  assert.equal(result.teamTotals.games, 1);
  assert.ok(result.observations.every((item) => item.identityMethod === 'scheduleComposite'));
  assert.ok(result.observations.every((item) => item.identityStatus === 'reconciled'));
  assert.ok(result.observations.some((item) => item.discriminators.field === 'north'));
  assert.equal(result.observations.length, 2, 'both source observations remain stored');
});

test('real fallback doubleheaders remain separate', () => {
  const one = game(null, { meta: { startTime: '10:00 AM', gameNumber: 1 } });
  const two = game(null, { meta: { startTime: '10:00 AM', gameNumber: 2 } });
  const result = mapped([one, two]).dto;
  assert.equal(result.teamTotals.games, 2);
  assert.equal(new Set(result.observations.map((item) => item.identityDigest)).size, 2);
});

test('identical unresolved observations remain distinct and never gain aliases', () => {
  const unresolved = game(null);
  const result = mapped([unresolved, structuredClone(unresolved)]).dto;
  assert.equal(result.observations.length, 2);
  assert.equal(result.teamTotals.games, 2);
  assert.ok(result.observations.every((item) => item.identityMethod === 'unresolvedScoped'));
  assert.equal(new Set(result.observations.map((item) => item.observationKey)).size, 2);
  assert.equal(new Set(result.observations.map((item) => item.identityDigest)).size, 2);
});

test('ambiguous schedule components remain visible and excluded from official totals', () => {
  const early = game(null, { meta: { startTime: '10:00 AM' } });
  const one = game(null, { meta: { startTime: '10:00 AM', gameNumber: 1 } });
  const two = game(null, { meta: { startTime: '10:00 AM', gameNumber: 2 } });
  const result = mapped([early, one, two]).dto;
  assert.equal(result.teamTotals.games, 0);
  assert.equal(result.officialTotalsComplete, false);
  assert.ok(result.observations.every((item) => item.identityStatus === 'ambiguous'));
  assert.ok(result.observations.every((item) => item.authoritative === false));
  assert.ok(result.observations.every((item) => /^[0-9a-f]{64}$/.test(item.ambiguityComponentDigest)));
});

test('durable conflicts retain bounded evidence rather than raw fingerprints', () => {
  const left = game('conflict', { meta: { complete: true, scoreUs: 4, scoreThem: 2 } });
  const right = game('conflict', { meta: { complete: true, scoreUs: 5, scoreThem: 2 } });
  const result = mapped([left, right]).dto;
  assert.ok(result.observations.every((item) => item.identityStatus === 'conflict'));
  assert.ok(result.observations.every((item) => item.conflictFields.includes('scoreUs')));
  assert.ok(result.observations.every((item) => item.diagnostics.reconciliation.candidateFingerprintDigests.length === 2));
  assert.equal(JSON.stringify(result).includes('candidateFingerprints'), false);
});

test('a malformed ambiguous record is retained with a stable diagnostic failure', () => {
  const early = game(null, { meta: { startTime: '10:00 AM' } });
  const one = game(null, { meta: { startTime: '10:00 AM', gameNumber: 1 } });
  const two = game(null, { meta: { startTime: '10:00 AM', gameNumber: 2 } });
  delete early.boxScore.batting[0].isHighSchoolTeam;
  delete early.boxScore.batting[0].own;
  assert.throws(
    () => mapped([early, one, two]),
    (error) => error.code === 'MISSING_TEAM_OWNERSHIP',
    'the trusted mapper rejects missing ownership before diagnostic reconstruction',
  );
});

test('requires explicit owned side and never defaults to home', () => {
  const input = game();
  delete input.meta.ourSide;
  assert.throws(() => mapped([input]), (error) => error.code === 'MISSING_TEAM_OWNED_SIDE');
});

test('verified provider IDs map to canonical UUIDs while opponents and same-name players remain noncanonical', () => {
  const result = mapped([game()]).dto;
  assert.deepEqual(result.canonicalPlayers.map((row) => row.playerId), [IDS.playerId]);
  assert.ok(result.noncanonicalPlayers.some((row) => row.side === 'opponent' && row.providerPlayerId === 'gc-opp-1'));
  assert.equal(result.noncanonicalPlayers.some((row) => row.displayName === 'Alex Sample' && row.side === 'own'), false);
  const boxSnapshot = result.observations[0].snapshots.find((snapshot) => snapshot.kind === 'box_score');
  assert.equal(boxSnapshot.payload.batting[0].playerId, 'gc-own-1', 'raw provider evidence must not be rewritten to an internal UUID');
});

test('unknown, ambiguous roster mappings, and name-only own players remain noncanonical', () => {
  const unknown = game('unknown', {
    batting: [{ Player: 'Name Only', TeamSide: 'home', isHighSchoolTeam: true }],
    plays: [{ inning: 'Bottom 1', text: 'Single. Name Only singles to left field, Pat Fixture pitching.' }],
  });
  const duplicateRoster = [
    ...rosterMemberships,
    { playerId: '77777777-7777-4777-8777-777777777777', gcExternalPlayerId: 'gc-own-1' },
  ];
  const ambiguous = mapped([game('ambiguous-roster')], duplicateRoster).dto;
  const nameOnly = mapped([unknown]).dto;
  assert.equal(ambiguous.canonicalPlayers.length, 0);
  assert.ok(ambiguous.noncanonicalPlayers.some((row) => row.side === 'own'));
  assert.equal(nameOnly.canonicalPlayers.length, 0);
  assert.ok(nameOnly.noncanonicalPlayers.some((row) => row.side === 'own' && /durable player ID/i.test(row.reason)));
});

test('trusted internal UUID is accepted only when cross-validated against the roster hierarchy', () => {
  const trusted = game('trusted', {
    batting: [{ Player: 'Trusted Player', TeamSide: 'home', isHighSchoolTeam: true, hsPlayerId: IDS.playerId }],
    plays: [{ inning: 'Bottom 1', batterId: IDS.playerId, text: 'Single. Trusted Player singles to left field, Pat Fixture pitching.' }],
  });
  const contradictory = structuredClone(trusted);
  contradictory.meta.sourceGameId = 'contradictory';
  contradictory.boxScore.batting[0].hsPlayerId = '88888888-8888-4888-8888-888888888888';
  const good = mapped([trusted]).dto;
  const bad = mapped([contradictory]).dto;
  assert.equal(good.canonicalPlayers[0].playerId, IDS.playerId);
  assert.equal(bad.canonicalPlayers.length, 0);
});

test('URL-only game references never become durable source identities', () => {
  const input = game('https://example.invalid/game/123');
  input.meta.sourceGameUrl = input.meta.sourceGameId;
  const result = mapped([input]).dto.observations[0];
  assert.equal(result.sourceGameRef, null);
  assert.equal(result.identityMethod, 'unresolvedScoped');
  assert.equal(result.sourceGameUrl, 'https://example.invalid/game/123');
});

test('DTO mapping is deterministic and does not mutate inputs', () => {
  const games = [game('b'), game('a')];
  games[1].meta.capturedAt = '2026-04-02T20:00:00.000Z';
  const before = structuredClone(games);
  const forward = mapped(games);
  const reverse = mapped([...games].reverse());
  assert.equal(forward.serializedDto, reverse.serializedDto);
  assert.deepEqual(games, before);
  assert.equal(forward.serializedDto, canonicalSerialize(forward.dto));
  assert.equal(forward.payloadBytes, Buffer.byteLength(forward.serializedDto, 'utf8'));
});

test('input hash changes with evidence but not input ordering', () => {
  const first = game('a');
  const second = game('b');
  second.meta.capturedAt = '2026-04-02T20:00:00.000Z';
  assert.equal(mapped([first, second]).dto.inputSetHash, mapped([second, first]).dto.inputSetHash);
  const changed = structuredClone(second);
  changed.plays[0].text = 'Walk. Alex Sample walks, Pat Fixture pitching.';
  assert.notEqual(mapped([first, second]).dto.inputSetHash, mapped([first, changed]).dto.inputSetHash);
});

test('payload boundary measures UTF-8 bytes at below, equal, and above 4 MiB', () => {
  assert.equal(assertCollectionPayloadWithinLimit('x'.repeat(4_194_303)), 4_194_303);
  assert.equal(assertCollectionPayloadWithinLimit('x'.repeat(4_194_304)), 4_194_304);
  assert.throws(
    () => assertCollectionPayloadWithinLimit('x'.repeat(4_194_305)),
    (error) => error.code === 'HS_ENGINE_COLLECTION_TOO_LARGE'
      && error.statusCode === 413
      && !error.message.includes('xxxxx'),
  );
  assert.equal(assertCollectionPayloadWithinLimit('é'.repeat(2_097_152)), MAX_HS_ENGINE_COLLECTION_BYTES);
});

test('mapper dependency graph contains no database, Supabase, network, or filesystem dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'high-school-engine-persistence-mapper.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:@supabase|\.\/supabase|node:(?:fs|net|http|https)|axios|pg|postgres)/);
});

function syntheticSeason(gameCount, playCount, playerCount) {
  const roster = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `aaaaaaaa-aaaa-4aaa-8${String(index).padStart(3, '0')}-aaaaaaaaaaaa`,
    gcExternalPlayerId: `synthetic-player-${index}`,
  }));
  const games = Array.from({ length: gameCount }, (_, gameIndex) => {
    const batting = roster.map((membership, playerIndex) => ({
      Player: `Synthetic Player ${playerIndex}`,
      TeamSide: 'home',
      isHighSchoolTeam: true,
      playerId: membership.gcExternalPlayerId,
    }));
    const plays = Array.from({ length: playCount }, (_, playIndex) => {
      const player = roster[playIndex % roster.length];
      const playerIndex = playIndex % roster.length;
      return {
        inning: `Bottom ${(playIndex % 7) + 1}`,
        batterId: player.gcExternalPlayerId,
        text: `Single. Synthetic Player ${playerIndex} singles to left field, Synthetic Pitcher pitching.`,
      };
    });
    return game(`synthetic-season-${gameIndex}`, {
      batting,
      plays,
      meta: {
        gameDate: `2026-${String((gameIndex % 5) + 3).padStart(2, '0')}-${String((gameIndex % 27) + 1).padStart(2, '0')}`,
        capturedAt: new Date(Date.UTC(2026, 2, gameIndex + 1, 20)).toISOString(),
      },
    });
  });
  return { roster, games };
}

test('synthetic season payload measurements fit the application cap', () => {
  const scenarios = [
    ['small', 4, 20, 18],
    ['typical', 30, 80, 24],
    ['large', 60, 140, 30],
    ['extreme', 80, 200, 36],
  ];
  for (const [label, gameCount, playCount, playerCount] of scenarios) {
    const season = syntheticSeason(gameCount, playCount, playerCount);
    const result = mapped(season.games, season.roster);
    const measurement = {
      label,
      games: gameCount,
      observations: result.dto.observations.length,
      snapshots: result.dto.snapshotCount,
      playerResults: result.dto.canonicalPlayers.length + result.dto.noncanonicalPlayers.length,
      bytes: result.payloadBytes,
      percentOfCap: Number(((result.payloadBytes / MAX_HS_ENGINE_COLLECTION_BYTES) * 100).toFixed(2)),
    };
    process.stdout.write(`# payload-measurement ${JSON.stringify(measurement)}\n`);
    assert.ok(result.payloadBytes <= MAX_HS_ENGINE_COLLECTION_BYTES, `${label} must fit the 4 MiB cap`);
  }
});
