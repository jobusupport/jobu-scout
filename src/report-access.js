'use strict';

const path = require('path');
const fs = require('fs');

// Security Slice T3B: pure, dependency-free helpers extracted out of
// server.js specifically so the security-critical logic behind the
// ourTeamId ownership fix and the authenticated report-download route is
// independently unit-testable, without needing to boot the whole server
// (server.js itself is never require()d in tests -- it calls app.listen()
// unconditionally at module load; see test/travel-api-entitlement-gates.test.js's
// own header for the established reasoning). This mirrors the same
// extraction pattern src/org-resolution.js and src/express-helpers.js
// already use in this codebase.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Resolves a client-supplied "our team" id against an ALREADY
// org-scoped team list (the caller must pass the trusted request
// organization's own teams, e.g. server.js's getTeams(req) result --
// this function never queries anything itself and can therefore never
// become a second, differently-scoped lookup).
//
// Returns:
//   null   ourTeamId was not supplied -- caller keeps its existing
//          default "our team" behavior unchanged.
//   id     ourTeamId was supplied and is present in `teams`.
//   false  ourTeamId was supplied but is blank, the wrong type, or not
//          present in `teams` -- deliberately the SAME return value
//          whether the id is malformed, unknown, or belongs to a
//          different organization, so a caller can never learn which
//          case occurred.
function resolveOwnedTeamId(teams, ourTeamId) {
  if (ourTeamId === undefined || ourTeamId === null || ourTeamId === '') return null;
  if (typeof ourTeamId !== 'string') return false;
  const match = (Array.isArray(teams) ? teams : []).find((t) => t && t.id === ourTeamId);
  return match ? match.id : false;
}

// Builds a safe Content-Disposition filename from a server-stored report
// title. The title ultimately traces back to a scraped GameChanger team
// name, so it is treated as untrusted for header-injection purposes:
// stripped to a conservative charset (never passed through unescaped),
// length-capped, and always suffixed with the fixed, non-attacker-
// controlled ".pdf" extension actually being served.
function sanitizeDownloadFilename(rawTitle) {
  const base = String(rawTitle || 'report')
    .replace(/[^a-zA-Z0-9 _.-]/g, '')
    .trim()
    .slice(0, 80);
  return `${base || 'report'}.pdf`;
}

// Resolves a stored (relative) report path against the approved
// REPORTS_DIR root and verifies containment -- protects against a
// corrupted or maliciously-written storage_path (absolute path, `../`
// traversal, a different drive on Windows, etc.) regardless of how it
// got into the row. Pure path-string logic; never touches the
// filesystem, so it is testable without real files.
//
// Returns the resolved absolute path, or null if the stored path is
// missing, not a string, or resolves outside reportsDir.
function resolveContainedReportPath(reportsDir, storagePath) {
  if (!storagePath || typeof storagePath !== 'string') return null;
  const rootResolved = path.resolve(reportsDir) + path.sep;
  const resolved = path.resolve(reportsDir, storagePath);
  if (!resolved.startsWith(rootResolved)) return null;
  return resolved;
}

// Verifies the resolved path is an actual regular file. Uses lstat (not
// stat) so a symlink is NEVER followed -- isFile() is false for a
// symlink regardless of what it points to, which rejects every symlink
// (not only ones that escape reportsDir) and every directory. Never
// throws for a missing/inaccessible path -- returns false instead, so
// callers can produce a uniform sanitized "not found" response.
function isServableReportFile(resolvedPath) {
  try {
    const stat = fs.lstatSync(resolvedPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

// Security Slice T3J: resolveContainedReportPath above is deliberately
// pure, string-only logic (see its own header) -- it can approve a path
// that LOOKS contained (`path.resolve()`/`startsWith()` on the string)
// even when an intermediate directory component is actually a symlink
// pointing outside reportsDir. isServableReportFile's lstat only refuses
// the FINAL path component being a symlink; the OS still transparently
// follows a symlinked intermediate directory while locating that final
// component, so neither existing check catches, e.g., reportsDir/escape/
// report.pdf where "escape" is a symlink to somewhere outside reportsDir.
//
// This re-resolves both the root and the candidate through the real
// filesystem with fs.realpathSync() -- which follows every symlink in
// the full chain, intermediate or final -- and re-checks containment on
// those canonical, symlink-resolved locations. Call this only once the
// candidate is already known to exist as a real file (i.e. after
// isServableReportFile has returned true for it); realpathSync throws
// for a path that doesn't exist, so an already-vanished file (a TOCTOU
// race) or a missing reportsDir simply fails closed here exactly like
// any other "not found" case, never as a distinct filesystem error.
//
// Returns the canonical absolute path when it is genuinely contained
// within the canonical reportsDir, or null otherwise.
function resolveCanonicalReportPath(reportsDir, resolvedPath) {
  let canonicalRoot;
  let canonicalCandidate;
  try {
    canonicalRoot = fs.realpathSync(reportsDir);
    canonicalCandidate = fs.realpathSync(resolvedPath);
  } catch {
    return null;
  }
  const rootWithSep = canonicalRoot + path.sep;
  if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(rootWithSep)) {
    return null;
  }
  return canonicalCandidate;
}

// Builds the collision-resistant, per-organization output directory a
// newly generated report is written into: <reportsDir>/<orgId>/<reportId>.
// Both components come only from already-trusted, server-controlled
// context (never from a team name or any scraped/user-supplied value),
// which is what makes two organizations generating a same-named report
// on the same date structurally unable to collide -- each report gets
// its own directory regardless of what filename report.js's own
// (unchanged) naming logic produces inside it.
//
// Returns null when either id is missing/malformed, so the caller can
// fall back to the flat, non-namespaced reportsDir (the existing,
// intentional behavior for bare-CLI operator runs that have no HTTP job
// context at all -- see generate-report.js).
function resolveReportOutputDir(reportsDir, orgId, reportId) {
  if (!isValidUuid(orgId) || !isValidUuid(reportId)) return null;
  return path.join(reportsDir, orgId, reportId);
}

module.exports = {
  UUID_RE,
  isValidUuid,
  resolveOwnedTeamId,
  sanitizeDownloadFilename,
  resolveContainedReportPath,
  isServableReportFile,
  resolveCanonicalReportPath,
  resolveReportOutputDir,
};
