'use strict';

// Security Slice T3C: pure, dependency-free helpers extracted out of
// reingest-games.js specifically so the security-critical logic behind
// tenant-scoped team matching and log-summary formatting is independently
// unit-testable, without needing to run reingest-games.js itself.
// reingest-games.js is never require()d in tests -- it unconditionally
// resolves and validates JOBU_JOB_ORG_ID and calls pipeline.init() against
// a real SQLite file at module load (the same established constraint
// server.js and search-gamechanger-teams.js already document for their
// own test suites). This mirrors the same extraction pattern
// src/report-access.js already uses in this codebase.

// Matches a scraped output/<folderName> against the CALLER'S ALREADY
// org-scoped team list -- the caller must pass a list already produced by
// db.listTeamsForOrg(JOB_ORG_ID) (see reingest-games.js#ingestTeamFolder).
// This function never queries anything itself and can therefore never
// become a second, differently-scoped lookup: whether a same-named or
// substring-colliding team belonging to a different organization can ever
// be selected depends entirely on whether that organization's row was
// present in `teams` to begin with, not on anything this function does.
//
// Loose, case-insensitive substring match in either direction, matching
// the pre-existing folder-naming convention this script has always used.
// Returns the matched team, or undefined if none matches.
function findMatchingTeam(teams, folderName) {
  const lowerFolder = String(folderName || '').toLowerCase();
  return (Array.isArray(teams) ? teams : []).find((t) =>
    t.team_name.toLowerCase().includes(lowerFolder) ||
    lowerFolder.includes(t.team_name.toLowerCase())
  );
}

// Formats one line of the "DB state after ingest" summary
// (reingest-games.js#main()'s final check). Structurally incapable of
// emitting a GameChanger URL, organization id, or any field beyond a
// team's own id/name and the supplied game count -- not because it
// filters anything out, but because it never reads anything else from
// `team` in the first place, regardless of what other fields the caller's
// team object happens to carry.
function formatTeamSummaryLine(team, gamesAnalyzed) {
  return `  [${team.id}] ${team.team_name} — ${gamesAnalyzed} game(s)`;
}

module.exports = { findMatchingTeam, formatTeamSummaryLine };
