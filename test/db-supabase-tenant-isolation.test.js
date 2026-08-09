'use strict';

// Security Slice T2: focused tests proving src/db-supabase.js's team
// resolution/upsert path (resolveOrgIdForTeamUpsert, applyOrgScope,
// findExistingTeam, upsertTeam) fails closed without an organization and
// never matches a same-named team belonging to a different organization
// -- the confirmed defect from security/travel-tenant-isolation-write-path
// (Slice T1's reproduction matrix, cases D-I).
//
// The REAL src/db-supabase.js module is exercised (not reimplemented) --
// only the @supabase/supabase-js client it constructs is replaced, via
// require.cache injection (the same technique test/pipeline-diagnostic-
// logging.test.js already uses for ./db and ./stats-engine), with a
// small local fake tailored to exactly the query shape upsertTeam/
// findExistingTeam actually issues against the `teams` table
// (.ilike/.eq/.order/.limit/.select/.insert/.update). This fake is
// intentionally local to this file rather than added to
// test/helpers/fake-supabase-client.js, which is documented as scoped to
// the High School import repository's own table/query shapes.
//
// This fake models NO row-level security at all -- every query it
// receives is answered in full, exactly like a real service-role
// connection. That is deliberate: it proves the isolation this suite
// checks for comes from the application code (db-supabase.js) rejecting
// or scoping the query itself, never from a database-side policy the
// service-role client bypasses anyway.
//
// Run with: node --test test/db-supabase-tenant-isolation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const SUPABASE_JS_PATH = require.resolve('@supabase/supabase-js');
const DB_SUPABASE_PATH = require.resolve('../src/db-supabase');
const DB_SUPABASE_SRC_PATH = require('path').join(__dirname, '..', 'src', 'db-supabase.js');

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

class FakeTeamsQuery {
  constructor(state) {
    this.state = state;
    this.filters = [];
    this.op = 'select';
    this.payload = null;
    this.singleMode = false;
  }
  select() { return this; }
  ilike(col, val) { this.filters.push({ col, val: String(val).toLowerCase(), type: 'ilike' }); return this; }
  eq(col, val) { this.filters.push({ col, val, type: 'eq' }); return this; }
  order() { return this; }
  limit(n) { this._limit = n; return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  single() { this.singleMode = true; return this; }
  _matches(row) {
    return this.filters.every((f) => {
      if (f.type === 'ilike') return String(row[f.col] || '').toLowerCase() === f.val;
      return row[f.col] === f.val;
    });
  }
  then(resolve, reject) {
    return Promise.resolve(this._exec()).then(resolve, reject);
  }
  _exec() {
    if (this.op === 'insert') {
      const row = { id: nextId(), ...this.payload };
      this.state.teams.push(row);
      return this.singleMode ? { data: row, error: null } : { data: [row], error: null };
    }
    if (this.op === 'update') {
      const matches = this.state.teams.filter((r) => this._matches(r));
      for (const row of matches) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    let rows = this.state.teams.filter((r) => this._matches(r));
    if (typeof this._limit === 'number') rows = rows.slice(0, this._limit);
    return { data: rows, error: null };
  }
}

function createFakeTeamsClient(state) {
  return {
    from(table) {
      if (table !== 'teams') throw new Error(`fake client: unexpected table "${table}" (this test only models "teams")`);
      return new FakeTeamsQuery(state);
    },
  };
}

// Requires the REAL src/db-supabase.js fresh, with its internal
// @supabase/supabase-js client swapped for the fake above. Returns the
// module plus the shared in-memory `state` so a test can seed rows
// directly and inspect them afterward.
function withFreshDbSupabase(fn) {
  const state = { teams: [] };
  const fakeClient = createFakeTeamsClient(state);

  const originalSupabaseJsEntry = require.cache[SUPABASE_JS_PATH];
  require.cache[SUPABASE_JS_PATH] = {
    id: SUPABASE_JS_PATH,
    filename: SUPABASE_JS_PATH,
    loaded: true,
    exports: { createClient: () => fakeClient },
  };

  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key-for-tests';

  delete require.cache[DB_SUPABASE_PATH];
  const dbSupabase = require('../src/db-supabase');
  dbSupabase.init();

  return Promise.resolve()
    .then(() => fn(dbSupabase, state))
    .finally(() => {
      if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
      if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
      if (originalSupabaseJsEntry) require.cache[SUPABASE_JS_PATH] = originalSupabaseJsEntry;
      else delete require.cache[SUPABASE_JS_PATH];
      delete require.cache[DB_SUPABASE_PATH];
    });
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function syntheticTeam(overrides = {}) {
  return {
    teamName: 'Synthetic Tigers',
    age: '14U',
    seasonYear: 2026,
    city: 'Testville',
    state: 'TS',
    ...overrides,
  };
}

// ── Source-level regression: the removed fallback must never reappear ───────

test('getSingleOrgIdFallback is no longer defined or called anywhere in src/db-supabase.js ' +
     '(a historical mention in an explanatory comment is fine; a live function/call is not)', () => {
  const fs = require('fs');
  const source = fs.readFileSync(DB_SUPABASE_SRC_PATH, 'utf8');
  assert.doesNotMatch(source, /function getSingleOrgIdFallback/, 'the function definition must be removed');
  assert.doesNotMatch(source, /getSingleOrgIdFallback\s*\(\s*\)/, 'no call site may remain');
});

test('db-supabase.js does not export getSingleOrgIdFallback', () => {
  return withFreshDbSupabase((dbSupabase) => {
    assert.equal(dbSupabase.getSingleOrgIdFallback, undefined);
  });
});

// ── resolveOrgIdForTeamUpsert / applyOrgScope: fail closed ──────────────────

test('resolveOrgIdForTeamUpsert: throws OrgContextRequiredError when team.orgId is absent, ' +
     'even though exactly one organization exists in the fake store (no "only one org" inference)', () => {
  return withFreshDbSupabase(async (dbSupabase) => {
    await assert.rejects(
      () => dbSupabase.upsertTeam(syntheticTeam()),
      (err) => {
        assert.equal(err.name, 'OrgContextRequiredError');
        assert.match(err.message, /orgId/);
        return true;
      }
    );
  });
});

test('resolveOrgIdForTeamUpsert: throws when team.orgId is blank/whitespace', () => {
  return withFreshDbSupabase(async (dbSupabase) => {
    await assert.rejects(() => dbSupabase.upsertTeam(syntheticTeam({ orgId: '   ' })), /OrgContextRequiredError|orgId/);
  });
});

test('Case E (T1 trace): missing orgId, no matching team anywhere -- fails closed, no team is created', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await assert.rejects(() => dbSupabase.upsertTeam(syntheticTeam()));
    assert.equal(state.teams.length, 0, 'no team row may be created without an organization');
  });
});

// ── Case A/B: explicit orgId behaves correctly (new team, then match) ───────

test('Case A: explicit valid orgId, no matching team -- creates a new team under that organization', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    assert.equal(state.teams.length, 1);
    assert.equal(state.teams[0].id, teamId);
    assert.equal(state.teams[0].org_id, ORG_A);
  });
});

test('Case B: explicit valid orgId, matching team in the SAME organization -- updates it, returns its id', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const firstId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, city: 'OldCity' }));
    const secondId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, city: 'NewCity' }));
    assert.equal(secondId, firstId, 'the same team row must be reused, not duplicated');
    assert.equal(state.teams.length, 1);
    assert.equal(state.teams[0].city, 'NewCity', 'the update must actually apply');
    assert.equal(state.teams[0].org_id, ORG_A, 'org_id must remain correct after update');
  });
});

// ── Case C/F/G (the confirmed defect this PR closes): cross-org isolation ───

test('Case C: explicit valid orgId -- a same-named team that exists in a DIFFERENT organization is never matched', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B }));

    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));

    assert.notEqual(orgATeamId, orgBTeamId, 'org A must get its own team row, never org B\'s');
    assert.equal(state.teams.length, 2);
    const orgBRow = state.teams.find((t) => t.id === orgBTeamId);
    assert.equal(orgBRow.org_id, ORG_B, 'org B\'s team must be completely untouched');
    assert.equal(orgBRow.city, 'Testville', 'org B\'s team fields must be completely untouched');
  });
});

test('Case F (the confirmed defect): missing orgId with a same-named team already existing in one organization -- ' +
     'fails closed rather than silently reusing that organization\'s team', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, city: 'OriginalCity' }));

    await assert.rejects(
      () => dbSupabase.upsertTeam(syntheticTeam({ city: 'AttackerSuppliedCity' })), // no orgId
      (err) => { assert.equal(err.name, 'OrgContextRequiredError'); return true; }
    );

    assert.equal(state.teams.length, 1, 'no new team may have been created either');
    const orgBRow = state.teams.find((t) => t.id === orgBTeamId);
    assert.equal(orgBRow.city, 'OriginalCity', 'org B\'s team must never be overwritten by an org-less caller');
    assert.equal(orgBRow.org_id, ORG_B);
  });
});

test('Case G (T1 trace): missing orgId with identical team attributes in TWO organizations -- still fails closed for both', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B }));

    await assert.rejects(() => dbSupabase.upsertTeam(syntheticTeam()), (err) => {
      assert.equal(err.name, 'OrgContextRequiredError');
      return true;
    });

    assert.equal(state.teams.length, 2, 'neither existing team may have been touched');
  });
});

// ── Service-role bypass proof ────────────────────────────────────────────────

test('service-role access cannot bypass the application scope requirement: the fake client answers ' +
     'ANY query unscoped (models no RLS at all), yet upsertTeam still refuses to run one without orgId', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    state.teams.push({ id: nextId(), org_id: ORG_B, team_name: 'Synthetic Tigers', age_group: '14U', season_year: 2026 });
    // Proves the fake itself has no isolation of its own -- an unscoped
    // select would trivially return org B's row if db-supabase.js ever
    // issued one.
    const unscoped = await new FakeTeamsQuery(state).select()._exec();
    assert.equal(unscoped.data.length, 1, 'sanity check: the fake client itself enforces nothing');

    await assert.rejects(() => dbSupabase.upsertTeam(syntheticTeam()), /OrgContextRequiredError|orgId/);
  });
});
