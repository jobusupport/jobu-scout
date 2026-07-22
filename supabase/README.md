# Supabase migrations

This directory is the canonical, in-repo record of schema changes to the live
Supabase/Postgres project. Kept here rather than under `docs/` for two
reasons: this repo already established the co-located-documentation
convention in Phase 1.5 (`dashboard-src/README.md` lives with the dashboard
source it describes, not under `docs/`), and `supabase/` is a directory the
Supabase CLI itself expects to scaffold (`config.toml`, `migrations/`,
`seed.sql`) -- a README inside it is idiomatic for Supabase projects
generally, not a preference specific to this repo. Consolidating everything
under `docs/` is a reasonable alternative, but it would introduce a second,
inconsistent documentation-placement pattern in the same session that just
established the first one.

## Why this directory exists

Before Phase 2, the live Supabase/Postgres schema had **no** in-repo
migration history at all. `migrations/` (repo root, not this directory)
holds a legacy SQLite schema from before the product's rebrand and is
unrelated to the live database. Every schema change to the real, live
project happened directly against Supabase with nothing committed to git.
`supabase/migrations/` replaces that with a real, reviewable history,
starting with Phase 2 Slice 1's organization product fields.

## What's actually in this directory

Three distinct kinds of file live here, and it matters which is which:

1. **Six foundational baseline migrations**
   (`20260620000000_foundational_types_and_tables.sql` through
   `20260620000005_foundational_triggers_and_grants.sql`). These
   reconstruct, via read-only introspection of the live production
   database (not `pg_dump`, not a migration replay), the *entire*
   consolidated schema that predates this repo's migration history --
   every table, function, view, index, RLS policy, trigger, and grant
   Jobu Scout owns. Verified schema-identical to production via a full
   comparison (tables/columns/constraints/functions/views/indexes/RLS/
   grants), and verified to replay cleanly from a completely empty
   database. **These must never be executed directly against the
   existing production database** -- production already has every
   object they create, so a plain replay would fail with
   already-exists errors. They exist for two purposes: (a) so a fresh
   environment (disaster recovery, a new project) can be stood up from
   nothing, and (b) as the target state that production's own migration
   history gets reconciled against via `migration repair` (see below) --
   never applied there directly.
2. **Twenty-two historical marker migrations**
   (`<production-timestamp>_<original-name>_history_marker.sql`).
   Production's own tracked migration history contains 22 versions
   between `20260630211818` and `20260721183527` that were never
   committed as files in this repository (they were applied directly
   against the live project). Their cumulative schema effect is already
   fully captured by the six foundational migrations above -- these 22
   files exist only so this repo's local migration list lines up
   version-for-version with production's remote migration history.
   Each one is **intentionally a no-op** (`select 1;` plus an
   explanatory comment) -- none of them reconstruct or re-run the
   original migration SQL, since the foundational baseline already
   represents that verified end state. They are not something a
   production replay ever executes for real; production already has
   these versions marked applied in its own history table, and a
   `migration repair --status applied` (never a raw `db push`) is what
   ties that fact together.
3. **One genuine pending schema change**
   (`20260721140000_add_organization_product_fields.sql`, Phase 2
   Slice 1) -- the only migration in this directory that actually needs
   to run against production for real. Everything else above is either
   a from-scratch baseline or a no-op alignment marker.

## Naming convention

`supabase/migrations/<YYYYMMDDHHMMSS>_<snake_case_description>.sql` -- the
timestamp is the actual UTC time the migration is applied, matching the
Supabase CLI's own convention.

## Forward migrations

Applied via the Supabase CLI or the project's MCP tooling
(`apply_migration`). After applying, verify with `list_migrations` (or
`supabase migration list`) that the file in this directory matches what's
actually live -- the discipline this convention exists to enforce is
"nothing is applied that isn't committed here first."

## Down migrations

Each forward migration may have a matching `<same-name>.down.sql` under
`supabase/rollback/` -- **deliberately not** under `supabase/migrations/`.
Supabase (and the CLI) treat every `.sql` file in `migrations/` as part of
normal replay order; a down file living there risks being picked up and
executed as if it were just another forward migration, which would be
actively destructive (it would drop the very objects the matching forward
migration just created). `supabase/rollback/` holds the same files for
reference and history, safely outside that scan path.

**These are reference files for the pre-adoption window only** -- safe to
run manually before any real data depends on the change they undo, not a
general-purpose rollback tool. Once a migration's columns/tables hold real,
admin- or customer-assigned state, a schema-level rollback needs a
deliberate, documented data-export step first, not a blind re-run of the
down file. That procedure is written into the down file's own header
comment once it applies (see
`supabase/rollback/20260721140000_add_organization_product_fields.down.sql`
for the first example) rather than kept as a second always-safe script, because
what's actually safe changes over time as a feature gets adopted.

The safest rollback for *any* migration in this directory, at any point, is
reverting the application code that reads the new columns/tables -- never
the schema itself, as an emergency response. Schema rollback is for a
deliberate decommission decision only.

## Coordinating with application deploys

Every migration in this directory is written to be additive and safe for
rolling deployment: new columns are either nullable or have constant
defaults, so application code running *before* a migration is deployed
continues to function against the post-migration schema without error --
it simply never selects or writes the new columns until its own deploy
lands. Apply the migration first; deploy the code that depends on it
second. No stricter coordination window is required unless a specific
migration's own comments say otherwise.

## Preview Branch validation workflow

Changes to this directory are validated against a Supabase Preview Branch
before ever touching production -- never applied to production directly to
"see if it works."

The project's GitHub integration (Project Settings -> Integrations ->
GitHub) is configured with:

- **Automatic branching: on** -- every pull request gets its own preview
  database, built by replaying every file in `supabase/migrations/` in
  filename order against a fresh database.
- **Supabase changes only: on** -- a preview build only triggers on a push
  that actually changes a file under `supabase/`. A no-op push (e.g. an
  empty commit) will not trigger a build under this setting -- if you need
  to force a rebuild without a real schema change, touch a file in this
  directory (this file is a reasonable, harmless target) rather than
  pushing an empty commit.
- **Deploy to production: off** -- merging a pull request does **not**
  automatically apply anything to the production database or its migration
  history. Promoting a validated migration to production is a separate,
  deliberate, manual step, performed only after Preview Branch replay,
  schema comparison, RLS testing, and application smoke testing have all
  passed for that change.

Validating a change:

1. Open a pull request touching `supabase/`.
2. Wait for the Preview Branch to provision and replay all migrations --
   check its status via the Supabase dashboard's Branching page, or via the
   Management API (`list_branches`, `list_migrations` against the branch's
   own `project_ref`, `get_logs` with `service: "branch-action"` on the
   parent project for provisioning-level events).
3. Compare the Preview Branch's resulting schema against production before
   trusting it (tables, columns, constraints, functions, RLS policies,
   triggers, indexes -- not just "did the migration run without erroring").
4. Only after that comparison passes, and independently of this workflow,
   apply the same migration to production through whatever process is
   current at that time -- this directory's existence doesn't by itself
   grant production auto-deploy, by design (see "Deploy to production: off"
   above).
