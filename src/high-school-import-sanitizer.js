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

function optionalUuid(value, fieldName) {
  if (value === undefined || value === null) return null;
  return requireUuid(value, fieldName);
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

// ── Canonical JSON sanitization + recursive credential scan ─────────────
//
// sanitizeJsonPayload replaces two earlier, separately-implemented checks
// (a JSON.stringify-serializability probe and a key-name-only recursive
// scan run against the ORIGINAL object) with a single walk that produces
// the value ACTUALLY persisted, so "what was validated" and "what gets
// written to jsonb" can never diverge. That divergence was a real,
// exploitable gap in the earlier version:
//   - a `toJSON()` method can make JSON.stringify (and therefore
//     PostgREST) serialize an entirely different shape than the one whose
//     keys were scanned -- e.g. `{ toJSON() { return { authorization: 'x' }; } }`
//     has no credential-shaped OWN key, but stringifies to one;
//   - a getter (accessor property) executes arbitrary caller code the
//     instant it is read; a getter that throws would previously leak its
//     own, unsanitized error message straight out of this function;
//   - NaN/Infinity/-Infinity silently become `null` under JSON.stringify
//     without ever throwing, so the old "does JSON.stringify throw" probe
//     never caught them;
//   - `undefined` object values are silently DROPPED by JSON.stringify,
//     and sparse array holes silently become `null` -- both look like
//     "successfully validated" under the old check while actually
//     changing shape at persistence time;
//   - a non-plain object (Date, Map, class instance, Proxy) can carry
//     hidden state or behavior JSON.stringify does not faithfully expose.
//
// This function rejects every one of the above outright rather than
// tolerating, coercing, or silently dropping them, and returns a brand
// new plain object/array tree (the canonical clone) built ONLY from
// already-validated primitive/plain-object/array values -- that returned
// clone, not the caller's original value, is what every call site below
// actually persists.
//
// Accessor properties are detected via Object.getOwnPropertyDescriptor
// and rejected WITHOUT EVER INVOKING THE GETTER -- a hostile getter can
// therefore never execute, let alone throw an error this function would
// have to (and might fail to) sanitize before it escapes.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeJsonValue(value, fieldName, path, depth) {
  if (depth > MAX_SCAN_DEPTH) {
    throw importError('PAYLOAD_TOO_DEEPLY_NESTED', `${fieldName} exceeds maximum nesting depth (${MAX_SCAN_DEPTH}) at ${path}`, {
      statusCode: 400,
      context: { field: fieldName, path },
    });
  }

  if (value === null) return null;
  const type = typeof value;

  if (type === 'string' || type === 'boolean') return value;

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw importError('INVALID_FIELD', `${fieldName} contains a non-finite number (NaN/Infinity) at ${path}`, { statusCode: 400, context: { field: fieldName, path } });
    }
    return value;
  }

  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw importError('INVALID_FIELD', `${fieldName} contains a non-JSON-safe ${type === 'undefined' ? 'undefined value' : type} at ${path}`, {
      statusCode: 400,
      context: { field: fieldName, path },
    });
  }

  // type === 'object' from here.
  if (Array.isArray(value)) {
    // Sparse-array guard: a hole (missing index) is not the same as an
    // explicit null, and JSON.stringify would silently convert it to one.
    if (Object.keys(value).length !== value.length) {
      throw importError('INVALID_FIELD', `${fieldName} contains a sparse array at ${path}`, { statusCode: 400, context: { field: fieldName, path } });
    }
    return value.map((item, index) => sanitizeJsonValue(item, fieldName, `${path}[${index}]`, depth + 1));
  }

  if (!isPlainObject(value)) {
    throw importError('INVALID_FIELD', `${fieldName} contains a non-plain object (custom prototype, Date, Map, etc.) at ${path}`, {
      statusCode: 400,
      context: { field: fieldName, path },
    });
  }

  if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
    throw importError('INVALID_FIELD', `${fieldName} contains a toJSON property at ${path}, which could change the persisted shape after this validation ran`, {
      statusCode: 400,
      context: { field: fieldName, path },
    });
  }

  const clone = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor.get || descriptor.set) {
      // Rejected WITHOUT reading descriptor.value -- an accessor's getter
      // is never invoked, so it can never execute or throw here.
      throw importError('INVALID_FIELD', `${fieldName} contains an accessor property "${key}" at ${path}.${key}, which is not a plain JSON value`, {
        statusCode: 400,
        context: { field: fieldName, path: `${path}.${key}` },
      });
    }
    if (isCredentialLikeKey(key)) {
      throw importError('CREDENTIAL_LIKE_KEY_REJECTED', `${fieldName} key "${key}" at ${path}.${key} resembles a credential/session field and was rejected`, {
        statusCode: 400,
        context: { field: fieldName, path: `${path}.${key}` },
      });
    }
    clone[key] = sanitizeJsonValue(descriptor.value, fieldName, `${path}.${key}`, depth + 1);
  }
  return clone;
}

// Every call site below must persist the RETURNED value, never the
// original -- that is what makes "validated" and "persisted" the same
// representation. Any unexpected internal error is itself re-wrapped so
// this function can never leak a raw, unsanitized message (defense in
// depth on top of the getter-avoidance above).
function sanitizeJsonPayload(value, fieldName) {
  try {
    return sanitizeJsonValue(value, fieldName, '$', 0);
  } catch (err) {
    if (err && err.code) throw err;
    throw importError('INVALID_FIELD', `${fieldName} could not be validated as a safe JSON value`, { statusCode: 400, context: { field: fieldName } });
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
  optionalUuid,
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
  sanitizeJsonPayload,
  sanitizeErrorMessage,
};
