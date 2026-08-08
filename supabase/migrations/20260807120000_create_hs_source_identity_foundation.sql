-- High School GameChanger source-identity foundation (Slice 1 of the
-- schedule-driven onboarding / opponent-monitoring importer design).
--
-- Schema-only. No routes, services, UI, RPCs, or writes to any existing
-- table's data. Adds six new tables plus two additive supporting unique
-- constraints on hs_teams/hs_seasons (see Step 1 below) -- nothing else
-- about those two tables, or any other existing table, is touched.
--
-- This migration implements the corrected design from the "HS GameChanger
-- Importer -- Identity Model Correction" design series (v4-v6). It exists
-- because a prior draft of this same design proposed:
--   * a flat hs_opponent_teams table combining durable opponent-school
--     identity with GameChanger-source identity in one row;
--   * unique(opponent_program_id, season_id) on that table, which would
--     have made it impossible for one opponent school to field Freshman,
--     JV, and Varsity teams in the same season;
--   * unique(org_id, normalized_name) on an opponent-program table, which
--     would have made it impossible to create a second real school whose
--     name happens to normalize identically to an existing one;
--   * a "hs_source_seasons" table described as informational but used as
--     an identity/uniqueness boundary;
--   * a global partial-unique constraint on a bare source_team_id, which
--     would have prevented reusing the same real-world GameChanger team
--     across two different tracking seasons;
--   * self-referencing supersession FKs proving only shared org_id, so a
--     registration for one team/season could be recorded as "superseded
--     by" a replacement belonging to a different team, season, or program;
--   * a one-directional supersession CHECK that only validated the
--     'superseded' branch, silently permitting any other status to carry
--     stray supersession metadata.
-- None of that is implemented here. This migration implements the fully
-- corrected model instead.
--
-- ── The core technique this migration relies on, repeatedly ─────────────
-- When a row claims to sit under two different parents at once (a team
-- *and* a program; a source team *and* a season; a replacement row *and*
-- the exact slot it replaces), a single-parent foreign key cannot prove
-- the two parents agree. Every fix below instead makes both foreign keys
-- check against the *same shared column value* on the child row -- if the
-- two parents disagree about what that value should be, one of the two
-- foreign keys simply has no matching row, and Postgres rejects the
-- insert/update before any application code runs. This requires the
-- referenced parent to expose a unique constraint that includes the
-- shared column, which is what Step 1 and each table's own constraints
-- below provide.
--
-- ── Verified starting constraints (re-checked immediately before writing
--    this migration, not assumed) ─────────────────────────────────────
-- hs_programs: unique(org_id) [hs_programs_org_id_key] -- exactly one
--   program per org today -- AND unique(org_id, id) [hs_programs_org_id_id_key].
-- hs_teams: unique(org_id, id) and unique(program_id, name) -- NO unique
--   constraint covering (org_id, program_id, id).
-- hs_seasons: unique(org_id, id) and unique(program_id, name) -- NO
--   unique constraint covering (org_id, program_id, id).
-- hs_teams.level uses ('varsity','junior_varsity','freshman') -- this
--   migration's own level vocabulary on hs_opponent_teams is aligned to
--   match exactly (plus 'unknown', which hs_teams has no need for since
--   an own team's level is always known).
--
-- ── Note on hs_programs.unique(org_id) and cross-program testing ────────
-- Because hs_programs enforces exactly one program per organization today,
-- it is not possible to construct two real hs_programs rows under one org
-- to exercise a "genuine two-program" cross-program test fixture -- any
-- attempt to insert a second hs_programs row for an existing org_id is
-- rejected by hs_programs_org_id_key before this migration's own
-- constraints are ever reached. The composite FKs added below still
-- provide real protection: they reject any row whose team_id/season_id
-- do not actually belong to its own stated program_id, which covers a
-- caller/service bug supplying an incorrect program_id today, and would
-- automatically extend to cover true multi-program cross-contamination
-- the moment (if ever) hs_programs_org_id_key is relaxed, with zero
-- additional schema work required then. The accompanying test suite
-- exercises this today using a syntactically-valid but non-existent
-- program_id, and documents hs_programs_org_id_key by name as the
-- constraint that would reject the alternative "two real programs, one
-- org" setup, rather than silently substituting a weaker test.
--
-- ── Note on MATCH SIMPLE (corrects an earlier inaccurate description) ──
-- PostgreSQL's default MATCH SIMPLE skips a composite foreign-key check
-- when *any* referencing column is null -- not only when *all* of them
-- are. Every scope column on the two self-referencing FKs below (org_id,
-- program_id, team_id/opponent_team_id, season_id) is NOT NULL; the only
-- nullable column in either referencing tuple is the supersession pointer
-- itself (superseded_by_registration_id / superseded_by_link_id). Because
-- that is the *only* column that can ever be null in these particular
-- tuples, "the check is skipped when any column is null" and "the check
-- is skipped when the pointer is null" describe the identical, correct
-- behavior here -- but the general MATCH SIMPLE rule is "any", not "all",
-- and is stated that way from here on.

-- ── Step 1: two additive constraints on existing tables ─────────────────
-- Both are supersets of each table's existing primary key on id alone, so
-- no existing row can violate them; neither statement alters, renames, or
-- drops any existing column, index, or the data in either table.

alter table public.hs_teams
  add constraint hs_teams_org_program_id_key unique (org_id, program_id, id);

alter table public.hs_seasons
  add constraint hs_seasons_org_program_id_key unique (org_id, program_id, id);

-- ── Step 2: six new tables ────────────────────────────────────────────

-- hs_source_teams: durable external GameChanger team identity, discovered
-- independently of what it's eventually linked to.
create table if not exists public.hs_source_teams (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "source_provider" text not null check ("source_provider" = 'gamechanger'),
  "source_team_ref" text not null,
  "source_team_url" text,
  "display_name_observed" text,
  "first_observed_at" timestamptz not null default now(),
  "last_observed_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_source_teams_org_id_key" unique ("org_id", "id"),
  constraint "hs_source_teams_org_provider_ref_key" unique ("org_id", "source_provider", "source_team_ref"),
  constraint "hs_source_teams_org_id_fkey" foreign key ("org_id") references public.organizations ("id") on delete cascade
);

create unique index if not exists idx_hs_source_teams_org_url
  on public.hs_source_teams ("org_id", "source_team_url")
  where "source_team_url" is not null;

create index if not exists idx_hs_source_teams_org_id on public.hs_source_teams using btree ("org_id");

-- hs_source_team_contexts: the scoping boundary for anything GC-reference-
-- shaped, anchored to OUR OWN hs_season_id -- never anything GameChanger
-- itself calls a season, since that concept's stability is unverified
-- (the legacy Travel scraper hardcodes one global season/year per run;
-- see the design report's finding).
create table if not exists public.hs_source_team_contexts (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "source_team_id" uuid not null,
  "hs_season_id" uuid not null,
  "observed_season_label" text,
  "first_observed_at" timestamptz not null default now(),
  "last_observed_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_source_team_contexts_org_id_key" unique ("org_id", "id"),
  -- The table's natural key: this is the sole FK target every later table
  -- in this migration uses to prove "this source team, in this season."
  -- No surrogate-id-based unique key is added -- nothing references it.
  constraint "hs_source_team_contexts_team_season_key" unique ("org_id", "source_team_id", "hs_season_id"),
  constraint "hs_source_team_contexts_org_source_team_fkey"
    foreign key ("org_id", "source_team_id") references public.hs_source_teams ("org_id", "id") on delete cascade,
  constraint "hs_source_team_contexts_org_season_fkey"
    foreign key ("org_id", "hs_season_id") references public.hs_seasons ("org_id", "id") on delete cascade
);

create index if not exists idx_hs_source_team_contexts_org_id on public.hs_source_team_contexts using btree ("org_id");

-- hs_team_source_registrations: durable, season-scoped binding of a Jobu
-- OWN team to an external source team. hs_teams.gc_team_url/
-- gc_external_team_id are NOT modified or read by this table -- see the
-- migration header for the coexistence plan (out of scope for this slice).
create table if not exists public.hs_team_source_registrations (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "team_id" uuid not null,
  "season_id" uuid not null,
  "source_team_id" uuid not null,
  "status" text not null default 'pending' check ("status" in ('pending', 'active', 'superseded', 'rejected')),
  "superseded_at" timestamptz,
  "superseded_by_registration_id" uuid,
  "record_source" text not null default 'manual' check ("record_source" in ('manual', 'gamechanger')),
  "decided_by_user_id" uuid,
  "decided_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),

  -- Sole self-reference target -- a narrower unique(org_id, id) is
  -- deliberately NOT also added; nothing else in this schema references
  -- this table as a parent.
  constraint "hs_team_source_registrations_scope_id_key"
    unique ("org_id", "program_id", "team_id", "season_id", "id"),

  constraint "hs_team_source_registrations_org_program_fkey"
    foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade,
  constraint "hs_team_source_registrations_org_program_team_fkey"
    foreign key ("org_id", "program_id", "team_id") references public.hs_teams ("org_id", "program_id", "id") on delete cascade,
  constraint "hs_team_source_registrations_org_program_season_fkey"
    foreign key ("org_id", "program_id", "season_id") references public.hs_seasons ("org_id", "program_id", "id") on delete cascade,
  constraint "hs_team_source_registrations_org_source_team_fkey"
    foreign key ("org_id", "source_team_id") references public.hs_source_teams ("org_id", "id") on delete cascade,
  constraint "hs_team_source_registrations_org_source_context_fkey"
    foreign key ("org_id", "source_team_id", "season_id")
    references public.hs_source_team_contexts ("org_id", "source_team_id", "hs_season_id") on delete cascade,
  -- Same-scope supersession proof: the replacement must belong to the
  -- exact same program/team/season as the row it replaces. Deliberately
  -- does NOT include source_team_id -- a replacement's whole purpose is
  -- usually to change which source team is bound.
  constraint "hs_team_source_registrations_superseded_by_same_scope_fkey"
    foreign key ("org_id", "program_id", "team_id", "season_id", "superseded_by_registration_id")
    references public.hs_team_source_registrations ("org_id", "program_id", "team_id", "season_id", "id"),

  constraint "hs_team_source_registrations_rejected_requires_decision_check"
    check ("status" <> 'rejected' or ("decided_by_user_id" is not null and "decided_at" is not null)),

  -- Bidirectional: 'superseded' requires both fields set; every other
  -- status requires both fields null. Every leaf predicate here is
  -- IS [NOT] NULL or a comparison against a NOT NULL column, so the whole
  -- expression is always a real boolean, never Postgres's NULL-passes-CHECK
  -- case.
  constraint "hs_team_source_registrations_supersession_consistent_check"
    check (
      ("status" = 'superseded' and "superseded_at" is not null and "superseded_by_registration_id" is not null)
      or
      ("status" <> 'superseded' and "superseded_at" is null and "superseded_by_registration_id" is null)
    )
);

-- Sole "one active registration per team/season" enforcement -- a plain
-- table-level UNIQUE constraint cannot carry a WHERE clause, so this must
-- be a partial index rather than a CREATE TABLE constraint. 'pending' and
-- 'rejected'/'superseded' rows are excluded automatically, since they
-- never match status='active'.
create unique index if not exists idx_hs_team_source_registrations_active_per_team_season
  on public.hs_team_source_registrations ("team_id", "season_id")
  where "status" = 'active';

create index if not exists idx_hs_team_source_registrations_org_id on public.hs_team_source_registrations using btree ("org_id");
create index if not exists idx_hs_team_source_registrations_team_season on public.hs_team_source_registrations using btree ("team_id", "season_id");

-- hs_opponent_programs: durable opponent school/program identity,
-- independent of any season.
create table if not exists public.hs_opponent_programs (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "name" text not null,
  "normalized_name" text generated always as (
    lower(regexp_replace(trim("name"), '\s+', ' ', 'g'))
  ) stored,
  "is_active" boolean not null default true,
  "record_source" text not null default 'manual' check ("record_source" in ('manual', 'gamechanger')),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_opponent_programs_org_id_key" unique ("org_id", "id"),
  constraint "hs_opponent_programs_org_program_id_key" unique ("org_id", "program_id", "id"),
  constraint "hs_opponent_programs_org_program_fkey"
    foreign key ("org_id", "program_id") references public.hs_programs ("org_id", "id") on delete cascade
);

-- Deliberately NOT unique -- normalized_name is a candidate-search input,
-- never an identity boundary. Two distinct real schools that happen to
-- normalize identically must both be insertable.
create index if not exists idx_hs_opponent_programs_org_program_normalized_name
  on public.hs_opponent_programs ("org_id", "program_id", "normalized_name");

-- hs_opponent_teams: season-specific opponent team, tracked in the
-- context of OUR season.
create table if not exists public.hs_opponent_teams (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "opponent_program_id" uuid not null,
  "season_id" uuid not null,
  "level" text not null default 'unknown' check ("level" in ('freshman', 'junior_varsity', 'varsity', 'unknown')),
  "display_name" text,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),
  constraint "hs_opponent_teams_org_id_key" unique ("org_id", "id"),
  -- FK target for hs_opponent_source_links' season-consistency check.
  constraint "hs_opponent_teams_org_program_id_season_key" unique ("org_id", "program_id", "id", "season_id"),
  constraint "hs_opponent_teams_org_program_opponent_program_fkey"
    foreign key ("org_id", "program_id", "opponent_program_id")
    references public.hs_opponent_programs ("org_id", "program_id", "id") on delete cascade,
  constraint "hs_opponent_teams_org_program_season_fkey"
    foreign key ("org_id", "program_id", "season_id")
    references public.hs_seasons ("org_id", "program_id", "id") on delete cascade
  -- No unique constraint on (opponent_program_id, season_id) or
  -- (opponent_program_id, season_id, level): one opponent program must be
  -- able to have multiple hs_opponent_teams rows at the same level in the
  -- same season without a database error. Duplicate suppression happens
  -- at the reconciliation/merge layer (a later slice), not here.
);

create index if not exists idx_hs_opponent_teams_program_season_level
  on public.hs_opponent_teams ("opponent_program_id", "season_id", "level");
create index if not exists idx_hs_opponent_teams_org_id on public.hs_opponent_teams using btree ("org_id");

-- hs_opponent_source_links: the join between a season-specific opponent
-- team and the external source team backing it, carrying full status
-- history.
create table if not exists public.hs_opponent_source_links (
  "id" uuid not null default extensions.uuid_generate_v4(),
  "org_id" uuid not null,
  "program_id" uuid not null,
  "opponent_team_id" uuid not null,
  "season_id" uuid not null,
  "source_team_id" uuid not null,
  "status" text not null default 'pending' check ("status" in ('pending', 'linked', 'superseded', 'rejected', 'needs_review')),
  "superseded_at" timestamptz,
  "superseded_by_link_id" uuid,
  "confidence" text,
  "decided_by_user_id" uuid,
  "decided_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id"),

  constraint "hs_opponent_source_links_scope_id_key"
    unique ("org_id", "program_id", "opponent_team_id", "season_id", "id"),

  constraint "hs_opponent_source_links_org_program_opponent_team_season_fkey"
    foreign key ("org_id", "program_id", "opponent_team_id", "season_id")
    references public.hs_opponent_teams ("org_id", "program_id", "id", "season_id") on delete cascade,
  constraint "hs_opponent_source_links_org_source_team_fkey"
    foreign key ("org_id", "source_team_id") references public.hs_source_teams ("org_id", "id") on delete cascade,
  constraint "hs_opponent_source_links_org_source_context_fkey"
    foreign key ("org_id", "source_team_id", "season_id")
    references public.hs_source_team_contexts ("org_id", "source_team_id", "hs_season_id") on delete cascade,
  -- Same-scope supersession proof, deliberately excluding source_team_id
  -- for the same reason as the registrations table above.
  constraint "hs_opponent_source_links_superseded_by_same_scope_fkey"
    foreign key ("org_id", "program_id", "opponent_team_id", "season_id", "superseded_by_link_id")
    references public.hs_opponent_source_links ("org_id", "program_id", "opponent_team_id", "season_id", "id"),

  constraint "hs_opponent_source_links_rejected_requires_decision_check"
    check ("status" <> 'rejected' or ("decided_by_user_id" is not null and "decided_at" is not null)),

  constraint "hs_opponent_source_links_supersession_consistent_check"
    check (
      ("status" = 'superseded' and "superseded_at" is not null and "superseded_by_link_id" is not null)
      or
      ("status" <> 'superseded' and "superseded_at" is null and "superseded_by_link_id" is null)
    )
);

create unique index if not exists idx_hs_opponent_source_links_linked_per_opponent_team
  on public.hs_opponent_source_links ("opponent_team_id")
  where "status" = 'linked';

create unique index if not exists idx_hs_opponent_source_links_linked_per_source_season
  on public.hs_opponent_source_links ("source_team_id", "season_id")
  where "status" = 'linked';

create index if not exists idx_hs_opponent_source_links_org_id on public.hs_opponent_source_links using btree ("org_id");

-- ── updated_at triggers (existing shared set_updated_at(), unchanged) ──
create trigger trg_hs_source_teams_updated_at before update on public.hs_source_teams for each row execute function set_updated_at();
create trigger trg_hs_source_team_contexts_updated_at before update on public.hs_source_team_contexts for each row execute function set_updated_at();
create trigger trg_hs_team_source_registrations_updated_at before update on public.hs_team_source_registrations for each row execute function set_updated_at();
create trigger trg_hs_opponent_programs_updated_at before update on public.hs_opponent_programs for each row execute function set_updated_at();
create trigger trg_hs_opponent_teams_updated_at before update on public.hs_opponent_teams for each row execute function set_updated_at();
create trigger trg_hs_opponent_source_links_updated_at before update on public.hs_opponent_source_links for each row execute function set_updated_at();

-- ── RLS: enable + single SELECT policy, existing convention, unchanged ──
alter table public.hs_source_teams enable row level security;
alter table public.hs_source_team_contexts enable row level security;
alter table public.hs_team_source_registrations enable row level security;
alter table public.hs_opponent_programs enable row level security;
alter table public.hs_opponent_teams enable row level security;
alter table public.hs_opponent_source_links enable row level security;

create policy "hs_source_teams_select" on public.hs_source_teams
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_source_teams"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_source_team_contexts_select" on public.hs_source_team_contexts
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_source_team_contexts"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_team_source_registrations_select" on public.hs_team_source_registrations
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_team_source_registrations"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_opponent_programs_select" on public.hs_opponent_programs
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_opponent_programs"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_opponent_teams_select" on public.hs_opponent_teams
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_opponent_teams"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

create policy "hs_opponent_source_links_select" on public.hs_opponent_source_links
  for select
  using (
    "org_id" in (select auth_user_org_ids())
    and exists (
      select 1 from public.organizations "o"
      where "o"."id" = "hs_opponent_source_links"."org_id"
        and "o"."enabled_products" @> array['high_school']::text[]
    )
  );

-- No explicit GRANT statements: Supabase's standard anon/authenticated/
-- service_role auto-grant plus RLS (enabled above, SELECT-only policies)
-- is the existing convention for every ordinary table in this schema. No
-- INSERT/UPDATE/DELETE policy is defined for any of the six tables above
-- -- Postgres's RLS default-deny means those operations remain
-- unreachable for anon/authenticated regardless of table-level grants.
-- No SECURITY DEFINER function is added by this migration.
