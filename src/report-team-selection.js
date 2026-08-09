'use strict';

// Security Slice T3D: pure, dependency-free helpers extracted out of
// src/generate-report.js specifically so the security-critical logic
// behind tenant-scoped team matching and safe list/ambiguity output is
// independently unit-testable, without needing to run generate-report.js
// itself. generate-report.js is never require()d in tests -- it
// unconditionally resolves/validates JOBU_JOB_ORG_ID and calls db.init()
// against a real database at module load (the same established
// constraint reingest-games.js, server.js, and search-gamechanger-teams.js
// already document for their own test suites). This mirrors the same
// extraction pattern src/reingest-helpers.js already uses in this
// codebase.

function normalizeTeamQuery(value) {
  return String(value || '').toLowerCase().trim();
}

// Resolves nameFragment against the CALLER'S ALREADY org-scoped team list
// -- the caller must pass a list already produced by
// db.listTeamsForOrg(JOB_ORG_ID) (see generate-report.js#findTeam). This
// function never queries anything itself and can therefore never become a
// second, differently-scoped lookup: whether an exact-ID, exact-name, or
// partial-name collision with a different organization's team can ever be
// selected depends entirely on whether that organization's row was
// present in `teams` to begin with, not on anything this function does.
//
// Matching semantics are unchanged from the pre-T3D implementation:
//   1. exact team id match
//   2. exact team_name/raw_team_name match (case-insensitive, trimmed)
//   3. partial (substring) team_name/raw_team_name match
// Returns { team, matches }:
//   team    the single resolved team, or null if none/ambiguous
//   matches the full set of candidate matches considered at the final
//           tier reached (empty array if none matched at all) -- callers
//           use this to render an ambiguous-match listing without
//           re-querying.
function resolveTeamMatch(teams, nameFragment) {
  const list = Array.isArray(teams) ? teams : [];
  const lower = normalizeTeamQuery(nameFragment);

  const byId = list.find((t) => normalizeTeamQuery(t.id) === lower);
  if (byId) return { team: byId, matches: [byId] };

  const exactMatches = list.filter((t) =>
    normalizeTeamQuery(t.team_name) === lower ||
    normalizeTeamQuery(t.raw_team_name) === lower
  );
  if (exactMatches.length === 1) return { team: exactMatches[0], matches: exactMatches };

  const partialMatches = list.filter((t) =>
    normalizeTeamQuery(t.team_name).includes(lower) ||
    normalizeTeamQuery(t.raw_team_name).includes(lower)
  );

  const matches = exactMatches.length ? exactMatches : partialMatches;

  if (matches.length === 1) return { team: matches[0], matches };
  return { team: null, matches };
}

// Formats one line of the "Teams in Voodoo Scout DB" listing. Structurally
// incapable of emitting a GameChanger URL, organization id, or any field
// beyond a team's own id/name and the supplied game count -- not because
// it filters anything out, but because it never reads anything else from
// `team` in the first place, regardless of what other fields the caller's
// team object happens to carry.
function formatTeamListLine(team, gamesAnalyzed) {
  const games = gamesAnalyzed ?? 0;
  return `  [${team.id}] ${team.team_name} — ${games} game${games !== 1 ? 's' : ''}`;
}

// Formats one line of an ambiguous-match listing ("Multiple teams match
// ..."). Same structural guarantee as formatTeamListLine: only ever reads
// a team's own id/name.
function formatAmbiguousMatchLine(team) {
  return `  [${team.id}] ${team.team_name}`;
}

module.exports = {
  normalizeTeamQuery,
  resolveTeamMatch,
  formatTeamListLine,
  formatAmbiguousMatchLine,
};
