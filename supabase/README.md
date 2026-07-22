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

Each forward migration may have a matching `<same-name>.down.sql`. **These
are reference files for the pre-adoption window only** -- safe to run
before any real data depends on the change they undo, not a general-purpose
rollback tool. Once a migration's columns/tables hold real, admin- or
customer-assigned state, a schema-level rollback needs a deliberate,
documented data-export step first, not a blind re-run of the down file.
That procedure is written into the down file's own header comment once it
applies (see `20260721140000_add_organization_product_fields.down.sql` for
the first example) rather than kept as a second always-safe script, because
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
