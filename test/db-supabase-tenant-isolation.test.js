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
// Security Slice T3C additions (bottom of file): the same fake/helpers
// also exercise listTeamsForOrg -- the tenant-scoped counterpart to
// getAllTeams() the automated GameChanger reingestion job now uses for
// team discovery -- proving the same fail-closed, no-cross-org-leakage
// contract for a read path, not just the write path Slice T2 covered.
// The collision-matching and log-formatting tests call the REAL
// src/reingest-helpers.js#findMatchingTeam/formatTeamSummaryLine --
// the same functions reingest-games.js itself calls -- rather than
// re-typing that logic into the test, so a future change to either
// function's actual behavior cannot silently go unproven here.
//
// Run with: node --test test/db-supabase-tenant-isolation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { findMatchingTeam, formatTeamSummaryLine } = require('../src/reingest-helpers');
const { resolveTeamMatch, formatTeamListLine, formatAmbiguousMatchLine, runTeamsSequentially } = require('../src/report-team-selection');

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
  // Real Supabase collapses to a single object or null (never an array,
  // never an error for zero rows) -- distinct from .single(), which errors
  // on zero rows. T3G's ownership-check queries rely on exactly this
  // "null means not found, not an error" collapsing behavior.
  maybeSingle() { this.maybeSingleMode = true; return this; }
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
      // `archived` defaults to false at the real schema level (NOT NULL
      // DEFAULT false) even though upsertTeam's insert payload never sets
      // it explicitly -- mirrored here so listTeamsForOrg's default
      // archived-exclusion filter behaves the same against this fake as
      // it does against a real row.
      const row = { id: nextId(), archived: false, ...this.payload };
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
    if (this.maybeSingleMode) return { data: rows[0] || null, error: null };
    if (this.singleMode) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }
}

// Security Slice T3G: models team_game_urls alongside teams -- just enough
// query surface (.eq/.order/.select/.update) for
// getGameUrlsForTeamInOrg/markGameUrlProcessedForOrg to exercise against,
// same no-RLS-modeled philosophy as FakeTeamsQuery above (isolation must
// come from db-supabase.js's own org_id/team_id scoping, never a
// database-side policy a service-role connection would bypass anyway).
class FakeGameUrlsQuery {
  constructor(state) {
    this.state = state;
    this.filters = [];
    this.op = 'select';
    this.payload = null;
  }
  select() { return this; }
  eq(col, val) { this.filters.push({ col, val }); return this; }
  order() { return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  _matches(row) { return this.filters.every((f) => row[f.col] === f.val); }
  then(resolve, reject) {
    return Promise.resolve(this._exec()).then(resolve, reject);
  }
  _exec() {
    const matches = this.state.gameUrls.filter((r) => this._matches(r));
    if (this.op === 'update') {
      for (const row of matches) Object.assign(row, this.payload);
      return { data: matches, error: null };
    }
    return { data: matches, error: null };
  }
}

function createFakeTeamsClient(state) {
  return {
    from(table) {
      if (table === 'teams') return new FakeTeamsQuery(state);
      if (table === 'team_game_urls') return new FakeGameUrlsQuery(state);
      throw new Error(`fake client: unexpected table "${table}" (this test only models "teams" and "team_game_urls")`);
    },
  };
}

// Requires the REAL src/db-supabase.js fresh, with its internal
// @supabase/supabase-js client swapped for the fake above. Returns the
// module plus the shared in-memory `state` so a test can seed rows
// directly and inspect them afterward.
function withFreshDbSupabase(fn) {
  const state = { teams: [], gameUrls: [] };
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

// ── Security Slice T3C: listTeamsForOrg (tenant-scoped team discovery) ──────
//
// The automated GameChanger reingestion job (reingest-games.js) previously
// resolved "does this scraped folder already have a team row?" via the
// completely unscoped getAllTeams() -- searching, and therefore risking a
// substring match against, every organization's teams. These tests prove
// the real listTeamsForOrg implementation never returns another
// organization's rows, fails closed without an organization, and treats
// "this organization has zero teams" as a safe, non-broadening empty
// result -- exercised against the same fake client as the write-path
// tests above (still modeling no RLS of its own).

test('listTeamsForOrg: throws OrgContextRequiredError when orgId is missing -- no fallback to every organization', () => {
  return withFreshDbSupabase(async (dbSupabase) => {
    await assert.rejects(
      () => dbSupabase.listTeamsForOrg(),
      (err) => { assert.equal(err.name, 'OrgContextRequiredError'); return true; }
    );
  });
});

test('listTeamsForOrg: throws when orgId is blank/whitespace-only', () => {
  return withFreshDbSupabase(async (dbSupabase) => {
    await assert.rejects(() => dbSupabase.listTeamsForOrg('   '), /OrgContextRequiredError|orgId/);
  });
});

test('listTeamsForOrg: a mixed-tenant fixture -- org A only ever sees its own teams, never org B\'s', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Org A Tigers' }));
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'Org B Tigers' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    assert.equal(orgATeams.length, 1, 'org A must see exactly its own one team, never org B\'s');
    assert.equal(orgATeams[0].id, orgATeamId);
    assert.equal(orgATeams[0].org_id, ORG_A);
    assert.ok(
      orgATeams.every((t) => t.org_id === ORG_A),
      'no row belonging to a different organization may ever appear in the result'
    );
  });
});

test('listTeamsForOrg: service-role access cannot bypass the scope requirement -- the fake answers ANY ' +
     'query unscoped (no RLS modeled), yet listTeamsForOrg(ORG_A) still excludes org B\'s row', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    state.teams.push({ id: nextId(), org_id: ORG_B, team_name: 'Org B Tigers', archived: false });
    state.teams.push({ id: nextId(), org_id: ORG_A, team_name: 'Org A Tigers', archived: false });

    const unscoped = await new FakeTeamsQuery(state).select()._exec();
    assert.equal(unscoped.data.length, 2, 'sanity check: the fake client itself enforces nothing');

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);
    assert.equal(orgATeams.length, 1);
    assert.equal(orgATeams[0].org_id, ORG_A);
    assert.ok(!orgATeams.some((t) => t.org_id === ORG_B), 'org B\'s team must never appear');
  });
});

test('listTeamsForOrg: a valid organization with zero teams returns an empty array -- a safe no-work ' +
     'condition, never broadened into every organization\'s teams', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B })); // some other org has teams

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    assert.deepEqual(orgATeams, [], 'an org with no teams of its own gets an empty result, not org B\'s teams');
  });
});

test('listTeamsForOrg: excludes archived teams by default, same as getAllTeams', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const activeId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Active Team' }));
    state.teams.push({ id: nextId(), org_id: ORG_A, team_name: 'Archived Team', archived: true });

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    assert.equal(orgATeams.length, 1);
    assert.equal(orgATeams[0].id, activeId);
  });
});

test('listTeamsForOrg: returned rows carry no other organization\'s data -- safe to log in full', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'Org B Secret Team' }));
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Org A Team' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);
    const serialized = JSON.stringify(orgATeams);

    assert.doesNotMatch(serialized, /Org B Secret Team/, 'org B\'s team name must never appear in org A\'s result set');
    assert.doesNotMatch(serialized, new RegExp(ORG_B), 'org B\'s org id must never appear in org A\'s result set');
  });
});

test('findMatchingTeam (REAL src/reingest-helpers.js, the exact function reingest-games.js calls): ' +
     'an IDENTICALLY-named team in org B is still never selected for org A -- the row is excluded ' +
     'by listTeamsForOrg\'s org_id scoping, not by anything findMatchingTeam itself distinguishes', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    // Same exact team_name in both organizations -- reingest-games.js's
    // ingestTeamFolder() calls findMatchingTeam(existingTeams, folderName)
    // against db.listTeamsForOrg(JOB_ORG_ID)'s result. If listTeamsForOrg
    // ever leaked a same-named row from another organization, this real
    // matching function would trivially select it (it has no org
    // awareness of its own -- isolation is entirely the query's job).
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'FS Bulldogs' }));
    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'FS Bulldogs' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    assert.equal(orgATeams.length, 1, 'org A must see exactly one "FS Bulldogs", never two');
    assert.equal(orgATeams[0].id, orgATeamId);
    assert.notEqual(orgATeams[0].id, orgBTeamId);

    // The REAL findMatchingTeam -- not a reimplementation -- against a
    // scraped folder name that collides with BOTH organizations'
    // identical team name, proving the match can only ever resolve to
    // org A's own row because org B's was never in the input at all.
    const matched = findMatchingTeam(orgATeams, 'FS Bulldogs');
    assert.ok(matched, 'the folder name must still match org A\'s own team');
    assert.equal(matched.id, orgATeamId, 'a same-named collision must resolve to org A\'s row, never org B\'s');

    // Negative control: findMatchingTeam has no org filtering of its own --
    // fed org B's row directly (proving isolation is listTeamsForOrg's
    // property, not findMatchingTeam's), it WOULD match it. This is what
    // makes the org-A-only result above meaningful rather than incidental.
    const matchedAgainstOrgB = findMatchingTeam([{ id: orgBTeamId, team_name: 'FS Bulldogs' }], 'FS Bulldogs');
    assert.equal(matchedAgainstOrgB.id, orgBTeamId, 'sanity: findMatchingTeam matches whatever list it is given');
  });
});

test('formatTeamSummaryLine (REAL src/reingest-helpers.js, the exact function reingest-games.js\'s ' +
     'main() calls): capturing actual console.log output built from a REAL listTeamsForOrg(ORG_A) ' +
     'result never emits org B\'s org id, team id, team name, or GameChanger URL -- and never emits ' +
     'a GameChanger URL for org A\'s own team either (formatTeamSummaryLine cannot read that field)', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({
      orgId: ORG_B,
      teamName: 'FS Bulldogs', // identical name to org A's team below
      gcTeamUrl: 'https://gc.example.test/org-b-secret-team-slug',
    }));
    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({
      orgId: ORG_A,
      teamName: 'FS Bulldogs',
      gcTeamUrl: 'https://gc.example.test/org-a-team-slug',
    }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    // Real console.log spy -- genuinely captures what gets written to
    // stdout when reingest-games.js#main()'s own final-summary loop calls
    // console.log(formatTeamSummaryLine(t, gamesAnalyzed)), fed with the
    // REAL org-scoped result set (not a hand-built fixture).
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => { captured.push(args.join(' ')); };
    try {
      for (const t of orgATeams) {
        const gamesAnalyzed = 0; // stands in for bundle.meta.gamesAnalyzed -- irrelevant to log-safety
        console.log(formatTeamSummaryLine(t, gamesAnalyzed));
      }
    } finally {
      console.log = originalLog;
    }

    const output = captured.join('\n');
    assert.equal(orgATeams.length, 1);
    assert.equal(orgATeams[0].id, orgATeamId);
    assert.doesNotMatch(output, new RegExp(ORG_B), 'org B\'s organization id must never appear in captured output');
    assert.doesNotMatch(output, /org-b-secret-team-slug/, 'org B\'s GameChanger URL must never appear in captured output');
    assert.doesNotMatch(output, /org-a-team-slug/, 'no GameChanger URL is printed by this summary line, not even org A\'s own');
    assert.match(output, new RegExp(orgATeamId), 'sanity: org A\'s own team id IS expected to appear (it is this org\'s own data)');
  });
});

test('formatTeamSummaryLine: zero scoped teams produces a safe, empty summary -- no global information, ' +
     'no fallback output', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B })); // some other org has teams

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => { captured.push(args.join(' ')); };
    try {
      for (const t of orgATeams) {
        console.log(formatTeamSummaryLine(t, 0));
      }
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(orgATeams, [], 'an org with no teams of its own gets an empty result, not org B\'s teams');
    assert.deepEqual(captured, [], 'zero teams must produce zero summary lines -- no global fallback output');
  });
});

// ── Security Slice T3D: report-generation team resolution ───────────────────
//
// generate-report.js previously resolved a coach-supplied team name/id
// (findTeam), listed every team (listTeams/--list), and iterated every
// team (--all) via the completely unscoped db.getAllTeams() -- a tenant
// could select, enumerate, or generate a report for another
// organization's team by exact id, exact/raw name, partial name, or an
// ambiguous-match/not-found listing. These tests prove the REAL
// src/report-team-selection.js#resolveTeamMatch (the exact function
// generate-report.js#findTeam calls) can only ever resolve to
// organization A's own team when fed a REAL db.listTeamsForOrg(ORG_A)
// result, even when organization B has an identically-named, identical-id-
// colliding-by-guess, or substring-colliding team -- because organization
// B's row is never present in the input list to begin with.

test('resolveTeamMatch (REAL src/report-team-selection.js): organization B\'s team can never be selected ' +
     'by its own exact id during an organization A run', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'Org B Tigers' }));
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Org A Tigers' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    const { team: matched } = resolveTeamMatch(orgATeams, orgBTeamId);
    assert.equal(matched, null, 'org A must never be able to select org B\'s team by its real id');
  });
});

test('resolveTeamMatch (REAL src/report-team-selection.js): an IDENTICALLY-named team in org B is never ' +
     'selected for org A -- exclusion comes from listTeamsForOrg\'s org_id scoping, not from resolveTeamMatch', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'FS Bulldogs' }));
    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'FS Bulldogs' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);
    assert.equal(orgATeams.length, 1, 'org A must see exactly one "FS Bulldogs", never two');

    const { team: matched } = resolveTeamMatch(orgATeams, 'FS Bulldogs');
    assert.ok(matched, 'org A\'s own identically-named team must still resolve');
    assert.equal(matched.id, orgATeamId);
    assert.notEqual(matched.id, orgBTeamId);

    // Negative control: resolveTeamMatch has no org filtering of its own --
    // fed org B's row directly, it WOULD match it, proving isolation is
    // listTeamsForOrg's property, not resolveTeamMatch's.
    const { team: matchedAgainstOrgB } = resolveTeamMatch([{ id: orgBTeamId, team_name: 'FS Bulldogs' }], 'FS Bulldogs');
    assert.equal(matchedAgainstOrgB.id, orgBTeamId, 'sanity: resolveTeamMatch matches whatever list it is given');
  });
});

test('resolveTeamMatch (REAL src/report-team-selection.js): a substring-colliding org B team never ' +
     'participates in org A\'s partial-name match or ambiguity calculation', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    // Both organizations have a team whose name contains "Clemens" -- if
    // listTeamsForOrg ever leaked org B's row, this query would become
    // ambiguous (2 matches) instead of resolving cleanly to org A's team.
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'James Clemens Travel' }));
    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'James Clemens Baseball' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);
    assert.equal(orgATeams.length, 1);

    const { team: matched, matches } = resolveTeamMatch(orgATeams, 'clemens');
    assert.ok(matched, 'a single unambiguous match within org A\'s own scope must still resolve');
    assert.equal(matched.id, orgATeamId);
    assert.equal(matches.length, 1, 'org B\'s substring-colliding team must never inflate the match/ambiguity count');
  });
});

test('resolveTeamMatch (REAL src/report-team-selection.js): ambiguity is calculated only among organization ' +
     'A\'s own teams -- an org B team with a colliding partial name never appears in the ambiguous-match list', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgATeamId1 = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'James Clemens A' }));
    const orgATeamId2 = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'James Clemens B' }));
    const orgBTeamId  = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'James Clemens C' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    const { team: matched, matches } = resolveTeamMatch(orgATeams, 'james clemens');
    assert.equal(matched, null, 'two org A candidates must be ambiguous, not silently resolved');
    assert.equal(matches.length, 2, 'exactly org A\'s two matching teams, never org B\'s third');
    const matchedIds = matches.map((m) => m.id);
    assert.ok(matchedIds.includes(orgATeamId1) && matchedIds.includes(orgATeamId2));
    assert.ok(!matchedIds.includes(orgBTeamId), 'org B\'s colliding team must never appear in the ambiguous list');
  });
});

test('resolveTeamMatch (REAL src/report-team-selection.js): organization A with zero teams never broadens ' +
     'to organization B\'s teams, even when the query is org B\'s own team name or id', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'Org B Only Team' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);
    assert.deepEqual(orgATeams, []);

    const byName = resolveTeamMatch(orgATeams, 'Org B Only Team');
    assert.equal(byName.team, null);
    assert.deepEqual(byName.matches, []);

    const byId = resolveTeamMatch(orgATeams, orgBTeamId);
    assert.equal(byId.team, null);
  });
});

test('formatTeamListLine / formatAmbiguousMatchLine (REAL src/report-team-selection.js): capturing actual ' +
     'console output built from a REAL listTeamsForOrg(ORG_A) result never emits org B\'s org id, team id, ' +
     'team name, or GameChanger URL -- and never emits a GameChanger URL for org A\'s own team either', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({
      orgId: ORG_B,
      teamName: 'FS Bulldogs', // identical name to org A's team below
      gcTeamUrl: 'https://gc.example.test/org-b-secret-team-slug',
    }));
    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({
      orgId: ORG_A,
      teamName: 'FS Bulldogs',
      gcTeamUrl: 'https://gc.example.test/org-a-team-slug',
    }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => { captured.push(args.join(' ')); };
    try {
      // Mirrors generate-report.js#listTeams()'s own loop.
      for (const t of orgATeams) {
        console.log(formatTeamListLine(t, 0));
      }
      // Mirrors generate-report.js#findTeam()'s own ambiguous-match loop,
      // fed the (deliberately) colliding query so both organizations'
      // rows would appear here if listTeamsForOrg ever leaked org B's.
      const { matches } = resolveTeamMatch(orgATeams, 'fs bulldogs');
      for (const m of matches) {
        console.log(formatAmbiguousMatchLine(m));
      }
    } finally {
      console.log = originalLog;
    }

    const output = captured.join('\n');
    assert.equal(orgATeams.length, 1);
    assert.doesNotMatch(output, new RegExp(ORG_B), 'org B\'s organization id must never appear in captured output');
    assert.doesNotMatch(output, /org-b-secret-team-slug/, 'org B\'s GameChanger URL must never appear in captured output');
    assert.doesNotMatch(output, /org-a-team-slug/, 'no GameChanger URL is printed by these formatters, not even org A\'s own');
    assert.match(output, new RegExp(orgATeamId), 'sanity: org A\'s own team id IS expected to appear (it is this org\'s own data)');
  });
});

test('formatTeamListLine: zero scoped teams produces a safe, empty listing -- no global fallback output', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B })); // some other org has teams

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);

    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => { captured.push(args.join(' ')); };
    try {
      for (const t of orgATeams) {
        console.log(formatTeamListLine(t, 0));
      }
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(orgATeams, []);
    assert.deepEqual(captured, [], 'zero teams must produce zero list lines -- no global fallback output');
  });
});

// ── Security Slice T3D (review correction): --all's real orchestration ──────
// against a real mixed-tenant listTeamsForOrg result ─────────────────────────
//
// generate-report.js's --all branch calls db.listTeamsForOrg(JOB_ORG_ID)
// and feeds the result into the REAL runTeamsSequentially with the real
// runForTeam as the runner (runForTeam -> analyzer.analyzeTeam(team.id,
// ...) -> live Claude API + report generation, which cannot safely run in
// a test). These tests substitute a fake runner standing in for
// runForTeam's position in that same real call chain -- proving that
// whatever runner --all wires up (which is verified by a structural guard
// in test/travel-org-propagation.test.js to be the real runForTeam) can
// only ever be invoked with organization A's own teams, because the real,
// org-scoped query is what determines the input list, not anything
// runTeamsSequentially itself does.

test('runTeamsSequentially (REAL src/report-team-selection.js) + REAL listTeamsForOrg(ORG_A): the runner ' +
     '(standing in for runForTeam/analyzer.analyzeTeam) is invoked only for organization A\'s own teams, ' +
     'even when organization B has teams with colliding names', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'Org B Tigers' }));
    const orgATeamId1 = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Org A Tigers' }));
    const orgATeamId2 = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Org A Bears' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);
    assert.equal(orgATeams.length, 2);

    const processedIds = [];
    const result = await runTeamsSequentially(orgATeams, async (t) => { processedIds.push(t.id); });

    assert.deepEqual(processedIds.sort(), [orgATeamId1, orgATeamId2].sort(),
      'the runner must be called for exactly org A\'s two teams');
    assert.ok(!processedIds.includes(orgBTeamId), 'the runner must never be called with org B\'s team id');
    assert.deepEqual(result, { succeeded: 2, failed: 0 });
  });
});

test('runTeamsSequentially (REAL src/report-team-selection.js) + REAL listTeamsForOrg(ORG_A): organization A ' +
     'with zero teams never falls back to processing organization B\'s teams -- the runner is never invoked', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'Org B Only Team' }));

    const orgATeams = await dbSupabase.listTeamsForOrg(ORG_A);
    assert.deepEqual(orgATeams, []);

    let callCount = 0;
    const result = await runTeamsSequentially(orgATeams, async () => { callCount++; });

    assert.equal(callCount, 0, 'the runner must never be invoked when org A has zero authorized teams');
    assert.deepEqual(result, { succeeded: 0, failed: 0 });
  });
});

// ── Security Slice T3E: getAllTeams() replaced by listAllTeamsForOperator ───
//
// getAllTeams() was an ambiguous name -- nothing in it communicated
// whether "all" meant one organization's teams or every organization's.
// It is renamed to listAllTeamsForOperator() (an explicit, intentionally
// dangerous repository-wide enumeration with no tenant filter) and the
// ambiguous name is removed from the module entirely, with no
// compatibility alias. These tests exercise the REAL renamed function
// against the same fake Supabase client used throughout this file,
// proving it (a) still performs genuine repository-wide enumeration
// (never accidentally organization-scoped) and (b) is no longer reachable
// under its old, ambiguous name.

test('listAllTeamsForOperator: performs genuine repository-wide enumeration -- returns teams from BOTH ' +
     'organizations in a single call, never scoped to just one', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const orgATeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Org A Tigers' }));
    const orgBTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B, teamName: 'Org B Bears' }));

    const allTeams = await dbSupabase.listAllTeamsForOperator();

    assert.equal(allTeams.length, 2, 'the operator-wide call must see both organizations\' teams');
    const ids = allTeams.map((t) => t.id);
    assert.ok(ids.includes(orgATeamId) && ids.includes(orgBTeamId),
      'both organizations\' teams must be present -- this is the intentionally dangerous, repository-wide query');
  });
});

test('listAllTeamsForOperator: does not accidentally apply any organization\'s filter -- takes no orgId ' +
     'argument and its result is identical regardless of which organizations exist', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_B }));

    // Sanity: the fake client's FakeTeamsQuery only filters on explicit
    // .eq()/.ilike() calls -- listAllTeamsForOperator's own query (see
    // src/db-supabase.js) applies neither .eq('org_id', ...) nor any
    // other tenant predicate, which this length assertion (2, not 1 or 0)
    // is what actually proves, not merely the function's arity.
    const allTeams = await dbSupabase.listAllTeamsForOperator();
    assert.equal(allTeams.length, 2, 'both organizations\' teams must be returned -- no orgId filter is ever applied');
  });
});

test('listAllTeamsForOperator: excludes archived teams by default, same as before the rename; ' +
     'includeArchived=true still returns every team including archived ones', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const activeId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Active' }));
    state.teams.push({ id: nextId(), org_id: ORG_B, team_name: 'Archived', archived: true });

    const activeOnly = await dbSupabase.listAllTeamsForOperator();
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0].id, activeId);

    const withArchived = await dbSupabase.listAllTeamsForOperator(true);
    assert.equal(withArchived.length, 2);
  });
});

test('db-supabase.js no longer exports getAllTeams under any name -- listAllTeamsForOperator is the ' +
     'only repository-wide enumerator, and the ambiguous name is completely gone', () => {
  return withFreshDbSupabase(async (dbSupabase) => {
    assert.equal(dbSupabase.getAllTeams, undefined, 'the ambiguous name must not remain as a live export');
    assert.equal(typeof dbSupabase.listAllTeamsForOperator, 'function', 'the explicit replacement must be exported');
    assert.equal(typeof dbSupabase.listTeamsForOrg, 'function', 'the tenant-scoped API must be unaffected');
  });
});

test('db.js (SQLite passthrough) no longer exports getAllTeams under any name', () => {
  delete require.cache[require.resolve('../src/db')];
  const dbSqlite = require('../src/db');
  assert.equal(dbSqlite.getAllTeams, undefined, 'the ambiguous name must not remain as a live export');
  assert.equal(typeof dbSqlite.listAllTeamsForOperator, 'function', 'the explicit replacement must be exported');
  delete require.cache[require.resolve('../src/db')];
});

test('the ambiguous name getAllTeams does not appear anywhere in src/db-supabase.js\'s source ' +
     '(a historical mention in an explanatory comment about a past defect is fine; a live definition, ' +
     'export, or call site is not)', () => {
  const fs = require('fs');
  const source = fs.readFileSync(DB_SUPABASE_SRC_PATH, 'utf8');
  assert.doesNotMatch(source, /\bgetAllTeams\b/, 'db-supabase.js must not reference getAllTeams in any form');
});

// ── Security Slice T3G: getGameUrlsForTeamInOrg / markGameUrlProcessedForOrg ─
//
// src/scrape-game-urls.js#getGameUrls()/markProcessed() used to open
// voodoo-scout.db directly with no organization scoping at all --
// team_game_urls has no org_id column, so an unscoped `WHERE team_id = ?`
// query could read or update any organization's rows. These tests exercise
// the REAL src/db-supabase.js#getGameUrlsForTeamInOrg/
// markGameUrlProcessedForOrg against the same fake client used throughout
// this file, proving the same two-step "verify team ownership via teams.org_id,
// then operate scoped by team_id" pattern server.js's own
// assertTeamInRequestOrg + getTeamGameUrls/PUT/DELETE routes already
// established for this exact table (see server.js) is now available as a
// shared repository method, not a route-only convention.

function syntheticGameUrl(overrides = {}) {
  return {
    id: nextId(),
    team_id: null,
    gc_game_url: 'https://web.gc.com/game/synthetic',
    label: '',
    box_side: 'away',
    processed_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test('getGameUrlsForTeamInOrg: returns only the requested team\'s rows when that team belongs to the given org', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'No-GC Tigers' }));
    state.gameUrls.push(syntheticGameUrl({ team_id: teamId, label: 'Game 1' }));
    state.gameUrls.push(syntheticGameUrl({ team_id: teamId, label: 'Game 2' }));

    const urls = await dbSupabase.getGameUrlsForTeamInOrg(ORG_A, teamId);
    assert.equal(urls.length, 2, 'both of this team\'s rows must be returned');
  });
});

test('getGameUrlsForTeamInOrg: a foreign organization\'s id for a real team in a DIFFERENT org returns an empty result, not that team\'s rows', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Org A Team' }));
    state.gameUrls.push(syntheticGameUrl({ team_id: teamId, label: 'Org A Game' }));

    const urls = await dbSupabase.getGameUrlsForTeamInOrg(ORG_B, teamId);
    assert.deepEqual(urls, [], 'a team belonging to a different organization must never leak its game-url rows');
  });
});

test('getGameUrlsForTeamInOrg: a nonexistent teamId returns an empty result, not an error, and never falls back to a global scan', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    state.gameUrls.push(syntheticGameUrl({ team_id: 'some-other-team-id', label: 'Unrelated' }));
    const urls = await dbSupabase.getGameUrlsForTeamInOrg(ORG_A, 'nonexistent-team-id');
    assert.deepEqual(urls, []);
  });
});

test('getGameUrlsForTeamInOrg: fails closed (OrgContextRequiredError) for missing/blank orgId, never treated as "return everything"', async () => {
  await withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    state.gameUrls.push(syntheticGameUrl({ team_id: teamId }));
    await assert.rejects(() => dbSupabase.getGameUrlsForTeamInOrg(undefined, teamId), /orgId/i);
    await assert.rejects(() => dbSupabase.getGameUrlsForTeamInOrg('   ', teamId), /orgId/i);
  });
});

test('markGameUrlProcessedForOrg: updates processed_at on a row belonging to the authenticated organization\'s team', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    const row = syntheticGameUrl({ team_id: teamId });
    state.gameUrls.push(row);

    const result = await dbSupabase.markGameUrlProcessedForOrg(ORG_A, row.id, teamId);
    assert.equal(result.updated, true);
    assert.ok(state.gameUrls.find((r) => r.id === row.id).processed_at, 'processed_at must actually be set on the real row');
  });
});

test('markGameUrlProcessedForOrg: a foreign organization\'s id cannot update another organization\'s row', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    const row = syntheticGameUrl({ team_id: teamId });
    state.gameUrls.push(row);

    const result = await dbSupabase.markGameUrlProcessedForOrg(ORG_B, row.id, teamId);
    assert.equal(result.updated, false, 'a foreign organization must never be able to mark another organization\'s row processed');
    assert.equal(state.gameUrls.find((r) => r.id === row.id).processed_at, null, 'the row must remain untouched');
  });
});

test('markGameUrlProcessedForOrg: fails closed (OrgContextRequiredError) for missing/blank orgId', async () => {
  await withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    const row = syntheticGameUrl({ team_id: teamId });
    state.gameUrls.push(row);
    await assert.rejects(() => dbSupabase.markGameUrlProcessedForOrg(undefined, row.id, teamId), /orgId/i);
    assert.equal(state.gameUrls.find((r) => r.id === row.id).processed_at, null);
  });
});

test('markGameUrlProcessedForOrg: the underlying Supabase mutation is constrained by BOTH the row id and team_id at query time ' +
     '(not merely by an application-level check performed earlier and then trusted)', () => {
  return withFreshDbSupabase(async (dbSupabase, state) => {
    const teamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A }));
    const otherTeamId = await dbSupabase.upsertTeam(syntheticTeam({ orgId: ORG_A, teamName: 'Other Team Same Org' }));
    const row = syntheticGameUrl({ team_id: teamId });
    state.gameUrls.push(row);

    // Same org, but the WRONG team_id for this row -- the query itself must
    // still refuse to touch it, proving team_id is a real query constraint,
    // not decoration.
    const result = await dbSupabase.markGameUrlProcessedForOrg(ORG_A, row.id, otherTeamId);
    assert.equal(result.updated, false);
    assert.equal(state.gameUrls.find((r) => r.id === row.id).processed_at, null);
  });
});

test('db-supabase.js exports getGameUrlsForTeamInOrg and markGameUrlProcessedForOrg', () => {
  return withFreshDbSupabase(async (dbSupabase) => {
    assert.equal(typeof dbSupabase.getGameUrlsForTeamInOrg, 'function');
    assert.equal(typeof dbSupabase.markGameUrlProcessedForOrg, 'function');
  });
});
