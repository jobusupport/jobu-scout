'use strict';

// Security Slice T3D: focused unit tests for src/report-team-selection.js,
// the pure team-matching/formatting helpers generate-report.js calls at
// every team-discovery site (listTeams, findTeam, --all). These exercise
// the REAL functions in isolation from any database, proving matching
// semantics (id / exact-name / partial-name / ambiguous) are preserved
// and that the format helpers can never emit anything beyond a team's own
// id/name. Cross-organization isolation itself (i.e. that a same-named or
// same-id foreign team never appears in the list these helpers are fed)
// is proven separately in test/db-supabase-tenant-isolation.test.js
// against the REAL db.listTeamsForOrg, using these same real functions.
//
// Run with: node --test test/report-team-selection.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTeamQuery,
  resolveTeamMatch,
  formatTeamListLine,
  formatAmbiguousMatchLine,
  runTeamsSequentially,
} = require('../src/report-team-selection');

function team(overrides = {}) {
  return {
    id: 'id-default',
    team_name: 'Default Team',
    raw_team_name: 'Default Team',
    ...overrides,
  };
}

test('normalizeTeamQuery: lowercases, trims, and tolerates non-string/null/undefined', () => {
  assert.equal(normalizeTeamQuery('  Foo Bar  '), 'foo bar');
  assert.equal(normalizeTeamQuery(null), '');
  assert.equal(normalizeTeamQuery(undefined), '');
  assert.equal(normalizeTeamQuery(123), '123');
});

test('resolveTeamMatch: resolves by exact id (case-insensitive)', () => {
  const teams = [team({ id: 'AAA-1', team_name: 'Tigers' }), team({ id: 'BBB-2', team_name: 'Bears' })];
  const { team: matched } = resolveTeamMatch(teams, 'aaa-1');
  assert.equal(matched.id, 'AAA-1');
});

test('resolveTeamMatch: resolves by exact team_name (case-insensitive, trimmed)', () => {
  const teams = [team({ id: '1', team_name: 'James Clemens' }), team({ id: '2', team_name: 'Bob Jones' })];
  const { team: matched } = resolveTeamMatch(teams, '  JAMES CLEMENS  ');
  assert.equal(matched.id, '1');
});

test('resolveTeamMatch: resolves by exact raw_team_name when team_name differs', () => {
  const teams = [team({ id: '1', team_name: 'Normalized Name', raw_team_name: 'Raw Scraped Name' })];
  const { team: matched } = resolveTeamMatch(teams, 'raw scraped name');
  assert.equal(matched.id, '1');
});

test('resolveTeamMatch: resolves by partial (substring) name match when no exact match exists', () => {
  const teams = [team({ id: '1', team_name: 'James Clemens Baseball' })];
  const { team: matched } = resolveTeamMatch(teams, 'clemens');
  assert.equal(matched.id, '1');
});

test('resolveTeamMatch: id match takes priority over a name match on a different team', () => {
  const teams = [
    team({ id: 'exact-id', team_name: 'Some Other Team' }),
    team({ id: 'other', team_name: 'exact-id' }), // a team literally named the first team's id
  ];
  const { team: matched } = resolveTeamMatch(teams, 'exact-id');
  assert.equal(matched.id, 'exact-id', 'the id match must win, not the name-collision team');
});

test('resolveTeamMatch: multiple partial matches are ambiguous -- team is null, matches has all candidates', () => {
  const teams = [
    team({ id: '1', team_name: 'James Clemens A' }),
    team({ id: '2', team_name: 'James Clemens B' }),
  ];
  const { team: matched, matches } = resolveTeamMatch(teams, 'james clemens');
  assert.equal(matched, null);
  assert.equal(matches.length, 2);
});

test('resolveTeamMatch: no match at all -- team is null, matches is empty', () => {
  const teams = [team({ id: '1', team_name: 'Tigers' })];
  const { team: matched, matches } = resolveTeamMatch(teams, 'nonexistent');
  assert.equal(matched, null);
  assert.deepEqual(matches, []);
});

test('resolveTeamMatch: empty team list never matches anything, regardless of query', () => {
  const { team: matched, matches } = resolveTeamMatch([], 'anything');
  assert.equal(matched, null);
  assert.deepEqual(matches, []);
});

test('resolveTeamMatch: non-array input is treated as an empty list, not an error', () => {
  const { team: matched, matches } = resolveTeamMatch(undefined, 'anything');
  assert.equal(matched, null);
  assert.deepEqual(matches, []);
});

test('formatTeamListLine: includes only id, team_name, and the supplied game count', () => {
  const line = formatTeamListLine(team({ id: 'abc', team_name: 'Tigers', gc_team_url: 'https://gc.example/secret' }), 5);
  assert.match(line, /\[abc\]/);
  assert.match(line, /Tigers/);
  assert.match(line, /5 games/);
  assert.doesNotMatch(line, /gc\.example/, 'must never read/emit a GameChanger URL field');
});

test('formatTeamListLine: singular "game" for a count of exactly 1', () => {
  const line = formatTeamListLine(team({ id: 'abc', team_name: 'Tigers' }), 1);
  assert.match(line, /1 game(?!s)/);
});

test('formatAmbiguousMatchLine: includes only id and team_name', () => {
  const line = formatAmbiguousMatchLine(team({ id: 'xyz', team_name: 'Bears', org_id: 'org-secret', gc_team_url: 'https://gc.example/secret' }));
  assert.match(line, /\[xyz\]/);
  assert.match(line, /Bears/);
  assert.doesNotMatch(line, /org-secret/);
  assert.doesNotMatch(line, /gc\.example/);
});

// ── runTeamsSequentially: the REAL --all orchestration loop ─────────────────
//
// generate-report.js's --all branch calls this exact function with the
// real runForTeam as `runner` -- these tests exercise the real function
// with a fake runner standing in for runForTeam (which would otherwise
// call the live analyzer/Claude API/report generator), proving the
// continuation/error semantics and call-isolation guarantees that were
// previously only implied by source order, never executed.

test('runTeamsSequentially: calls the runner once per team, in order, awaiting each before starting the next', async () => {
  const calls = [];
  const teams = [team({ id: '1' }), team({ id: '2' }), team({ id: '3' })];

  const runner = async (t) => {
    // If the loop did not await each call before starting the next, a
    // shorter delay on a later team would let it "finish" first --
    // proving sequencing, not just that the runner was eventually called
    // for everyone.
    await new Promise((resolve) => setTimeout(resolve, t.id === '1' ? 10 : 0));
    calls.push(t.id);
  };

  const result = await runTeamsSequentially(teams, runner);

  assert.deepEqual(calls, ['1', '2', '3'], 'each team must be awaited to completion before the next one starts');
  assert.deepEqual(result, { succeeded: 3, failed: 0 });
});

test('runTeamsSequentially: zero teams -- the runner is never invoked, result is {succeeded: 0, failed: 0}', async () => {
  let callCount = 0;
  const result = await runTeamsSequentially([], async () => { callCount++; });
  assert.equal(callCount, 0);
  assert.deepEqual(result, { succeeded: 0, failed: 0 });
});

test('runTeamsSequentially: one team\'s (async, rejected-promise) failure does not abort the remaining teams -- ' +
     'established per-team continuation semantics are preserved', async () => {
  const processed = [];
  const teams = [team({ id: '1' }), team({ id: '2', team_name: 'Failing Team' }), team({ id: '3' })];

  const runner = async (t) => {
    processed.push(t.id);
    if (t.id === '2') throw new Error('boom');
  };

  const errors = [];
  const result = await runTeamsSequentially(teams, runner, (t, err) => errors.push({ id: t.id, message: err.message }));

  assert.deepEqual(processed, ['1', '2', '3'], 'team 3 must still be processed after team 2 fails');
  assert.deepEqual(result, { succeeded: 2, failed: 1 });
  assert.deepEqual(errors, [{ id: '2', message: 'boom' }], 'onTeamError must receive exactly the failing team and its real error');
});

test('runTeamsSequentially: a team\'s synchronous throw inside the runner is caught the same as an async rejection', async () => {
  const teams = [team({ id: '1' })];
  const runner = (t) => { throw new Error('sync boom'); };

  const errors = [];
  const result = await runTeamsSequentially(teams, runner, (t, err) => errors.push(err.message));

  assert.deepEqual(result, { succeeded: 0, failed: 1 });
  assert.deepEqual(errors, ['sync boom']);
});

test('runTeamsSequentially: onTeamError is optional -- a failure without a handler still updates the failed count ' +
     'and does not throw out of runTeamsSequentially itself', async () => {
  const teams = [team({ id: '1' }), team({ id: '2' })];
  const runner = async (t) => { if (t.id === '1') throw new Error('boom'); };

  const result = await runTeamsSequentially(teams, runner);
  assert.deepEqual(result, { succeeded: 1, failed: 1 });
});

test('runTeamsSequentially: the runner is invoked with the exact team object from the input list -- ' +
     'never a re-fetched, re-derived, or substituted team', async () => {
  const teamA = team({ id: 'org-a-team' });
  const received = [];
  await runTeamsSequentially([teamA], async (t) => { received.push(t); });
  assert.equal(received.length, 1);
  assert.equal(received[0], teamA, 'must be the identical object reference, not a copy or lookup result');
});
