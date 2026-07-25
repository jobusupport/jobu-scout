'use strict';

// Documents the FUTURE High School GameChanger roster importer's matching
// and reconciliation behavior as pure, database-free functions. No network
// request, no Playwright browser, no Supabase call, and no write of any
// kind happens anywhere in this file -- it defines what a real importer
// (not built here) must do, in a form that is directly unit-testable.
//
// ── Why this exists as a separate module ────────────────────────────────
// supabase/migrations/20260724221500_create_high_school_domain.sql adds
// the schema columns (record_source, gc_external_player_id,
// normalized_first_name/last_name, gc_match_status, roster_sync_*) this
// logic operates on. This file is the algorithm that will eventually
// consume real scraped data and call the real database -- kept separate
// and pure specifically so its matching/reconciliation DECISIONS can be
// proven correct before any scraper or API route exists to drive it, the
// same way src/product-resolution.js's resolveActiveProduct is proven
// correct independent of the Express routes that eventually call it.
//
// ── Grounding in existing GameChanger scraping behavior ─────────────────
// This is not invented from scratch. It deliberately mirrors two things
// already proven out elsewhere in this codebase:
//   1. src/scrape-handedness.js's buildMatchKey/jersey_number-first
//      identity strategy for the SAME "match a re-scraped roster against
//      what's already stored" problem in the Travel domain -- see that
//      file's own doc comment acknowledging same-name collisions as an
//      accepted risk, resolved by preferring jersey number as the
//      stronger signal.
//   2. src/db-supabase.js's NULL-uniqueness caveat for jersey-number-based
//      matching (a player with no jersey number can't be matched against
//      itself via a NULL-including key) -- the candidate-matching
//      functions below account for this by falling back to name-only
//      matching when jersey number is absent, rather than assuming it's
//      always present.
//
// ── The future importer, end to end (documented, not implemented) ──────
//   1. Resolve the effective organization via the same trusted middleware
//      chain every other route uses (requireAuth -> resolveSupportSession
//      -> requireHighSchoolAccess) -- never a client-supplied org id.
//   2. Resolve the specific tenant-owned hs_teams / hs_seasons rows the
//      import targets (existence + ownership check, identical to
//      src/high-school-api.js's existing pattern) -- never trust a
//      client-supplied team/season id without that check.
//   3. Scrape/fetch the GameChanger roster for that team (reusing the
//      existing storage/gamechanger-auth.json Playwright session --
//      credentials never touch the database, see the migration's own
//      header comment).
//   4. For each incoming roster entry, call matchPlayerCandidates (below)
//      against the program's existing hs_players to decide: reuse an
//      existing player, create a new one, or flag ambiguity for later
//      review -- NEVER auto-merge an ambiguous match.
//   5. Call planRosterReconciliation (below) to decide which
//      hs_roster_memberships rows to upsert (create/update, refreshing
//      jersey_number and last_observed_at) versus mark inactive (never
//      delete -- historical membership is preserved by construction).
//   6. Apply resolveFieldConflict's policy (below) before writing any
//      field a human may have manually corrected.
//   7. Persist a SANITIZED status/error string only (see
//      sanitizeSyncError below) to hs_teams.roster_sync_error -- never a
//      raw error object, stack trace, or scraped HTML.
//
// Still to be built (explicitly NOT in this file or this PR): the actual
// GameChanger scraping code for High School rosters, the Supabase calls
// that execute the plans these functions produce, any API route, any
// background job, and any UI.

const KNOWN_RECORD_SOURCES = ['manual', 'gamechanger'];
const KNOWN_GC_MATCH_STATUSES = ['confirmed', 'ambiguous'];

function normalizeNamePart(value) {
  return String(value || '').toLowerCase().trim();
}

// ── Candidate matching ──────────────────────────────────────────────────
//
// `existingPlayers`: hs_players-shaped rows already in this program
//   ({ id, normalizedFirstName, normalizedLastName }).
// `incoming`: one roster entry from the scraper
//   ({ firstName, lastName, jerseyNumber, gcExternalPlayerId }).
// `priorGcLinkedPlayerId`: if a PREVIOUS hs_roster_memberships row for
//   this exact team+season already recorded a gc_external_player_id equal
//   to incoming.gcExternalPlayerId, this is that membership's player_id --
//   the strongest possible match signal, resolved by the caller via a
//   single indexed lookup (idx_hs_roster_memberships_team_season_gc_player)
//   before calling this function, not by this function itself (this
//   function stays database-free).
//
// Returns exactly one of:
//   { outcome: 'matched', playerId }               -- safe to reuse
//   { outcome: 'create' }                           -- no safe match exists
//   { outcome: 'ambiguous', candidatePlayerIds }     -- never auto-resolved
function matchPlayerCandidates({ existingPlayers, incoming, priorGcLinkedPlayerId = null }) {
  if (priorGcLinkedPlayerId) {
    // A real GameChanger-issued id, previously observed on THIS team in
    // THIS season, is the strongest signal this schema supports -- see
    // the migration's header comment for why it's scoped this narrowly.
    return { outcome: 'matched', playerId: priorGcLinkedPlayerId };
  }

  const normFirst = normalizeNamePart(incoming?.firstName);
  const normLast = normalizeNamePart(incoming?.lastName);
  // An incoming entry with no usable name is malformed roster data, not a
  // legitimate zero-information player -- fails safely to 'create' rather
  // than risking a false match against another row whose normalized name
  // also happens to be empty (e.g. a prior malformed row).
  if (!normFirst || !normLast) return { outcome: 'create' };

  const nameMatches = (existingPlayers || []).filter(
    (p) => p.normalizedFirstName === normFirst && p.normalizedLastName === normLast
  );

  if (nameMatches.length === 0) return { outcome: 'create' };
  if (nameMatches.length === 1) return { outcome: 'matched', playerId: nameMatches[0].id };

  // Two or more existing players share this normalized name. Jersey
  // number alone is NOT used to break this tie automatically -- a
  // matching jersey number on a re-scrape is suggestive, not proof (the
  // same number can be reassigned across seasons), so ambiguity is
  // reported rather than silently resolved, per the required policy.
  return { outcome: 'ambiguous', candidatePlayerIds: nameMatches.map((p) => p.id) };
}

// ── Roster reconciliation ────────────────────────────────────────────────
//
// `existingMemberships`: current hs_roster_memberships rows for one
//   team+season ({ id, playerId, jerseyNumber, status, recordSource }).
// `resolvedIncoming`: one entry per scraped roster row, each already
//   run through matchPlayerCandidates and resolved to a concrete
//   playerId (ambiguous entries are the caller's responsibility to
//   exclude or resolve before calling this function -- never passed
//   through as a create/update action).
//
// Returns a plan, never mutates anything:
//   {
//     toCreate:   [{ playerId, jerseyNumber, gcExternalPlayerId }],
//     toUpdate:   [{ membershipId, jerseyNumber, gcExternalPlayerId }],
//     toDeactivate: [membershipId, ...],
//   }
//
// Membership rows never appear in a "delete" list -- deactivation is
// always an update to status='inactive', preserving history by
// construction (matches the migration's documented reconciliation
// strategy).
function planRosterReconciliation({ existingMemberships, resolvedIncoming }) {
  const existingByPlayerId = new Map((existingMemberships || []).map((m) => [m.playerId, m]));
  const seenPlayerIds = new Set();

  const toCreate = [];
  const toUpdate = [];

  for (const entry of resolvedIncoming || []) {
    seenPlayerIds.add(entry.playerId);
    const existing = existingByPlayerId.get(entry.playerId);
    if (!existing) {
      toCreate.push({ playerId: entry.playerId, jerseyNumber: entry.jerseyNumber ?? null, gcExternalPlayerId: entry.gcExternalPlayerId ?? null });
      continue;
    }
    // A manually-corrected membership's jersey number is not silently
    // overwritten by an import -- see resolveFieldConflict for the
    // general policy this specific case follows.
    const jerseyDecision = resolveFieldConflict({
      existingValue: existing.jerseyNumber,
      importedValue: entry.jerseyNumber ?? null,
      fieldRecordSource: existing.recordSource,
    });
    toUpdate.push({
      membershipId: existing.id,
      jerseyNumber: jerseyDecision.value,
      gcExternalPlayerId: entry.gcExternalPlayerId ?? existing.gcExternalPlayerId ?? null,
    });
  }

  const toDeactivate = (existingMemberships || [])
    .filter((m) => m.status === 'active' && !seenPlayerIds.has(m.playerId))
    .map((m) => m.id);

  return { toCreate, toUpdate, toDeactivate };
}

// ── Field-level conflict policy ──────────────────────────────────────────
//
// The safe initial policy (per the required design):
//   - a field currently owned by an imported (gamechanger) record may be
//     refreshed by a new import;
//   - a field on a MANUALLY corrected record is never silently overwritten
//     by an import.
//
// fieldRecordSource is the OWNING record's record_source (e.g. the
// membership's own record_source column, already added by the migration)
// -- this is the minimum schema support the migration adds for this
// policy; no separate per-field ownership table exists, and none is
// needed for this initial policy (a future slice could introduce
// per-field provenance if a single record-level source proves too coarse
// once the real importer is built).
function resolveFieldConflict({ existingValue, importedValue, fieldRecordSource }) {
  if (fieldRecordSource === 'manual') {
    return { value: existingValue, overwritten: false };
  }
  return { value: importedValue, overwritten: importedValue !== existingValue };
}

// ── Sanitization ──────────────────────────────────────────────────────────
//
// Bounds and strips anything resembling a credential/token/cookie/session
// artifact before a sync failure reason is ever persisted to
// hs_teams.roster_sync_error or returned from an API response -- mirrors
// the existing sendResolverError convention of never forwarding a raw
// error to a client, applied here at write time instead of response time.
const CREDENTIAL_LIKE_PATTERN = /(authorization|bearer|cookie|token|session|password|secret|api[\s_-]?key)/i;

function sanitizeSyncError(rawMessage) {
  const message = String(rawMessage || '').trim();
  if (!message) return null;
  const scrubbed = CREDENTIAL_LIKE_PATTERN.test(message)
    ? 'Sync failed (details withheld: message resembled credential/session data).'
    : message;
  return scrubbed.length > 2000 ? scrubbed.slice(0, 1997) + '...' : scrubbed;
}

function isKnownRecordSource(value) {
  return KNOWN_RECORD_SOURCES.includes(value);
}

function isKnownGcMatchStatus(value) {
  return value === null || value === undefined || KNOWN_GC_MATCH_STATUSES.includes(value);
}

module.exports = {
  KNOWN_RECORD_SOURCES,
  KNOWN_GC_MATCH_STATUSES,
  normalizeNamePart,
  matchPlayerCandidates,
  planRosterReconciliation,
  resolveFieldConflict,
  sanitizeSyncError,
  isKnownRecordSource,
  isKnownGcMatchStatus,
};
