'use strict';

// A tiny, purpose-built fake of the subset of the Supabase query-builder
// surface src/high-school-roster-service.js's getTeamInOrg/getSeasonInOrg
// and src/high-school-import-routes.js's own hs_teams/hs_roster_memberships
// queries actually use (.from/.select/.eq/.update/.maybeSingle). Scoped to
// this test file's own needs only -- NOT a general-purpose Supabase mock,
// and deliberately not the shared test/helpers/fake-supabase-client.js
// (that fake's job is modeling the Slice 1A persistence layer's own
// constraint/uniqueness semantics for high-school-import-repository.test.js;
// this one's job is letting the HTTP ROUTE layer be exercised for real
// without a live database, for exactly the two upstream tables
// (hs_teams, hs_roster_memberships) the routes/roster-service touch
// directly).
function createFakeHsImportAdminClient(seed = {}) {
  const tables = {
    hs_teams: [...(seed.hs_teams || [])],
    hs_seasons: [...(seed.hs_seasons || [])],
    hs_roster_memberships: [...(seed.hs_roster_memberships || [])],
  };

  function matches(row, filters) {
    return filters.every(([col, val]) => row[col] === val);
  }

  function from(table) {
    const filters = [];
    let pendingUpdate = null;
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push([col, val]); return builder; },
      update(patch) { pendingUpdate = patch; return builder; },
      async maybeSingle() {
        const rows = tables[table] || [];
        const found = rows.find((r) => matches(r, filters));
        if (pendingUpdate) {
          if (!found) return { data: null, error: null };
          if (pendingUpdate.gc_team_url) {
            const conflict = rows.find(
              (r) => r !== found && r.org_id === found.org_id && r.gc_team_url === pendingUpdate.gc_team_url
            );
            if (conflict) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          Object.assign(found, pendingUpdate);
          return { data: { ...found }, error: null };
        }
        return { data: found ? { ...found } : null, error: null };
      },
      async single() {
        const result = await builder.maybeSingle();
        if (!result.data) return { data: null, error: { message: 'no rows found' } };
        return result;
      },
      then(resolve, reject) {
        // Support `await adminClient.from(...).select().eq().eq()` (no
        // terminal .maybeSingle()/.single()) resolving to a { data, error }
        // array-shaped result, matching loadActiveRosterForReconciliation's
        // own usage in src/high-school-import-routes.js.
        const rows = (tables[table] || []).filter((r) => matches(r, filters));
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return { from, __tables: tables };
}

module.exports = { createFakeHsImportAdminClient };
