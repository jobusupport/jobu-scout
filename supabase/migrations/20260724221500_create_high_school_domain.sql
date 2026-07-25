-- High School domain foundation: programs, seasons, teams, players, and
-- season-specific roster memberships.
--
-- This is deliberately a NEW, standalone domain rather than a reuse of the
-- existing `teams`/`players`/`roster_players` tables -- those are all
-- Travel/GameChanger-scraping-specific (gc_team_url, pg_team_url,
-- is_our_team, gc_player_id, is_pickup) and have no High School analogue.
-- No existing table in this schema models a program, a season, or a
-- season-specific roster membership; this domain is genuinely greenfield.
--
-- ── Hierarchy ────────────────────────────────────────────────────────────
-- organizations (existing) -> hs_programs (one per org) -> hs_seasons /
-- hs_teams -> hs_roster_memberships (join: player x team x season) <-
-- hs_players.
--
-- ── Why players are reusable across seasons, not re-created per season ──
-- hs_players holds durable identity (name, graduation year); a roster
-- membership is a join row connecting an existing player to a specific
-- (team, season) pair. A player who plays Varsity in two different
-- seasons is one hs_players row with two hs_roster_memberships rows, not
-- two player records. This mirrors how org_members joins profiles to
-- organizations rather than duplicating the user per membership.
--
-- ── Cross-program relational integrity (structural, not just app code) ──
-- Every tenant-owned table below carries org_id directly (not only via a
-- parent join) and declares `unique (org_id, id)` alongside its primary
-- key. Every child table's foreign keys to its parents are COMPOSITE --
-- `foreign key (org_id, team_id) references hs_teams (org_id, id)`, not
-- merely `foreign key (team_id) references hs_teams (id)`. Because a
-- roster-membership row's org_id is a single fixed value, Postgres itself
-- refuses an insert whose player_id, team_id, or season_id belongs to a
-- hs_players/hs_teams/hs_seasons row with a DIFFERENT org_id -- there is
-- no composite-FK-satisfying way to connect a player from Program A to a
-- team from Program B. This is enforced by the database, not only by
-- application code that could contain a bug.
--
-- ── ID / timestamp / lifecycle conventions ──────────────────────────────
-- uuid primary keys via extensions.uuid_generate_v4() (the dominant
-- convention: organizations, teams, players all use this, not
-- gen_random_uuid()). created_at/updated_at timestamptz with the existing
-- shared set_updated_at() trigger. Simple entities (program, season, team,
-- player) get a boolean is_active, matching players.is_active's existing
-- precedent for a binary state; hs_roster_memberships gets a small status
-- enum-like text column (active/inactive) since roster status is a
-- slightly richer lifecycle than a single flag, matching
-- roster_players.availability_status's existing precedent for a
-- CHECK-constrained text status column.
--
-- ── RLS ──────────────────────────────────────────────────────────────────
-- Every table below gets RLS enabled with a SELECT-only policy. Unlike the
-- existing org-scoped tables (which only check org membership via
-- auth_user_org_ids()), every policy here ALSO requires the organization's
-- enabled_products to actually include 'high_school' -- this is a
-- deliberate strengthening beyond the existing pattern, since product
-- entitlement is a real access axis for this domain that doesn't exist for
-- Travel tables. No INSERT/UPDATE/DELETE policies are defined in this
-- migration (this slice is read-only) -- Postgres's RLS default-deny means
-- those operations remain unreachable for anon/authenticated roles
-- regardless of table-level grants, matching the existing "RLS enabled,
-- only the policies actually needed, everything else denied by default"
-- convention already used by 11 of the 21 foundational tables.
--
-- The Express server's service_role key bypasses RLS entirely (as it does
-- for every existing table) -- RLS here is defense-in-depth for direct
-- PostgREST/Supabase-client access, not the primary enforcement the new
-- read-only API routes rely on. The API routes independently enforce the
-- identical org + entitlement boundary in application code (see
-- src/high-school-api.js), matching how every existing org-scoped route
-- already works.
--
-- No SECURITY DEFINER function is added by this migration -- none of the
-- required behavior needs one; auth_user_org_ids() (existing) is reused
-- as-is.
--
-- Contains no seed data, no production IDs, and no statement that touches
-- any existing table's data.

-- ── hs_programs ──────────────────────────────────────────────────────────
-- One High School program per organization. No existing business rule in
-- this codebase requires more than one, so it's enforced here.
create table if not exists public.hs_programs (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "name" text not null,
  "school_name" text,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_programs_org_id_key" unique ("org_id"),
  constraint "hs_programs_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_programs_org_id_fkey" foreign key ("org_id") references public.organizations ("id") on delete cascade
);

create trigger trg_hs_programs_updated_at before update on public.hs_programs for each row execute function set_updated_at();

-- ── hs_seasons ───────────────────────────────────────────────────────────
create table if not exists public.hs_seasons (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "name" text not null,
  "school_year" text not null,
  "start_date" date,
  "end_date" date,
  "is_current" boolean not null default false,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_seasons_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_seasons_program_id_name_key" unique ("program_id", "name"),
  constraint "hs_seasons_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_seasons_date_range_check" check ("start_date" is null or "end_date" is null or "end_date" >= "start_date")
);

create trigger trg_hs_seasons_updated_at before update on public.hs_seasons for each row execute function set_updated_at();

create index if not exists idx_hs_seasons_org_id on public.hs_seasons using btree ("org_id");
create index if not exists idx_hs_seasons_program_id on public.hs_seasons using btree ("program_id");

-- ── hs_teams ─────────────────────────────────────────────────────────────
create table if not exists public.hs_teams (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "level" text not null,
  "name" text not null,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_teams_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_teams_program_id_name_key" unique ("program_id", "name"),
  constraint "hs_teams_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_teams_level_check" check ("level" = any (array['varsity'::text, 'junior_varsity'::text, 'freshman'::text]))
);

create trigger trg_hs_teams_updated_at before update on public.hs_teams for each row execute function set_updated_at();

create index if not exists idx_hs_teams_org_id on public.hs_teams using btree ("org_id");
create index if not exists idx_hs_teams_program_id on public.hs_teams using btree ("program_id");

-- ── hs_players ───────────────────────────────────────────────────────────
-- Durable player identity within a program, reused across every season's
-- roster memberships (see header comment). Only foundational identity
-- fields are included -- contact info, guardians, academics, measurements,
-- evaluations, recruiting status, and strength/conditioning metrics are
-- explicitly deferred to future slices, not modeled here.
create table if not exists public.hs_players (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "first_name" text not null,
  "last_name" text not null,
  "preferred_name" text,
  "graduation_year" integer,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_players_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_players_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  -- A durable floor, not a moving window: bounds out obviously-wrong values
  -- (0, negative, transposed digits) without referencing the current date,
  -- so this constraint never goes stale the way a `now()`-relative upper
  -- bound would. No upper bound is enforced -- a hard-coded "current year +
  -- N" ceiling would itself become wrong every year, which is exactly the
  -- brittleness this migration is instructed to avoid.
  constraint "hs_players_graduation_year_check" check ("graduation_year" is null or "graduation_year" >= 2000)
);

create trigger trg_hs_players_updated_at before update on public.hs_players for each row execute function set_updated_at();

create index if not exists idx_hs_players_org_id on public.hs_players using btree ("org_id");
create index if not exists idx_hs_players_program_id on public.hs_players using btree ("program_id");
create index if not exists idx_hs_players_program_name on public.hs_players using btree ("program_id", "last_name", "first_name");

-- ── hs_roster_memberships ────────────────────────────────────────────────
-- Join table: connects one hs_players row to one (hs_teams, hs_seasons)
-- pair. org_id is denormalized here too (not only reachable via a join)
-- specifically so every foreign key below can be composite -- see the
-- header comment for why this is what makes cross-program contamination
-- structurally impossible rather than merely application-enforced.
create table if not exists public.hs_roster_memberships (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "player_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid not null,
  "jersey_number" text,
  "status" text not null default 'active',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_roster_memberships_player_team_season_key" unique ("player_id", "team_id", "season_id"),
  constraint "hs_roster_memberships_org_player_fkey" foreign key ("org_id", "player_id") references public.hs_players ("org_id", "id") on delete cascade,
  constraint "hs_roster_memberships_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_roster_memberships_org_season_fkey" foreign key ("org_id", "season_id") references public.hs_seasons ("org_id", "id") on delete cascade,
  constraint "hs_roster_memberships_status_check" check ("status" = any (array['active'::text, 'inactive'::text]))
);

create trigger trg_hs_roster_memberships_updated_at before update on public.hs_roster_memberships for each row execute function set_updated_at();

create index if not exists idx_hs_roster_memberships_org_id on public.hs_roster_memberships using btree ("org_id");
create index if not exists idx_hs_roster_memberships_team_season on public.hs_roster_memberships using btree ("team_id", "season_id");
create index if not exists idx_hs_roster_memberships_player_id on public.hs_roster_memberships using btree ("player_id");

-- ── Row Level Security ───────────────────────────────────────────────────
alter table public.hs_programs enable row level security;
alter table public.hs_seasons enable row level security;
alter table public.hs_teams enable row level security;
alter table public.hs_players enable row level security;
alter table public.hs_roster_memberships enable row level security;

create policy "hs_programs_select" on public.hs_programs
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_programs"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_seasons_select" on public.hs_seasons
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_seasons"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_teams_select" on public.hs_teams
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_teams"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_players_select" on public.hs_players
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_players"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_roster_memberships_select" on public.hs_roster_memberships
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_roster_memberships"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

-- No explicit GRANT statements: Supabase auto-grants the standard
-- anon/authenticated/service_role privilege set to every new table (see
-- 20260620000005_foundational_triggers_and_grants.sql's own comment on
-- this), and RLS (enabled above, SELECT-only policies) is what actually
-- restricts access -- matching the existing convention for every ordinary
-- (non-SECURITY-DEFINER) table in this schema.
