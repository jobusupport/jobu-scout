'use strict';

// Pure validation, sanitization, and error-construction helpers for the High
// School import persistence core (Slice 1A). Nothing in this file touches a
// database, the filesystem, or a network -- every function here is a plain
// value in, value/throw out transformation, so the credential-rejection and
// context-validation POLICY can be unit-tested without a Supabase client or
// a fake repository at all.
//
// ── Why this is its own module ───────────────────────────────────────────
// src/high-school-roster-service.js keeps its `typedError`/validation
// helpers inline because that module has exactly one concern (CRUD
// validation for five simple tables). This slice has a second, genuinely
// distinct concern -- recursively rejecting credential-shaped keys in an
// arbitrary, externally-sourced JSON payload before it is ever persisted --
// that deserves its own focused, independently-testable module rather than
// being buried inside orchestration logic.
//
// ── UUID validation is reused, not reimplemented ─────────────────────────
// isValidUuid/requireUuid/UUID_RE come from high-school-roster-service.js
// (already deployed, already tested) -- the contract is identical (org_id,
// program_id, team_id, season_id, player_id are all uuid columns on every
// hs_* table), so re-deriving the same regex here would just be a second
// place for it to drift out of sync.
//
// ── Error message sanitization is reused, not reimplemented ─────────────
// sanitizeErrorMessage below is exactly
// high-school-importer-contract.js's own sanitizeSyncError: nullable,
// scrubbed of anything credential/session-shaped, bounded to 2000 chars --
// which is exactly hs_import_runs.error_summary's own CHECK constraint
// shape. Reused directly rather than re-implemented so the two modules can
// never silently diverge on what "sanitized" means.
//
// ── The credential-key policy is deliberately over-inclusive ────────────
// Every key (at any depth, in objects or arrays) is checked as a
// normalized (lowercased, non-alphanumeric-stripped) SUBSTRING match
// against a fixed list of credential/session-shaped fragments. This means
// a field like `game_token` is REJECTED, even though "token" here might
// plausibly be a legitimate GameChanger-issued game identifier rather than
// an authentication artifact -- no evidence of such a field exists
// anywhere in this repository's existing scraping code
// (game-reconstructor.js, normalizer.js, pipeline.js), so there is no
// grounded basis to carve out an exception for it. Per this slice's own
// instructions ("if ambiguity exists, stop and report rather than quietly
// permitting it"), that ambiguity is resolved by rejecting and surfacing a
// clear error naming the offending key path -- never by silently stripping
// the key and continuing, and never by guessing it's safe.

const { isValidUuid, UUID_RE } = require('./high-school-roster-service');
const { sanitizeSyncError } = require('./high-school-importer-contract');

// ── Schema-exact enums (never invent a status value not in the migration) ─
const IMPORT_RUN_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'partial'];
const TRIGGER_KINDS = ['manual', 'scheduled', 'api'];
const SOURCE_PROVIDERS = ['gamechanger'];
const FAILURE_STAGES = ['discovery', 'snapshot_capture', 'reconstruction', 'validation', 'aggregation'];
const DISCOVERY_STATUSES = ['discovered', 'processing', 'processed', 'skipped', 'rejected', 'failed'];
const GAME_OUTCOMES = ['inserted', 'replaced', 'skipped', 'rejected', 'failed'];
const SNAPSHOT_KINDS = ['schedule_discovery', 'game_header', 'box_score', 'play_by_play', 'roster'];
const CONTENT_TYPES = ['json', 'text'];
const SIDES = ['home', 'away'];
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
const VALIDATION_STATUSES = ['pending', 'validated', 'mismatched', 'failed'];

const ERROR_SUMMARY_MAX_LENGTH = 2000; // hs_import_runs_error_summary_length_check

// ── Typed, sanitized errors ───────────────────────────────────────────────
//
// `context` may only ever contain identifiers (run/game/org ids, table
// names, field names) -- never a payload, a header, a token, or a raw
// provider error body. Callers constructing these errors are responsible
// for that; see repository.js's own comment on why it never forwards
// error.details/hint verbatim.
function importError(code, message, { statusCode = 500, retryable = false, context = {} } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.retryable = retryable;
  err.context = context;
  return err;
}

// Reuses UUID_RE/isValidUuid's REGEX contract from high-school-roster-service.js,
// but throws THIS module's own importError shape (stable `.code`, not just
// an HTTP statusCode) rather than that module's typedError -- the two
// modules' error contracts are intentionally different (this one is
// consumed programmatically by a background import job, not translated
// straight into an HTTP response body the way roster-service.js's is), so
// reusing typedError here would silently drop the `.code` this slice's own
// error-handling requirement depends on.
function requireUuid(value, fieldName) {
  if (!isValidUuid(value)) {
    throw importError('INVALID_FIELD', `${fieldName} must be a valid UUID`, { statusCode: 400, context: { field: fieldName } });
  }
  return value;
}

function requireEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw importError('INVALID_ENUM_VALUE', `${fieldName} must be one of: ${allowed.join(', ')}`, {
      statusCode: 400,
      context: { field: fieldName },
    });
  }
  return value;
}

function optionalEnum(value, allowed, fieldName) {
  if (value === undefined || value === null) return null;
  return requireEnum(value, allowed, fieldName);
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw importError('INVALID_FIELD', `${fieldName} is required and must be a non-empty string`, {
      statusCode: 400,
      context: { field: fieldName },
    });
  }
  return value.trim();
}

function optionalString(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw importError('INVALID_FIELD', `${fieldName} must be a string`, { statusCode: 400, context: { field: fieldName } });
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw importError('INVALID_FIELD', `${fieldName} must be a non-negative integer`, {
      statusCode: 400,
      context: { field: fieldName },
    });
  }
  return value;
}

// ── Tenant/hierarchy context ─────────────────────────────────────────────
//
// Every operation in the service/repository requires this shape to be
// supplied explicitly by the caller -- never resolved from an ambient
// "current org" global, never defaulted to "the only organization",
// never inferred. seasonId is the one nullable member (mirrors
// hs_import_runs.season_id/hs_games.season_id -- "season when applicable").
function validateImportContext({ orgId, programId, teamId, seasonId }) {
  requireUuid(orgId, 'orgId');
  requireUuid(programId, 'programId');
  requireUuid(teamId, 'teamId');
  if (seasonId !== undefined && seasonId !== null) requireUuid(seasonId, 'seasonId');
  return { orgId, programId, teamId, seasonId: seasonId ?? null };
}

// ── Recursive credential-key rejection ───────────────────────────────────
//
// Matches this codebase's other credential-scrub convention
// (high-school-importer-contract.js's CREDENTIAL_LIKE_PATTERN) but applied
// to KEYS, not message text, and recursively across the whole payload tree
// -- a raw scraped capture is exactly the kind of object where a stray
// top-level `headers` or nested `session` blob could otherwise slip
// through untouched.
const CREDENTIAL_KEY_MARKERS = [
  'authorization',
  'cookie',
  'token',
  'password',
  'passwd',
  'secret',
  'apikey',
  'servicerole',
  'bearer',
  'sessionstate',
  'storagestate',
  'localstorage',
  'sessionstorage',
];

// Guards against pathological/adversarial nesting depth in externally
// captured data -- not a realistic baseball payload shape, but cheap to
// bound defensively before recursing into caller-supplied JSON.
const MAX_SCAN_DEPTH = 25;

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isCredentialLikeKey(key) {
  const normalized = normalizedKey(key);
  return CREDENTIAL_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

// Throws importError('CREDENTIAL_LIKE_KEY_REJECTED', ...) naming the
// offending key PATH (e.g. "boxScore.batting[2].authToken") -- never the
// value at that path, which might be the very secret being rejected.
function assertNoCredentialLikeKeys(value, path = '$', depth = 0) {
  if (depth > MAX_SCAN_DEPTH) {
    throw importError('PAYLOAD_TOO_DEEPLY_NESTED', `Payload exceeds maximum nesting depth (${MAX_SCAN_DEPTH}) at ${path}`, {
      statusCode: 400,
      context: { path },
    });
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialLikeKeys(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (isCredentialLikeKey(key)) {
        throw importError('CREDENTIAL_LIKE_KEY_REJECTED', `Payload key "${key}" at ${path}.${key} resembles a credential/session field and was rejected`, {
          statusCode: 400,
          context: { path: `${path}.${key}` },
        });
      }
      assertNoCredentialLikeKeys(value[key], `${path}.${key}`, depth + 1);
    }
  }
}

function assertJsonSerializable(value, fieldName) {
  if (value === undefined || typeof value === 'function') {
    throw importError('INVALID_FIELD', `${fieldName} must be JSON-serializable`, { statusCode: 400, context: { field: fieldName } });
  }
  try {
    JSON.stringify(value);
  } catch {
    throw importError('INVALID_FIELD', `${fieldName} must be JSON-serializable (no circular references)`, {
      statusCode: 400,
      context: { field: fieldName },
    });
  }
}

// error_summary is nullable + <=2000 chars (hs_import_runs); reused as-is
// rather than reimplemented -- see header comment.
function sanitizeErrorMessage(rawMessage) {
  return sanitizeSyncError(rawMessage);
}

module.exports = {
  UUID_RE,
  isValidUuid,
  requireUuid,
  IMPORT_RUN_STATUSES,
  TRIGGER_KINDS,
  SOURCE_PROVIDERS,
  FAILURE_STAGES,
  DISCOVERY_STATUSES,
  GAME_OUTCOMES,
  SNAPSHOT_KINDS,
  CONTENT_TYPES,
  SIDES,
  CONFIDENCE_LEVELS,
  VALIDATION_STATUSES,
  ERROR_SUMMARY_MAX_LENGTH,
  CREDENTIAL_KEY_MARKERS,
  importError,
  requireEnum,
  optionalEnum,
  requireNonEmptyString,
  optionalString,
  requireNonNegativeInteger,
  validateImportContext,
  isCredentialLikeKey,
  assertNoCredentialLikeKeys,
  assertJsonSerializable,
  sanitizeErrorMessage,
};
