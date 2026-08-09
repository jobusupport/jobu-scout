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
