-- Opponent rosters and coach scouting intelligence (Travel domain).
--
-- Adds a durable opponent-player identity model (mirroring the High School
-- domain's players/roster-memberships split -- see
-- 20260724221500_create_high_school_domain.sql's own header for the
-- original rationale, reused here verbatim) plus a coach-authored scouting
-- notes capability, both scoped to the existing `teams` table's
-- is_our_team=false rows (an "opponent" IS a teams row with
-- is_our_team=false; no new team-level entity is introduced).
--
-- ── Why players are separate from roster memberships ─────────────────────
-- Exactly the same reasoning as hs_players/hs_roster_memberships: an
-- opponent_players row is durable identity (name, bats/throws, class), and
-- an opponent_roster_memberships row is a join connecting that identity to
-- a specific team at a specific time. Jersey numbers live ONLY on the
-- membership row, never on the player -- jersey numbers change between
-- games and seasons and must never be used as identity (explicit product
-- requirement). A player observed on the same team across multiple
-- scrimmage seasons is one opponent_players row with multiple
-- opponent_roster_memberships rows, never re-created.
--
-- ── Why this reuses `teams`/`games` rather than a parallel "opponents"
--    table ────────────────────────────────────────────────────────────────
-- `teams.is_our_team=false` already IS this codebase's opponent concept
-- (see src/generate-report.js's own comments: "almost every team in this
-- DB is a scouted opponent"). Inventing a second table would create two
-- competing opponent identities for the same real-world team. `teams` and
-- `games` currently only have a bare `primary key (id)`, so composite
-- foreign keys (the structural, database-enforced tenant-isolation pattern
-- the High School domain migration established) are not yet possible
-- against them -- this migration adds the missing `unique (org_id, id)`
-- constraint to both, which is safe and free: id is already the primary
-- key, so (org_id, id) is trivially already unique for every existing row.
--
-- ── Provenance / coach-confirmed-value protection ─────────────────────────
-- opponent_players.confirmed_fields is a text[] naming which of this
-- player's fields (first_name, last_name, positions, bats, throws,
-- class_or_grad_year) a coach has manually entered/edited. Application code
-- (not this migration) is responsible for never overwriting a confirmed
-- field from imported/scraped data -- see src/opponent-roster-service.js.
-- opponent_roster_import_conflicts records what an import WANTED to write
-- when it disagreed with a confirmed field, so nothing is silently
-- discarded; a human can review and explicitly accept the import value
-- later without that decision being invented by this schema.
--
-- ── RLS ────────────────────────────────────────────────────────────────────
-- Every table below gets RLS enabled with a SELECT-only policy, scoped by
-- `org_id in (select auth_user_org_ids())` AND the organization's
-- `enabled_products @> array['travel']` -- identical idiom to the High
-- School domain's policies, substituting the 'travel' entitlement (this is
-- Travel-domain functionality). All writes go through the service-role
-- `adminClient` from server-side routes that independently enforce the same
-- org + entitlement boundary in application code (src/opponent-roster-service.js
-- / src/coach-notes-service.js), matching the codebase's existing
-- "RLS is defense-in-depth, not the only enforcement" convention.
--
-- Contains no seed data, no production IDs, and no statement that touches
-- any existing table's data (the two `unique (org_id, id)` additions below
-- are pure constraint additions -- they do not read, write, or lock rows
-- beyond the constraint-validation scan Postgres performs automatically).

-- ── Composite-FK readiness for existing tables ────────────────────────────
alter table public."teams" add constraint "teams_org_id_id_key" unique ("org_id", "id");
alter table public."games" add constraint "games_org_id_id_key" unique ("org_id", "id");

-- ── opponent_players ───────────────────────────────────────────────────────
create table if not exists public.opponent_players (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "team_id" uuid not null,
  "first_name" text not null,
  "last_name" text not null,
  "positions" text[] not null default '{}',
  "bats" text,
  "throws" text,
  "class_or_grad_year" text,
  "status" text not null default 'active',
  "record_source" text not null default 'manual',
  -- Field names this player's data a coach has manually entered/edited and
  -- that must never be silently overwritten by an import -- see header.
  "confirmed_fields" text[] not null default '{}',
  "gc_match_status" text,
  "last_observed_at" timestamptz,
  "normalized_first_name" text generated always as (lower(trim("first_name"))) stored,
  "normalized_last_name" text generated always as (lower(trim("last_name"))) stored,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "opponent_players_org_id_id_key" unique ("org_id", "id"),
  constraint "opponent_players_org_team_fkey" foreign key ("org_id", "team_id") references public."teams" ("org_id", "id") on delete cascade,
  constraint "opponent_players_bats_check" check ("bats" is null or "bats" = any (array['L'::text, 'R'::text, 'S'::text])),
  constraint "opponent_players_throws_check" check ("throws" is null or "throws" = any (array['L'::text, 'R'::text])),
  constraint "opponent_players_status_check" check ("status" = any (array['active'::text, 'graduated'::text, 'transferred'::text, 'not_participating'::text, 'other_non_returning'::text])),
  constraint "opponent_players_record_source_check" check ("record_source" = any (array['manual'::text, 'gamechanger'::text])),
  constraint "opponent_players_gc_match_status_check" check ("gc_match_status" is null or "gc_match_status" = any (array['confirmed'::text, 'ambiguous'::text]))
);

create trigger trg_opponent_players_updated_at before update on public.opponent_players for each row execute function set_updated_at();

create index if not exists idx_opponent_players_org_id on public.opponent_players using btree ("org_id");
create index if not exists idx_opponent_players_team_id on public.opponent_players using btree ("team_id");
create index if not exists idx_opponent_players_team_normalized_name on public.opponent_players using btree ("team_id", "normalized_last_name", "normalized_first_name");

-- ── opponent_roster_memberships ────────────────────────────────────────────
-- jersey_number lives HERE, never on opponent_players -- see header. A NULL
-- season_label (manual add with no season specified) is intentionally not
-- deduplicated against another NULL for the same player+team (standard SQL
-- NULL-distinctness in a unique constraint) -- the same tradeoff
-- hs_roster_memberships accepts implicitly via its own season_id being
-- always-required; this table's season_label is optional because Travel
-- has no formal season entity, so perfect dedup on "no season given" isn't
-- achievable without inventing one.
create table if not exists public.opponent_roster_memberships (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "opponent_player_id" uuid not null,
  "team_id" uuid not null,
  "jersey_number" text,
  "season_label" text,
  "status" text not null default 'active',
  "record_source" text not null default 'manual',
  "first_observed_at" date,
  "last_observed_at" date,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "opponent_roster_memberships_player_team_season_key" unique ("opponent_player_id", "team_id", "season_label"),
  constraint "opponent_roster_memberships_org_player_fkey" foreign key ("org_id", "opponent_player_id") references public.opponent_players ("org_id", "id") on delete cascade,
  constraint "opponent_roster_memberships_org_team_fkey" foreign key ("org_id", "team_id") references public."teams" ("org_id", "id") on delete cascade,
  constraint "opponent_roster_memberships_status_check" check ("status" = any (array['active'::text, 'inactive'::text])),
  constraint "opponent_roster_memberships_record_source_check" check ("record_source" = any (array['manual'::text, 'gamechanger'::text]))
);

create trigger trg_opponent_roster_memberships_updated_at before update on public.opponent_roster_memberships for each row execute function set_updated_at();

create index if not exists idx_opponent_roster_memberships_org_id on public.opponent_roster_memberships using btree ("org_id");
create index if not exists idx_opponent_roster_memberships_team_id on public.opponent_roster_memberships using btree ("team_id");
create index if not exists idx_opponent_roster_memberships_player_id on public.opponent_roster_memberships using btree ("opponent_player_id");

-- ── opponent_roster_import_conflicts ───────────────────────────────────────
-- Append-only audit trail: one row per field-level disagreement an import
-- encountered against a coach-confirmed value. Never mutated by the import
-- itself -- only a human reviewing the conflict sets resolved_at/resolution.
create table if not exists public.opponent_roster_import_conflicts (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "opponent_player_id" uuid not null,
  "field_name" text not null,
  "coach_confirmed_value" text,
  "imported_value" text,
  "source" text not null default 'gamechanger',
  "detected_at" timestamptz not null default now(),
  "resolved_at" timestamptz,
  "resolution" text,
  primary key ("id"),
  constraint "opponent_roster_import_conflicts_org_player_fkey" foreign key ("org_id", "opponent_player_id") references public.opponent_players ("org_id", "id") on delete cascade,
  constraint "opponent_roster_import_conflicts_resolution_check" check ("resolution" is null or "resolution" = any (array['kept_coach_value'::text, 'accepted_import_value'::text]))
);

create index if not exists idx_opponent_roster_import_conflicts_org_id on public.opponent_roster_import_conflicts using btree ("org_id");
create index if not exists idx_opponent_roster_import_conflicts_player_id on public.opponent_roster_import_conflicts using btree ("opponent_player_id");
create index if not exists idx_opponent_roster_import_conflicts_unresolved on public.opponent_roster_import_conflicts using btree ("opponent_player_id") where "resolved_at" is null;

-- ── coach_scouting_notes ────────────────────────────────────────────────────
-- Supports all four required levels via optional (nullable) scoping
-- columns: team-level (opponent_player_id/game_id both null), player-level
-- (opponent_player_id set), game-level (game_id set), and a play/situation
-- observation (note_text itself carries the situational detail -- no
-- separate play-identifier column exists anywhere in this schema to key
-- against, so this is expressed as a game-level note whose text names the
-- specific play/situation, consistent with how this codebase already
-- represents free-text coach input elsewhere, e.g. roster_players has no
-- structured "situation" column either).
--
-- include_in_report/is_archived are two independent booleans on purpose:
-- archiving is "this note was wrong/no longer relevant" (a correction),
-- excluding is "this note is still true but shouldn't go in THIS report"
-- (a per-report editorial choice) -- conflating them would make it
-- impossible to temporarily exclude a note without losing it entirely.
create table if not exists public.coach_scouting_notes (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "author_user_id" uuid not null,
  "opponent_team_id" uuid not null,
  "opponent_player_id" uuid,
  "game_id" uuid,
  "observed_game_date" date,
  "note_text" text not null,
  "category" text,
  "include_in_report" boolean not null default true,
  "is_archived" boolean not null default false,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "coach_scouting_notes_org_team_fkey" foreign key ("org_id", "opponent_team_id") references public."teams" ("org_id", "id") on delete cascade,
  constraint "coach_scouting_notes_org_player_fkey" foreign key ("org_id", "opponent_player_id") references public.opponent_players ("org_id", "id") on delete cascade,
  constraint "coach_scouting_notes_org_game_fkey" foreign key ("org_id", "game_id") references public."games" ("org_id", "id") on delete cascade,
  constraint "coach_scouting_notes_org_author_fkey" foreign key ("author_user_id") references auth.users ("id") on delete cascade,
  constraint "coach_scouting_notes_text_not_blank_check" check (char_length(trim("note_text")) > 0),
  constraint "coach_scouting_notes_text_length_check" check (char_length("note_text") <= 4000),
  constraint "coach_scouting_notes_category_check" check (
    "category" is null or "category" = any (array[
      'lineup'::text, 'hitting_approach'::text, 'pitching'::text, 'defense'::text,
      'baserunning'::text, 'tendencies'::text, 'personnel'::text,
      'injury_availability'::text, 'situational'::text, 'general'::text
    ])
  )
);

create trigger trg_coach_scouting_notes_updated_at before update on public.coach_scouting_notes for each row execute function set_updated_at();

create index if not exists idx_coach_scouting_notes_org_id on public.coach_scouting_notes using btree ("org_id");
create index if not exists idx_coach_scouting_notes_team_id on public.coach_scouting_notes using btree ("opponent_team_id");
create index if not exists idx_coach_scouting_notes_player_id on public.coach_scouting_notes using btree ("opponent_player_id") where "opponent_player_id" is not null;
create index if not exists idx_coach_scouting_notes_game_id on public.coach_scouting_notes using btree ("game_id") where "game_id" is not null;
-- The exact filter the report-context builder queries by: active, included,
-- for one team, most-recently-updated first.
create index if not exists idx_coach_scouting_notes_report_context on public.coach_scouting_notes using btree ("opponent_team_id", "updated_at" desc) where "is_archived" = false and "include_in_report" = true;

-- ── Row Level Security ───────────────────────────────────────────────────
alter table public.opponent_players enable row level security;
alter table public.opponent_roster_memberships enable row level security;
alter table public.opponent_roster_import_conflicts enable row level security;
alter table public.coach_scouting_notes enable row level security;

create policy "opponent_players_select" on public.opponent_players
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "opponent_players"."org_id"
        and "o"."enabled_products" @> array['travel']::text[]
    )
  );

create policy "opponent_roster_memberships_select" on public.opponent_roster_memberships
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "opponent_roster_memberships"."org_id"
        and "o"."enabled_products" @> array['travel']::text[]
    )
  );

create policy "opponent_roster_import_conflicts_select" on public.opponent_roster_import_conflicts
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "opponent_roster_import_conflicts"."org_id"
        and "o"."enabled_products" @> array['travel']::text[]
    )
  );

create policy "coach_scouting_notes_select" on public.coach_scouting_notes
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "coach_scouting_notes"."org_id"
        and "o"."enabled_products" @> array['travel']::text[]
    )
  );

-- No explicit GRANT statements: Supabase auto-grants the standard
-- anon/authenticated/service_role privilege set to every new table (see
-- 20260620000005_foundational_triggers_and_grants.sql's own comment on
-- this), and RLS (enabled above, SELECT-only policies) is what actually
-- restricts access -- matching the existing convention for every ordinary
-- (non-SECURITY-DEFINER) table in this schema.
