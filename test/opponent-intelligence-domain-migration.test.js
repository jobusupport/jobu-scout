'use strict';

// Focused text-level tests for
// supabase/migrations/20260806031303_create_opponent_intelligence_domain.sql
// and its down migration. Mirrors the convention already used by
// test/high-school-player-lifecycle-status-migration.test.js: these prove
// the migration's SHAPE (tables, constraints, RLS, indexes) via statement
// text, not row-level behavior against a real Postgres instance -- that was
// verified separately against a disposable Supabase Preview Branch before
// this migration was written into this file (composite-FK cross-tenant
// rejection, note length/category CHECK constraints, and defaults were all
// confirmed live).
//
// Run with: node --test test/opponent-intelligence-domain-migration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260806031303_create_opponent_intelligence_domain.sql');
const DOWN_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'rollback', '20260806031303_create_opponent_intelligence_domain.down.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lowerSql = sql.toLowerCase();
const downSql = fs.readFileSync(DOWN_MIGRATION_PATH, 'utf8');

function statementsOnly(text) {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

const statements = statementsOnly(sql);
const statementsLower = statements.toLowerCase();

// ── Composite-FK readiness on pre-existing tables ────────────────────────

test('adds unique (org_id, id) to teams and games (required for the new composite foreign keys)', () => {
  assert.match(statements, /alter table public\."teams" add constraint "teams_org_id_id_key" unique \("org_id", "id"\);/);
  assert.match(statements, /alter table public\."games" add constraint "games_org_id_id_key" unique \("org_id", "id"\);/);
});

test('does not alter any column or drop anything on teams/games -- purely additive', () => {
  assert.doesNotMatch(statementsLower, /alter table public\."teams" (drop|alter column)/);
  assert.doesNotMatch(statementsLower, /alter table public\."games" (drop|alter column)/);
});

// ── opponent_players ──────────────────────────────────────────────────────

test('opponent_players has no jersey_number column -- jersey lives only on the membership table', () => {
  const tableBlock = statements.match(/create table if not exists public\.opponent_players \(([\s\S]*?)\);/)[1];
  assert.doesNotMatch(tableBlock.toLowerCase(), /jersey_number/);
});

test('opponent_players status CHECK permits exactly the five real lifecycle values (never "cut")', () => {
  assert.match(
    sql,
    /constraint "opponent_players_status_check" check \("status" = any \(array\['active'::text, 'graduated'::text, 'transferred'::text, 'not_participating'::text, 'other_non_returning'::text\]\)\)/
  );
  assert.doesNotMatch(statementsLower, /'cut'/);
});

test('opponent_players is scoped to teams via a composite (org_id, team_id) foreign key, not a bare team_id fkey', () => {
  assert.match(
    sql,
    /constraint "opponent_players_org_team_fkey" foreign key \("org_id", "team_id"\) references public\."teams" \("org_id", "id"\) on delete cascade/
  );
});

test('opponent_players declares unique (org_id, id), enabling downstream composite FKs', () => {
  assert.match(statements, /constraint "opponent_players_org_id_id_key" unique \("org_id", "id"\)/);
});

test('opponent_players has a confirmed_fields text[] column for coach-confirmed-value protection', () => {
  assert.match(statements, /"confirmed_fields" text\[\] not null default '\{\}'/);
});

test('opponent_players.normalized_first_name/normalized_last_name are generated, never independently writable', () => {
  assert.match(sql, /"normalized_first_name" text generated always as \(lower\(trim\("first_name"\)\)\) stored/);
  assert.match(sql, /"normalized_last_name" text generated always as \(lower\(trim\("last_name"\)\)\) stored/);
});

test('bats/throws CHECK constraints only permit the real handedness values', () => {
  assert.match(sql, /constraint "opponent_players_bats_check" check \("bats" is null or "bats" = any \(array\['L'::text, 'R'::text, 'S'::text\]\)\)/);
  assert.match(sql, /constraint "opponent_players_throws_check" check \("throws" is null or "throws" = any \(array\['L'::text, 'R'::text\]\)\)/);
});

// ── opponent_roster_memberships ──────────────────────────────────────────

test('opponent_roster_memberships carries jersey_number and is uniquely keyed per (player, team, season)', () => {
  const tableBlock = statements.match(/create table if not exists public\.opponent_roster_memberships \(([\s\S]*?)\);/)[1];
  assert.match(tableBlock, /"jersey_number" text/);
  assert.match(statements, /constraint "opponent_roster_memberships_player_team_season_key" unique \("opponent_player_id", "team_id", "season_label"\)/);
});

test('opponent_roster_memberships references opponent_players and teams via composite (org_id, ...) foreign keys', () => {
  assert.match(
    sql,
    /constraint "opponent_roster_memberships_org_player_fkey" foreign key \("org_id", "opponent_player_id"\) references public\.opponent_players \("org_id", "id"\) on delete cascade/
  );
  assert.match(
    sql,
    /constraint "opponent_roster_memberships_org_team_fkey" foreign key \("org_id", "team_id"\) references public\."teams" \("org_id", "id"\) on delete cascade/
  );
});

// ── opponent_roster_import_conflicts ─────────────────────────────────────

test('opponent_roster_import_conflicts records coach vs. imported values with a resolution CHECK', () => {
  const tableBlock = statements.match(/create table if not exists public\.opponent_roster_import_conflicts \(([\s\S]*?)\);/)[1];
  assert.match(tableBlock, /"coach_confirmed_value" text/);
  assert.match(tableBlock, /"imported_value" text/);
  assert.match(
    sql,
    /constraint "opponent_roster_import_conflicts_resolution_check" check \("resolution" is null or "resolution" = any \(array\['kept_coach_value'::text, 'accepted_import_value'::text\]\)\)/
  );
});

// ── coach_scouting_notes ──────────────────────────────────────────────────

test('coach_scouting_notes supports team/player/game-level scoping via nullable player_id/game_id', () => {
  const tableBlock = statements.match(/create table if not exists public\.coach_scouting_notes \(([\s\S]*?)\);/)[1];
  assert.match(tableBlock, /"opponent_team_id" uuid not null/);
  assert.match(tableBlock, /"opponent_player_id" uuid,/);
  assert.match(tableBlock, /"game_id" uuid,/);
});

test('coach_scouting_notes.note_text has both a non-blank and a max-length (4000) CHECK', () => {
  assert.match(sql, /constraint "coach_scouting_notes_text_not_blank_check" check \(char_length\(trim\("note_text"\)\) > 0\)/);
  assert.match(sql, /constraint "coach_scouting_notes_text_length_check" check \(char_length\("note_text"\) <= 4000\)/);
});

test('coach_scouting_notes.category CHECK permits exactly the ten documented categories and is nullable (not mandatory)', () => {
  const tableBlock = statements.match(/create table if not exists public\.coach_scouting_notes \(([\s\S]*?)\);/)[1];
  assert.match(tableBlock, /"category" text,/);
  for (const cat of ['lineup', 'hitting_approach', 'pitching', 'defense', 'baserunning', 'tendencies', 'personnel', 'injury_availability', 'situational', 'general']) {
    assert.match(sql, new RegExp(`'${cat}'::text`));
  }
});

test('coach_scouting_notes has independent include_in_report and is_archived booleans (exclude != delete)', () => {
  assert.match(statements, /"include_in_report" boolean not null default true/);
  assert.match(statements, /"is_archived" boolean not null default false/);
});

test('coach_scouting_notes references organizations/teams/players/games/auth.users via composite or FK constraints, never a bare unscoped column', () => {
  assert.match(sql, /constraint "coach_scouting_notes_org_team_fkey" foreign key \("org_id", "opponent_team_id"\) references public\."teams" \("org_id", "id"\) on delete cascade/);
  assert.match(sql, /constraint "coach_scouting_notes_org_player_fkey" foreign key \("org_id", "opponent_player_id"\) references public\.opponent_players \("org_id", "id"\) on delete cascade/);
  assert.match(sql, /constraint "coach_scouting_notes_org_game_fkey" foreign key \("org_id", "game_id"\) references public\."games" \("org_id", "id"\) on delete cascade/);
  assert.match(sql, /constraint "coach_scouting_notes_org_author_fkey" foreign key \("author_user_id"\) references auth\.users \("id"\) on delete cascade/);
});

test('a partial index exists matching the exact report-context query shape (active, included, per-team, newest first)', () => {
  assert.match(
    statementsLower,
    /create index if not exists idx_coach_scouting_notes_report_context on public\.coach_scouting_notes using btree \("opponent_team_id", "updated_at" desc\) where "is_archived" = false and "include_in_report" = true;/
  );
});

// ── RLS ────────────────────────────────────────────────────────────────────

test('every new table enables RLS with exactly one SELECT-only policy, no INSERT/UPDATE/DELETE policy', () => {
  for (const t of ['opponent_players', 'opponent_roster_memberships', 'opponent_roster_import_conflicts', 'coach_scouting_notes']) {
    assert.match(statementsLower, new RegExp(`alter table public\\.${t} enable row level security;`));
  }
  assert.doesNotMatch(statementsLower, /for insert/);
  assert.doesNotMatch(statementsLower, /for update/);
  assert.doesNotMatch(statementsLower, /for delete/);
});

test('every RLS policy checks org membership AND the travel product entitlement, matching the High School domain idiom', () => {
  const policyBlocks = statements.match(/create policy "[a-z_]+_select" on public\.[a-z_]+[\s\S]*?;/g) || [];
  assert.equal(policyBlocks.length, 4, 'expected exactly 4 SELECT policies');
  for (const block of policyBlocks) {
    assert.match(block, /"org_id" in \(select auth_user_org_ids\(\)\)/);
    assert.match(block, /"o"\."enabled_products" @> array\['travel'\]::text\[\]/);
  }
});

test('no GRANT/REVOKE statement is added -- matches the existing "RLS is what restricts access" convention', () => {
  assert.doesNotMatch(statementsLower, /^\s*grant /m);
  assert.doesNotMatch(statementsLower, /^\s*revoke /m);
});

// ── Indexes on org_id for every new table ────────────────────────────────

test('every new table has an index on org_id', () => {
  for (const t of ['opponent_players', 'opponent_roster_memberships', 'opponent_roster_import_conflicts', 'coach_scouting_notes']) {
    assert.match(statementsLower, new RegExp(`create index if not exists idx_${t}_org_id on public\\.${t} using btree \\("org_id"\\);`));
  }
});

// ── No destructive statement, no seed data, no secrets ───────────────────

test('contains no DROP TABLE, DELETE, or TRUNCATE against any existing table', () => {
  for (const keyword of ['drop table', 'delete from', 'truncate']) {
    assert.doesNotMatch(statementsLower, new RegExp(keyword));
  }
});

test('contains no INSERT statement (no seed data)', () => {
  assert.doesNotMatch(statementsLower, /insert into/);
});

test('contains no hard-coded UUID literal', () => {
  assert.doesNotMatch(sql, /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i);
});

test('contains no credential/token/cookie/session artifact', () => {
  for (const forbidden of ['cookie', 'password', 'auth_token', 'session_state', 'storage_state', 'access_token', 'refresh_token', 'anthropic', 'api_key']) {
    assert.doesNotMatch(lowerSql, new RegExp(`"${forbidden}"`));
  }
});

test('contains no SECURITY DEFINER function', () => {
  assert.doesNotMatch(statementsLower, /security definer/);
});

// ── Down migration ─────────────────────────────────────────────────────

test('the down migration lives under supabase/rollback/, not supabase/migrations/', () => {
  assert.ok(fs.existsSync(DOWN_MIGRATION_PATH));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260806031303_create_opponent_intelligence_domain.down.sql')));
});

test('the down migration drops all four new tables and both new constraints, in dependency-safe order', () => {
  const dropOrder = [...downSql.matchAll(/drop table if exists public\.([a-z_]+);/g)].map((m) => m[1]);
  assert.deepEqual(dropOrder, ['coach_scouting_notes', 'opponent_roster_import_conflicts', 'opponent_roster_memberships', 'opponent_players']);
  assert.match(downSql, /alter table public\."games" drop constraint if exists "games_org_id_id_key";/);
  assert.match(downSql, /alter table public\."teams" drop constraint if exists "teams_org_id_id_key";/);
});

test('the down migration documents the pre-adoption-only safety boundary (matches the established convention)', () => {
  assert.match(downSql.toLowerCase(), /pre-adoption/);
});
