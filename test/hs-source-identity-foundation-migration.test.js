'use strict';

// Focused tests for
// supabase/migrations/20260808172649_create_hs_source_identity_foundation.sql
// -- the GameChanger source-identity foundation (Slice 1 of the
// schedule-driven onboarding / opponent-monitoring importer):
// hs_source_teams, hs_source_team_contexts, hs_team_source_registrations,
// hs_opponent_programs, hs_opponent_teams, hs_opponent_source_links, plus
// two additive supporting unique constraints on the existing hs_teams and
// hs_seasons tables.
//
// Text-level assertions against the raw SQL, mirroring the convention
// already used in test/high-school-import-domain-migration.test.js: these
// prove the migration's shape (tables, constraints, RLS, grants), not
// runtime behavior against a real Postgres instance -- that is covered
// separately by test/hs-source-identity-foundation-relational.integration.test.js,
// which requires a real (disposable, non-production) Postgres instance and
// is intentionally NOT part of this file or the default `npm test` run.
//
// Run with: node --test test/hs-source-identity-foundation-migration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'supabase', 'migrations', '20260808172649_create_hs_source_identity_foundation.sql');
const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

// Statements only, comment lines stripped -- prose in header comments
// (e.g. explaining that no GRANT is needed) would otherwise false-positive
// against checks meaningful only against the actual executable SQL.
// Mirrors the convention in test/high-school-import-domain-migration.test.js.
const statementsOnly = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

const NEW_TABLES = [
  'hs_source_teams',
  'hs_source_team_contexts',
  'hs_team_source_registrations',
  'hs_opponent_programs',
  'hs_opponent_teams',
  'hs_opponent_source_links',
];

function tableBody(table) {
  const m = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `expected to find CREATE TABLE for ${table}`);
  return m[1];
}

function columnDefinition(table, column) {
  const body = tableBody(table);
  const line = body.split('\n').find((l) => l.trim().startsWith(`"${column}"`));
  return line || null;
}

// ── 1. Migration file exists and is registered ──────────────────────────

test('the migration file exists at the expected path', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH));
});

test('the migration-contract test is registered in package.json test script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/hs-source-identity-foundation-migration\.test\.js/);
});

// ── 2. All six tables exist, with uuid PKs ───────────────────────────────

for (const table of NEW_TABLES) {
  test(`the migration creates public.${table}`, () => {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\s*\\(`));
  });

  test(`${table} has a uuid primary key defaulting to extensions.uuid_generate_v4()`, () => {
    const def = columnDefinition(table, 'id');
    assert.ok(def);
    assert.match(def, /"id" uuid not null default extensions\.uuid_generate_v4\(\)/);
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}[\\s\\S]*?primary key \\("id"\\)`));
  });
}

// ── 3. Existing hs_teams / hs_seasons are only extended, never altered ──

test('hs_teams gets exactly one new additive unique constraint, no column change', () => {
  assert.match(
    sql,
    /alter table public\.hs_teams\s*\n\s*add constraint hs_teams_org_program_id_key unique \(org_id, program_id, id\);/
  );
  assert.doesNotMatch(sql, /alter table public\.hs_teams\s+(drop|alter column|rename)/i);
});

test('hs_seasons gets exactly one new additive unique constraint, no column change', () => {
  assert.match(
    sql,
    /alter table public\.hs_seasons\s*\n\s*add constraint hs_seasons_org_program_id_key unique \(org_id, program_id, id\);/
  );
  assert.doesNotMatch(sql, /alter table public\.hs_seasons\s+(drop|alter column|rename)/i);
});

test('no existing HS domain, import domain, or opponent-intelligence table is created or altered beyond hs_teams/hs_seasons', () => {
  const UNTOUCHABLE = [
    'hs_programs', 'hs_players', 'hs_roster_memberships', 'hs_games', 'hs_import_runs',
    'hs_import_run_games', 'hs_raw_snapshots', 'hs_game_validation_results', 'hs_verified_totals',
    'hs_player_advanced_stats', 'hs_pitcher_advanced_stats', 'opponent_players',
    'opponent_roster_memberships', 'coach_scouting_notes', 'teams', 'games', 'players',
  ];
  for (const table of UNTOUCHABLE) {
    assert.doesNotMatch(
      sql,
      new RegExp(`create table if not exists public\\.${table}\\s*\\(`),
      `${table} must not be (re)created by this migration`
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`alter table public\\.${table}\\s+(drop|alter column|rename)`, 'i'),
      `${table} must not be altered by this migration`
    );
  }
});

// ── 4. Required NOT NULL columns ─────────────────────────────────────────

const REQUIRED_NOT_NULL = {
  hs_source_teams: ['org_id', 'source_provider', 'source_team_ref'],
  hs_source_team_contexts: ['org_id', 'source_team_id', 'hs_season_id'],
  hs_team_source_registrations: ['org_id', 'program_id', 'team_id', 'season_id', 'source_team_id', 'status', 'record_source'],
  hs_opponent_programs: ['org_id', 'program_id', 'name'],
  hs_opponent_teams: ['org_id', 'program_id', 'opponent_program_id', 'season_id', 'level'],
  hs_opponent_source_links: ['org_id', 'program_id', 'opponent_team_id', 'season_id', 'source_team_id', 'status'],
};

for (const [table, columns] of Object.entries(REQUIRED_NOT_NULL)) {
  for (const column of columns) {
    test(`${table}.${column} is NOT NULL`, () => {
      const def = columnDefinition(table, column);
      assert.ok(def, `expected column ${column} on ${table}`);
      assert.match(def, /not null/i);
    });
  }
}

const NULLABLE_DECISION_METADATA = {
  hs_team_source_registrations: ['superseded_at', 'superseded_by_registration_id', 'decided_by_user_id', 'decided_at'],
  hs_opponent_source_links: ['superseded_at', 'superseded_by_link_id', 'confidence', 'decided_by_user_id', 'decided_at'],
};

for (const [table, columns] of Object.entries(NULLABLE_DECISION_METADATA)) {
  for (const column of columns) {
    test(`${table}.${column} is nullable (no CHECK requires it unconditionally)`, () => {
      const def = columnDefinition(table, column);
      assert.ok(def, `expected column ${column} on ${table}`);
      assert.doesNotMatch(def, /not null/i);
    });
  }
}

// ── 5. Status vocabularies ───────────────────────────────────────────────

test('hs_team_source_registrations.status vocabulary is pending/active/superseded/rejected', () => {
  assert.match(
    sql,
    /"status" text not null default 'pending' check \("status" in \('pending', 'active', 'superseded', 'rejected'\)\)/
  );
});

test('hs_opponent_source_links.status vocabulary is pending/linked/superseded/rejected/needs_review', () => {
  assert.match(
    sql,
    /"status" text not null default 'pending' check \("status" in \('pending', 'linked', 'superseded', 'rejected', 'needs_review'\)\)/
  );
});

test('hs_opponent_teams.level vocabulary matches hs_teams exactly, plus unknown', () => {
  assert.match(
    sql,
    /"level" text not null default 'unknown' check \("level" in \('freshman', 'junior_varsity', 'varsity', 'unknown'\)\)/
  );
  // Must NOT use the abbreviation 'jv' -- hs_teams.level (existing table)
  // uses 'junior_varsity', and this table's vocabulary is deliberately
  // aligned to match rather than introduce a second spelling.
  assert.doesNotMatch(sql, /'jv'/);
});

// ── 6. The two same-scope self-referencing FKs use the full 5-column
//    tuple, not just (org_id, id) ────────────────────────────────────────

test('hs_team_source_registrations self-reference proves program+team+season, not just org', () => {
  assert.match(
    sql,
    /foreign key \("org_id", "program_id", "team_id", "season_id", "superseded_by_registration_id"\)\s*\n\s*references public\.hs_team_source_registrations \("org_id", "program_id", "team_id", "season_id", "id"\)/
  );
  assert.doesNotMatch(
    sql,
    /foreign key \("org_id", "superseded_by_registration_id"\) references public\.hs_team_source_registrations \("org_id", "id"\)/
  );
});

test('hs_opponent_source_links self-reference proves program+opponent_team+season, not just org', () => {
  assert.match(
    sql,
    /foreign key \("org_id", "program_id", "opponent_team_id", "season_id", "superseded_by_link_id"\)\s*\n\s*references public\.hs_opponent_source_links \("org_id", "program_id", "opponent_team_id", "season_id", "id"\)/
  );
  assert.doesNotMatch(
    sql,
    /foreign key \("org_id", "superseded_by_link_id"\) references public\.hs_opponent_source_links \("org_id", "id"\)/
  );
});

test('the self-reference scope deliberately excludes source_team_id on both tables', () => {
  // A replacement's entire purpose is usually to change which source team
  // is bound -- requiring it to match would defeat the mechanism.
  assert.doesNotMatch(
    sql,
    /foreign key \("org_id", "program_id", "team_id", "season_id", "source_team_id", "superseded_by_registration_id"\)/
  );
  assert.doesNotMatch(
    sql,
    /foreign key \("org_id", "program_id", "opponent_team_id", "season_id", "source_team_id", "superseded_by_link_id"\)/
  );
});

test('both self-referencing tables declare the matching 5-column unique key the FK requires', () => {
  assert.match(
    sql,
    /constraint "hs_team_source_registrations_scope_id_key"\s*\n\s*unique \("org_id", "program_id", "team_id", "season_id", "id"\)/
  );
  assert.match(
    sql,
    /constraint "hs_opponent_source_links_scope_id_key"\s*\n\s*unique \("org_id", "program_id", "opponent_team_id", "season_id", "id"\)/
  );
  // The narrower unique(org_id, id) must NOT also be present on either
  // table -- nothing references it, and it would be dead weight.
  assert.doesNotMatch(sql, /"hs_team_source_registrations_org_id_key" unique \("org_id", "id"\)/);
  assert.doesNotMatch(sql, /"hs_opponent_source_links_org_id_key" unique \("org_id", "id"\)/);
});

// ── 7. Bidirectional supersession CHECK ──────────────────────────────────

for (const [table, pointerCol] of [
  ['hs_team_source_registrations', 'superseded_by_registration_id'],
  ['hs_opponent_source_links', 'superseded_by_link_id'],
]) {
  test(`${table} supersession CHECK is bidirectional (both branches, not just the superseded one)`, () => {
    const body = tableBody(table);
    assert.match(
      body,
      new RegExp(
        `\\("status" = 'superseded' and "superseded_at" is not null and "${pointerCol}" is not null\\)\\s*\\n\\s*or\\s*\\n\\s*\\("status" <> 'superseded' and "superseded_at" is null and "${pointerCol}" is null\\)`
      )
    );
  });

  test(`${table} has no one-directional supersession CHECK left over`, () => {
    const body = tableBody(table);
    // The old, defective form: "status <> 'superseded' or (...is not null and...is not null)"
    // with no matching reverse branch anywhere nearby.
    assert.doesNotMatch(
      body,
      new RegExp(`check \\("status" <> 'superseded' or \\("superseded_at" is not null and "${pointerCol}" is not null\\)\\)`)
    );
  });
}

// ── 8. Cross-program/team/season composite FK proofs exist ──────────────

test('hs_team_source_registrations proves team belongs to the stated program (3-column FK)', () => {
  assert.match(
    sql,
    /foreign key \("org_id", "program_id", "team_id"\) references public\.hs_teams \("org_id", "program_id", "id"\)/
  );
});

test('hs_team_source_registrations proves season belongs to the stated program (3-column FK)', () => {
  assert.match(
    sql,
    /foreign key \("org_id", "program_id", "season_id"\) references public\.hs_seasons \("org_id", "program_id", "id"\)/
  );
});

test('hs_opponent_teams proves opponent program belongs to the stated program (3-column FK)', () => {
  assert.match(
    sql,
    /foreign key \("org_id", "program_id", "opponent_program_id"\)\s*\n\s*references public\.hs_opponent_programs \("org_id", "program_id", "id"\)/
  );
});

test('hs_opponent_teams proves season belongs to the stated program (3-column FK)', () => {
  assert.match(
    sql,
    /foreign key \("org_id", "program_id", "season_id"\)\s*\n\s*references public\.hs_seasons \("org_id", "program_id", "id"\)/
  );
});

test('hs_opponent_source_links proves opponent team AND its real season match (4-column FK, not 3)', () => {
  assert.match(
    sql,
    /foreign key \("org_id", "program_id", "opponent_team_id", "season_id"\)\s*\n\s*references public\.hs_opponent_teams \("org_id", "program_id", "id", "season_id"\)/
  );
});

// ── 9. Source-context composite integrity ────────────────────────────────

for (const table of ['hs_team_source_registrations', 'hs_opponent_source_links']) {
  test(`${table} proves the source context belongs to the claimed source team AND season`, () => {
    assert.match(
      sql,
      new RegExp(
        `foreign key \\("org_id", "source_team_id", "season_id"\\)\\s*\\n\\s*references public\\.hs_source_team_contexts \\("org_id", "source_team_id", "hs_season_id"\\)`
      )
    );
  });
}

// ── 10. Uniqueness that must NOT exist ───────────────────────────────────

test('hs_opponent_teams has no unique constraint on (opponent_program_id, season_id) or with level added', () => {
  assert.doesNotMatch(sql, /unique \("?opponent_program_id"?, "?season_id"?\)/);
  assert.doesNotMatch(sql, /unique \("?opponent_program_id"?, "?season_id"?, "?level"?\)/);
});

test('hs_opponent_programs.normalized_name index is NOT unique', () => {
  assert.match(
    sql,
    /create index if not exists idx_hs_opponent_programs_org_program_normalized_name/
  );
  assert.doesNotMatch(
    sql,
    /create unique index if not exists idx_hs_opponent_programs_org_program_normalized_name/
  );
});

test('active/linked partial-unique indexes are scoped correctly, not to bare source_team_id', () => {
  assert.match(
    sql,
    /create unique index if not exists idx_hs_team_source_registrations_active_per_team_season\s*\n\s*on public\.hs_team_source_registrations \("team_id", "season_id"\)\s*\n\s*where "status" = 'active';/
  );
  assert.match(
    sql,
    /create unique index if not exists idx_hs_opponent_source_links_linked_per_source_season\s*\n\s*on public\.hs_opponent_source_links \("source_team_id", "season_id"\)\s*\n\s*where "status" = 'linked';/
  );
  assert.doesNotMatch(
    sql,
    /create unique index[\s\S]*?on public\.hs_opponent_source_links \("source_team_id"\)\s*\n\s*where "status" = 'linked';/
  );
});

// ── 11. RLS: enabled on all six, single SELECT policy, zero write surface ─

for (const table of NEW_TABLES) {
  test(`${table} has RLS enabled`, () => {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`));
  });

  test(`${table} has exactly one policy, a SELECT policy checking org membership + high_school entitlement`, () => {
    const policyMatches = [...sql.matchAll(new RegExp(`create policy "${table}[a-z_]*" on public\\.${table}`, 'g'))];
    assert.equal(policyMatches.length, 1, `expected exactly one policy on ${table}`);
    const m = sql.match(new RegExp(`create policy "${table}_select" on public\\.${table}[\\s\\S]*?\\);`));
    assert.ok(m);
    assert.match(m[0], /for select/);
    assert.match(m[0], /"org_id" in \(select auth_user_org_ids\(\)\)/);
    assert.match(m[0], /"o"\."enabled_products" @> array\['high_school'\]::text\[\]/);
  });

  test(`${table} has no INSERT/UPDATE/DELETE policy`, () => {
    assert.doesNotMatch(sql, new RegExp(`create policy[^;]*on public\\.${table}[\\s\\S]*?for (insert|update|delete)`, 'i'));
  });
}

test('no GRANT statement and no SECURITY DEFINER function is introduced by this migration', () => {
  assert.doesNotMatch(statementsOnly, /\bgrant\b/i);
  assert.doesNotMatch(statementsOnly, /security definer/i);
});

// ── 12. updated_at triggers on all six ───────────────────────────────────

for (const table of NEW_TABLES) {
  test(`${table} has an updated_at trigger using the existing set_updated_at()`, () => {
    assert.match(
      sql,
      new RegExp(`create trigger trg_${table}_updated_at before update on public\\.${table} for each row execute function set_updated_at\\(\\);`)
    );
  });
}
