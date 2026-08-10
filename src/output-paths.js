'use strict';

// Security Slice T3H: the single authoritative resolver for where scraped
// game data is staged on disk. Before this slice, src/scrape-game-urls.js,
// src/search-gamechanger-teams.js, src/scrape-handedness.js, and
// reingest-games.js all wrote/read a shared, flat `output/<TeamName>/`
// tree with no organization component at all -- if two organizations
// scouted an identically-named team, their raw scraped files could be
// physically co-located, overwritten, or read by the wrong organization,
// and reingest-games.js would then ingest whichever files happened to be
// present and stamp them with the *current job's* orgId regardless of
// which organization actually produced them. This does not bypass any
// database-level ownership predicate (T2/T3C already scope the resulting
// DB writes correctly) -- it mixes tenant data *before* the database
// boundary is ever reached.
//
// resolveOrgOutputRoot()/resolveTeamOutputDir()/resolveOrgSubdir() are the
// only functions production code should use to construct a path under
// output/ for tenant-facing scraped data. Each requires an already
// validated organization id (the same `isValidUuid`-shaped value every
// other tenant-facing entrypoint in this codebase uses -- see
// src/job-org-context.js#requireJobOrgContext, reused by every caller of
// this module, never re-implemented here) and throws
// InvalidOutputOrgIdError -- never silently falls back to the legacy flat
// `output/<TeamName>/` layout -- when it is missing or malformed.
//
// This module intentionally does NOT call requireJobOrgContext() itself.
// Each caller already resolves and validates JOBU_JOB_ORG_ID at its own
// established point (module top-level in reingest-games.js; inside the
// require.main===module guard in scrape-game-urls.js; inside main()/
// scrapeTeamById() in search-gamechanger-teams.js) -- this module is
// purely about safe path construction and containment, not about
// re-deriving trust that already exists in the caller.

const fs = require('fs');
const path = require('path');
const { isValidUuid } = require('./report-access');

const REPO_ROOT = path.join(__dirname, '..');

class InvalidOutputOrgIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidOutputOrgIdError';
  }
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// The bare `output/` root. Exported for tests and for the one legitimate
// non-tenant use (a directory-existence check before enumerating an
// org's own subdirectory) -- production code must never construct a
// team-data path directly under this root; always go through
// resolveOrgOutputRoot()/resolveTeamOutputDir()/resolveOrgSubdir() below.
function outputRoot() {
  return path.join(REPO_ROOT, 'output');
}

// A team-folder or subdir name must be a single path component, not a
// nested path. Rejects this outright, before any join/resolve, rather
// than relying on assertContained() to catch it after the fact -- on
// Windows, path.join() does not reinterpret a mid-argument drive letter
// (e.g. "C:\Windows\Temp") as a new root, so such input stays technically
// "contained" under the org root as a literal (invalid) path segment and
// would otherwise surface as a raw, untyped fs ENOENT from mkdirSync
// instead of failing closed with a clear, typed error here.
function assertSafeChildName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name === '.' ||
    name === '..'
  ) {
    throw new InvalidOutputOrgIdError(
      `Refusing to use "${name}" as an output path segment -- it must be a single, non-empty ` +
      'path component (no separators or ".."), not a nested or absolute path.'
    );
  }
}

// Path-separator-aware containment check -- deliberately not a bare
// string-prefix comparison (which would wrongly accept a sibling like
// "output/<orgId>-evil" as "contained" under "output/<orgId>"). Mirrors
// src/report-access.js#resolveContainedReportPath's established
// `path.resolve(root) + path.sep` convention.
function assertContained(parentDir, candidatePath) {
  const rootResolved = path.resolve(parentDir) + path.sep;
  const resolved = path.resolve(candidatePath);
  if (resolved !== path.resolve(parentDir) && !resolved.startsWith(rootResolved)) {
    throw new InvalidOutputOrgIdError(
      `Refusing to use a path that escapes its expected root: resolved path was outside ${parentDir}.`
    );
  }
  return resolved;
}

// Requires a non-blank, UUID-shaped organization id (the exact same
// isValidUuid contract already enforced by reingest-games.js/
// generate-report.js/scrape-game-urls.js before they ever touch a
// database) and returns the org's staging root, creating it if needed.
// Throws InvalidOutputOrgIdError -- never returns a flat/legacy path --
// for missing, blank, or malformed input. There is no fallback here.
function resolveOrgOutputRoot(orgId) {
  if (!isValidUuid(orgId)) {
    throw new InvalidOutputOrgIdError(
      'resolveOrgOutputRoot requires a valid organization id -- refusing to construct an ' +
      'unscoped or malformed output path. There is no fallback to the shared, legacy flat ' +
      'output/ layout.'
    );
  }
  const root = outputRoot();
  const orgRoot = assertContained(root, path.join(root, orgId));
  ensureDirectory(orgRoot);
  return orgRoot;
}

// Resolves (and creates) one team's folder inside the given organization's
// staging root. `sanitizedTeamFolderName` must already be sanitized by the
// caller using its own existing, unchanged sanitization logic (this
// function does not re-implement or alter that behavior) -- this is a
// defense-in-depth containment check on top of it, not a replacement for
// it, so a sanitization gap in one caller can never escape the selected
// organization's root.
function resolveTeamOutputDir(orgId, sanitizedTeamFolderName) {
  const orgRoot = resolveOrgOutputRoot(orgId);
  assertSafeChildName(sanitizedTeamFolderName);
  const teamDir = assertContained(orgRoot, path.join(orgRoot, sanitizedTeamFolderName));
  ensureDirectory(teamDir);
  return teamDir;
}

// For the small number of non-team-keyed staging subdirectories each
// writer maintains (e.g. `_failed-team-matches`, `_failed-game-captures`,
// `_handedness-debug`) -- same containment guarantee, scoped under the
// same organization root rather than the shared output/ root.
function resolveOrgSubdir(orgId, subdirName) {
  const orgRoot = resolveOrgOutputRoot(orgId);
  assertSafeChildName(subdirName);
  const subdir = assertContained(orgRoot, path.join(orgRoot, subdirName));
  ensureDirectory(subdir);
  return subdir;
}

module.exports = {
  InvalidOutputOrgIdError,
  outputRoot,
  assertContained,
  resolveOrgOutputRoot,
  resolveTeamOutputDir,
  resolveOrgSubdir,
  ensureDirectory,
};
