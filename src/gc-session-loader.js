'use strict';

// Secure loading/validation for the authorized GameChanger collector's
// Playwright storageState session file (gamechanger-auth.json). Using an
// authenticated session for licensed, automated collection is authorized
// and expected -- this module exists to load and validate that session
// safely, not to replace or restrict it.
//
// Path resolution: GC_AUTH_FILE_PATH lets an operator point at a
// secret-mounted runtime path (e.g. a Kubernetes secret volume, or
// wherever a given deployment platform materializes injected secrets)
// without any code change. When unset, this falls back to the same
// repo-relative location the codebase has always used
// (storage/gamechanger-auth.json, matching src/search-gamechanger-teams.js's
// own STORAGE_STATE and server.js's own startup GC_AUTH_JSON-to-file
// writer) -- so existing deployments keep working unchanged.
//
// Nothing in this module ever includes the resolved file path, cookie
// values, tokens, or any other session content in a thrown error message --
// every SessionValidationError message is a fixed, generic string, safe to
// surface all the way to a job log or HTTP response with no further
// sanitization required (though callers should still route it through
// gc-collection-policy's sanitizeCollectionErrorMessage as defense in
// depth, the same as every other collection error).

const fs = require('fs');
const path = require('path');

class SessionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionValidationError';
  }
}

function getStorageStatePath() {
  const configured = process.env.GC_AUTH_FILE_PATH;
  if (configured && configured.trim()) return configured.trim();
  return path.join(__dirname, '..', 'storage', 'gamechanger-auth.json');
}

// Validates the file at `filePath` (defaults to getStorageStatePath())
// exists, is a regular file, is readable, contains structurally valid
// JSON, and has the shape Playwright's storageState actually needs
// (a `cookies` array and/or an `origins` array, with at least one
// non-empty) -- without ever reading that shape's actual VALUES into
// anything that could be logged. Throws SessionValidationError with a
// fixed, generic message on any failure; returns true on success.
function validateStorageStateFile(filePath = getStorageStatePath()) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new SessionValidationError('GameChanger session file is missing. Run npm run login first.');
  }

  if (!stat.isFile()) {
    throw new SessionValidationError('GameChanger session file path does not point to a regular file.');
  }

  let raw;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new SessionValidationError('GameChanger session file could not be read.');
  }

  if (!raw || !raw.trim()) {
    throw new SessionValidationError('GameChanger session file is empty.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionValidationError('GameChanger session file is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionValidationError('GameChanger session file has an unexpected shape.');
  }

  const hasCookies = Array.isArray(parsed.cookies);
  const hasOrigins = Array.isArray(parsed.origins);
  if (!hasCookies && !hasOrigins) {
    throw new SessionValidationError('GameChanger session file does not contain the expected storage-state shape.');
  }

  const cookieCount = hasCookies ? parsed.cookies.length : 0;
  const originCount = hasOrigins ? parsed.origins.length : 0;
  if (cookieCount === 0 && originCount === 0) {
    throw new SessionValidationError('GameChanger session file appears to contain no session data.');
  }

  return true;
}

// A GameChanger page landing anywhere other than a team/schedule URL after
// navigation is treated as a rejected/expired session -- GameChanger
// redirects an unauthenticated request to a login page rather than
// returning an error status, so this is a URL-shape check, not a status
// code check. The landed URL itself is never included in the thrown
// message (it could carry query-string tokens) -- only a generic notice.
function assertLandedOnAuthenticatedGameChangerPage(landedUrl) {
  const url = String(landedUrl || '');
  const looksAuthenticated = /^https:\/\/web\.gc\.com\/teams\//i.test(url);
  const looksLikeLogin = /\/(login|sign[_-]?in|auth)\b/i.test(url);
  if (!looksAuthenticated || looksLikeLogin) {
    throw new SessionValidationError('GameChanger session appears to be expired or was rejected.');
  }
  return true;
}

module.exports = {
  getStorageStatePath,
  validateStorageStateFile,
  assertLandedOnAuthenticatedGameChangerPage,
  SessionValidationError,
};
