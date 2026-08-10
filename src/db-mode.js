'use strict';

/**
 * db-mode.js
 * Security Slice T3F — the single authoritative decision of which
 * repository implementation (Supabase vs. local SQLite) a process may
 * use.
 *
 * Before this slice, src/db.js and server.js each independently computed
 * "should this process use Supabase?" from USE_SUPABASE/SUPABASE_URL/
 * SUPABASE_SERVICE_ROLE_KEY, and both formulas resolved to SQLite whenever
 * USE_SUPABASE was missing, blank, or anything other than the literal
 * string "true" -- including in production. A hosted process that lost or
 * never received USE_SUPABASE (a Railway config drift, a blank env var, a
 * typo like "ture") would silently start serving live HTTP traffic against
 * the local, single-tenant SQLite file instead of refusing to start. Every
 * SQLite query in server.js's routes has no org_id column to filter on at
 * all, so this was a complete cross-tenant data exposure, not a degraded
 * mode.
 *
 * resolveDatabaseMode() closes that gap: in production (NODE_ENV=production
 * -- the same signal src/db.js and server.js already used for this exact
 * purpose before this slice, not a new heuristic), USE_SUPABASE must be
 * the explicit, strictly-parsed string "true" and SUPABASE_URL /
 * SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must all be present and
 * non-blank, or this throws before any repository is touched. Outside
 * production the pre-existing default (SQLite unless USE_SUPABASE=true) is
 * unchanged -- local development and tests are not required to set
 * anything new.
 */

// Thrown for any invalid/insufficient database-mode configuration. Never
// includes a secret value -- only which configuration category was
// invalid (e.g. "SUPABASE_URL is missing"), matching the
// OrgContextRequiredError convention in src/org-context-errors.js of
// naming the missing contract, not echoing untrusted input back.
class DatabaseModeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseModeConfigError';
  }
}

const REQUIRED_SUPABASE_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];

// Strict, centralized boolean parsing for USE_SUPABASE -- "true" or
// "false" only (case-insensitive, surrounding whitespace ignored).
// Anything else, including JS-truthy strings like "1", "yes", or "TRUE "
// with trailing garbage, is treated as malformed rather than silently
// coerced -- a typo must never be interpreted as either value. Blank/unset
// is reported as "absent" (not malformed), since non-production callers
// are allowed to apply their own default for that case.
function parseUseSupabaseFlag(raw) {
  if (raw === undefined || raw === null) return { present: false, value: undefined };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { present: false, value: undefined };
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return { present: true, value: true };
  if (lower === 'false') return { present: true, value: false };
  throw new DatabaseModeConfigError(
    'USE_SUPABASE has an unrecognized value. It must be exactly "true" or "false" ' +
    '(case-insensitive, whitespace-trimmed) -- refusing to guess.'
  );
}

function isProductionEnv(env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

/**
 * Resolves which repository implementation this process may use.
 * Returns 'supabase' or 'sqlite'. Throws DatabaseModeConfigError (never
 * caught here -- an uncaught throw at process startup exits non-zero,
 * matching every other fail-closed contract in this codebase, e.g.
 * src/job-org-context.js#requireJobOrgContext) when production
 * configuration is missing, blank, or malformed.
 *
 * `env` is injectable (defaults to the real process.env) purely so tests
 * can exercise this without mutating global process state.
 */
function resolveDatabaseMode(env = process.env) {
  const production = isProductionEnv(env);
  const flag = parseUseSupabaseFlag(env.USE_SUPABASE);

  if (production) {
    if (!flag.present || flag.value !== true) {
      throw new DatabaseModeConfigError(
        'Refusing to start: NODE_ENV=production requires USE_SUPABASE=true to be set explicitly. ' +
        'Production must never silently fall back to the local SQLite repository -- there is no ' +
        'default here. Set USE_SUPABASE=true (and the required Supabase configuration) explicitly.'
      );
    }

    const missing = REQUIRED_SUPABASE_ENV_VARS.filter((name) => !String(env[name] || '').trim());
    if (missing.length) {
      throw new DatabaseModeConfigError(
        'Refusing to start: USE_SUPABASE=true in production but required Supabase configuration is ' +
        `missing or blank: ${missing.join(', ')}. Production must never fall back to SQLite when ` +
        'Supabase configuration is incomplete.'
      );
    }

    return 'supabase';
  }

  // Non-production (local development, tests, CI, trusted operator CLI
  // runs): an explicit flag always wins. Absent, the pre-existing default
  // applies -- SQLite -- unchanged from before this slice.
  if (flag.present) return flag.value ? 'supabase' : 'sqlite';
  return 'sqlite';
}

module.exports = {
  resolveDatabaseMode,
  parseUseSupabaseFlag,
  isProductionEnv,
  DatabaseModeConfigError,
  REQUIRED_SUPABASE_ENV_VARS,
};
