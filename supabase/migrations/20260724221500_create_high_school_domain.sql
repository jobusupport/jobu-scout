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
--
-- ── GameChanger roster-import readiness ─────────────────────────────────
-- The columns below exist so a FUTURE importer (not built by this
-- migration) can sync High School rosters from GameChanger. No scraper or
-- synchronization code is added here -- this is schema only, and every
-- field choice below is grounded in what this codebase's EXISTING
-- GameChanger scraping code actually does today, not invented semantics:
--
-- * gc_player_id (the equivalent Travel-domain column, on public.players)
--   is DEAD CODE -- grepping the entire repository shows nothing ever
--   assigns it a value. It is not proof that GameChanger exposes a
--   reliable, durable per-person player ID. Accordingly, hs_players below
--   does NOT get a bare "gc player id" column -- inventing one would
--   contradict the evidence. The one place a GC-issued player identifier
--   MIGHT plausibly be captured in the future is scoped to
--   hs_roster_memberships (team+season), because the one historical
--   precedent for this concept in this codebase (players_team_id_gc_
--   player_id_key) was itself team-scoped, never claimed to be stable
--   across teams or seasons for the same person.
-- * Jersey numbers are extracted from both a roster page and box scores in
--   the existing scrapers (src/search-gamechanger-teams.js,
--   src/scrape-handedness.js), always as text, never coerced to a number,
--   with leading zeros preserved end-to-end
--   (src/db-supabase.js's jersey_number: String(...) writes). This
--   migration's existing hs_roster_memberships.jersey_number text column
--   already matches that convention -- unchanged here.
-- * Two different real players sharing a name is an EXPLICITLY
--   acknowledged, accepted risk in the existing codebase
--   (src/scrape-handedness.js's buildMatchKey doc comment: "Two players
--   sharing a last name + first initial on one roster will collide on
--   this key -- acceptable for now; jersey_number is the real identity
--   used for roster diffing"). Normalized-name columns added below are
--   therefore candidate-matching aids only, never a uniqueness/identity
--   constraint -- the future importer's job (documented, not implemented,
--   below) is to use a real external ID when one is available and fall
--   back to jersey number + normalized name only to produce candidates,
--   never to silently merge on name alone.
-- * teams.gc_team_url has NO unique constraint in the existing schema --
--   it had one in the old SQLite schema and was deliberately DROPPED
--   (see fix-gc-url-constraint.js's own header: "Multiple teams can
--   legitimately have no GC URL (null), which violates a UNIQUE
--   constraint when more than one row is null"). Every nullable
--   GameChanger identifier added below is therefore protected by a
--   PARTIAL unique index (WHERE column IS NOT NULL), scoped by org_id (or
--   by team_id/season_id where the identifier's own scope requires it) --
--   never a bare column-level UNIQUE -- to avoid reintroducing that exact
--   already-fixed bug.
-- * GameChanger authentication is entirely file-based
--   (storage/gamechanger-auth.json, a Playwright storageState -- see
--   src/login-gamechanger.js) and lives OUTSIDE the database everywhere
--   in this codebase today. Nothing added below stores a credential,
--   token, cookie, or browser-session artifact of any kind, and nothing
--   ever will -- that separation is intentional and permanent, not an
--   oversight to fix later.
--
-- See src/high-school-importer-contract.js for the documented (not
-- implemented) future importer contract and conflict-resolution policy
-- this schema is designed to support.

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
-- record_source / roster_sync_* / gc_* columns exist for the future
-- GameChanger roster importer (see the GameChanger roster-import
-- readiness note above and src/high-school-importer-contract.js) -- no
-- synchronization code runs against them yet. gc_team_url is the primary,
-- reliably-capturable GameChanger identifier (this codebase's scrapers
-- already capture the analogous teams.gc_team_url reliably); gc_external_
-- team_id has NO existing extraction code anywhere in this repository and
-- is included purely for forward compatibility, not because a stable team
-- ID is proven to exist today.
create table if not exists public.hs_teams (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "level" text not null,
  "name" text not null,
  "is_active" boolean not null default true,
  "record_source" text not null default 'manual',
  "gc_team_url" text,
  "gc_external_team_id" text,
  "roster_sync_status" text not null default 'never',
  "roster_sync_attempted_at" timestamptz,
  "roster_sync_succeeded_at" timestamptz,
  -- Sanitized status detail only -- never a raw error object, stack
  -- trace, or scraped HTML. Bounded so a future importer cannot
  -- accidentally persist an unbounded blob here; anything needing more
  -- detail belongs in application logs, not this row.
  "roster_sync_error" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_teams_org_id_id_key" unique ("org_id", "id"),
  constraint "hs_teams_program_id_name_key" unique ("program_id", "name"),
  constraint "hs_teams_org_program_fkey" foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_teams_level_check" check ("level" = any (array['varsity'::text, 'junior_varsity'::text, 'freshman'::text])),
  constraint "hs_teams_record_source_check" check ("record_source" = any (array['manual'::text, 'gamechanger'::text])),
  constraint "hs_teams_roster_sync_status_check" check ("roster_sync_status" = any (array['never'::text, 'pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text])),
  constraint "hs_teams_roster_sync_error_length_check" check ("roster_sync_error" is null or char_length("roster_sync_error") <= 2000)
);

create trigger trg_hs_teams_updated_at before update on public.hs_teams for each row execute function set_updated_at();

create index if not exists idx_hs_teams_org_id on public.hs_teams using btree ("org_id");
create index if not exists idx_hs_teams_program_id on public.hs_teams using btree ("program_id");

-- Partial (nullable-safe) unique indexes, not a bare column-level UNIQUE --
-- see the GameChanger roster-import readiness note above for why: a bare
-- UNIQUE on a nullable GameChanger identifier already broke exactly this
-- way once in this codebase's Travel domain (fix-gc-url-constraint.js).
create unique index if not exists idx_hs_teams_org_gc_team_url on public.hs_teams ("org_id", "gc_team_url") where "gc_team_url" is not null;
create unique index if not exists idx_hs_teams_org_gc_external_team_id on public.hs_teams ("org_id", "gc_external_team_id") where "gc_external_team_id" is not null;

-- ── hs_players ───────────────────────────────────────────────────────────
-- Durable player identity within a program, reused across every season's
-- roster memberships (see header comment). Only foundational identity
-- fields are included -- contact info, guardians, academics, measurements,
-- evaluations, recruiting status, and strength/conditioning metrics are
-- explicitly deferred to future slices, not modeled here.
--
-- Deliberately NO gc_player_id-shaped column here -- see the GameChanger
-- roster-import readiness note above for why: the existing, unpopulated
-- players.gc_player_id precedent was itself team-scoped, so a value here
-- (which spans every team/season a player has ever been on) would be
-- inventing stability the evidence doesn't support. normalized_first_name
-- / normalized_last_name are generated (always kept in sync, never drift
-- from first_name/last_name) and exist ONLY as candidate-matching aids for
-- a future importer -- never a uniqueness constraint, never proof two rows
-- are the same person (see the same-name-collision note above).
create table if not exists public.hs_players (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "first_name" text not null,
  "last_name" text not null,
  "preferred_name" text,
  "graduation_year" integer,
  "is_active" boolean not null default true,
  "record_source" text not null default 'manual',
  "normalized_first_name" text generated always as (lower(trim("first_name"))) stored,
  "normalized_last_name" text generated always as (lower(trim("last_name"))) stored,
  -- Set by a future importer only when normalized-name matching finds
  -- more than one plausible candidate and nothing (jersey number, a
  -- roster-scoped GC id) disambiguates -- see hs_players_gc_match_status_check
  -- for the allowed values. NULL means "no ambiguity has ever been
  -- flagged for this player," not "confirmed identity."
  "gc_match_status" text,
  "last_observed_at" timestamptz,
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
  constraint "hs_players_graduation_year_check" check ("graduation_year" is null or "graduation_year" >= 2000),
  constraint "hs_players_record_source_check" check ("record_source" = any (array['manual'::text, 'gamechanger'::text])),
  constraint "hs_players_gc_match_status_check" check ("gc_match_status" is null or "gc_match_status" = any (array['confirmed'::text, 'ambiguous'::text]))
);

create trigger trg_hs_players_updated_at before update on public.hs_players for each row execute function set_updated_at();

create index if not exists idx_hs_players_org_id on public.hs_players using btree ("org_id");
create index if not exists idx_hs_players_program_id on public.hs_players using btree ("program_id");
create index if not exists idx_hs_players_program_name on public.hs_players using btree ("program_id", "last_name", "first_name");
create index if not exists idx_hs_players_program_normalized_name on public.hs_players using btree ("program_id", "normalized_last_name", "normalized_first_name");

-- ── hs_roster_memberships ────────────────────────────────────────────────
-- Join table: connects one hs_players row to one (hs_teams, hs_seasons)
-- pair. org_id is denormalized here too (not only reachable via a join)
-- specifically so every foreign key below can be composite -- see the
-- header comment for why this is what makes cross-program contamination
-- structurally impossible rather than merely application-enforced.
--
-- jersey_number belongs HERE, not on hs_players -- it is a property of a
-- specific team+season membership, not permanent player identity (a
-- player can wear a different number on a different team, or in a
-- different season on the same team). Already text (unchanged): every
-- existing GameChanger jersey-number extraction path in this codebase
-- (src/db-supabase.js, src/scrape-handedness.js) stores it as a string
-- and preserves leading zeros end-to-end -- there was never a numeric
-- jersey_number to correct here.
--
-- gc_external_player_id is scoped to THIS table (team+season), not
-- hs_players, because that is the only scope any GameChanger player
-- identifier has ever had precedent for in this codebase (see the
-- GameChanger roster-import readiness note above) -- a future importer
-- uses it as the strongest match signal for reconciling a SPECIFIC team's
-- roster against a previous import of that same team+season, never as a
-- cross-team/cross-season person identifier.
--
-- "status" (already present) doubles as the reconciliation state a future
-- importer needs: 'active' means currently observed/expected on the
-- roster, 'inactive' means not re-observed in the latest sync (or
-- manually removed) -- reconciliation is always an UPDATE of this column,
-- never a DELETE, so historical membership is preserved by construction.
create table if not exists public.hs_roster_memberships (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "player_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid not null,
  "jersey_number" text,
  "status" text not null default 'active',
  "record_source" text not null default 'manual',
  "gc_external_player_id" text,
  "last_observed_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_roster_memberships_player_team_season_key" unique ("player_id", "team_id", "season_id"),
  constraint "hs_roster_memberships_org_player_fkey" foreign key ("org_id", "player_id") references public.hs_players ("org_id", "id") on delete cascade,
  constraint "hs_roster_memberships_org_team_fkey" foreign key ("org_id", "team_id") references public.hs_teams ("org_id", "id") on delete cascade,
  constraint "hs_roster_memberships_org_season_fkey" foreign key ("org_id", "season_id") references public.hs_seasons ("org_id", "id") on delete cascade,
  constraint "hs_roster_memberships_status_check" check ("status" = any (array['active'::text, 'inactive'::text])),
  constraint "hs_roster_memberships_record_source_check" check ("record_source" = any (array['manual'::text, 'gamechanger'::text]))
);

create trigger trg_hs_roster_memberships_updated_at before update on public.hs_roster_memberships for each row execute function set_updated_at();

create index if not exists idx_hs_roster_memberships_org_id on public.hs_roster_memberships using btree ("org_id");
create index if not exists idx_hs_roster_memberships_team_season on public.hs_roster_memberships using btree ("team_id", "season_id");
create index if not exists idx_hs_roster_memberships_player_id on public.hs_roster_memberships using btree ("player_id");

-- Partial unique index, not a bare column-level UNIQUE, for the same
-- nullable-GameChanger-identifier reason as hs_teams above. Scoped to
-- (team_id, season_id) -- the only scope this identifier has precedent
-- for -- not globally and not merely by org_id.
create unique index if not exists idx_hs_roster_memberships_team_season_gc_player on public.hs_roster_memberships ("team_id", "season_id", "gc_external_player_id") where "gc_external_player_id" is not null;

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
