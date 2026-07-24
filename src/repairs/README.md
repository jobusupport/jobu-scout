# Audited production game-date repair (2026-07-24)

## Purpose and scope

This is a **surgical, one-time repair tool** for exactly the 13 production
games identified by the read-only game-date integrity audit
(`game-date-production-audit.md` / `game-date-remediation-manifest.json`,
produced after PR #7's abbreviated-month parser fix merged). It is **not** a
general date-cleanup utility, and it must never be broadened to scan
production for other candidates or to touch any game outside the 13 listed
in `audited-game-dates-2026-07-24.allowlist.json`.

## The exact 13-record allowlist

All 13 games belong to team `8058e65c-254a-40f0-a2e4-64833f6ff30e` and were
all incorrectly stored with `game_date = 2026-05-24`. Each has preserved,
unambiguous `game_datetime_raw` evidence pointing to a distinct, different
true date (spanning 2026-03-15 through 2026-06-21). The exact game IDs,
`gc_game_id`s, old/new dates, and raw evidence are in
`audited-game-dates-2026-07-24.allowlist.json` in this directory.

## Why the two other May-24 games are excluded

15 games total are stored under `2026-05-24` for this team. Two of them have
raw evidence that genuinely reads "Sun May 24" -- those two are real games
that actually happened on that date and must never be touched. They are
listed explicitly in the allowlist's `legitimateExcludedGameIds` field, and
the tool's own structural validation refuses to load an allowlist that
contains either of their IDs as a repair target.

## Server-side security enforcement (the actual security boundary)

`audited-game-dates-2026-07-24.allowlist.json` is a **preflight and
reporting aid for the operator running this CLI -- it is not a security
boundary.** The actual enforcement lives entirely inside the Postgres
function itself
(`supabase/migrations/20260724000000_repair_audited_game_dates_fn.sql`),
which hardcodes the identical 13-record before/after mapping as an
immutable literal directly in the function body. The function's only
parameter is `p_operation`, constrained to exactly `'repair'` or
`'rollback'` -- **there is no calling convention through which any caller,
including one that bypasses this CLI entirely and invokes the RPC
directly, can supply a different game ID, a different date, a different
team, or a different count of targets.** A caller with RPC access cannot:

- substitute another game;
- change the proposed or expected-old date;
- omit or add a target;
- submit fewer or more than 13 targets;
- duplicate a target;
- touch a game outside the audited 13;
- turn `rollback` into an arbitrary date write, or vice versa.

`test/repair-audited-game-dates-server-boundary.test.js` verifies this
directly against the migration's SQL text (byte-for-byte comparison of the
hardcoded mapping against the allowlist file, function signature, grants,
and the specific safety constructs the design depends on) -- see that
file's own header comment for exactly what it does and does not prove
(no local/CI Postgres is available in this repository to execute the
function against a real database).

## Commands

```bash
# Dry-run (default -- also the explicit form)
node src/repairs/repair-audited-game-dates.js
node src/repairs/repair-audited-game-dates.js --dry-run

# Apply (writes to production -- requires BOTH flags)
node src/repairs/repair-audited-game-dates.js --apply --confirm-production-game-date-repair

# Rollback dry-run
node src/repairs/repair-audited-game-dates.js --rollback

# Rollback apply (requires BOTH flags, note the distinct confirmation flag)
node src/repairs/repair-audited-game-dates.js --rollback --apply --confirm-production-game-date-rollback
```

No interactive prompt exists anywhere in this tool. There is no way to
trigger a write without both of the explicit flags shown above, and no
environment variable alone ever causes a write.

## Required environment

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the same variables
`src/supabase.js` already reads via `.env`). The tool never calls
`db.init()` or any other code path that runs migrations, sets pragmas, or
otherwise mutates storage merely by starting up.

## Migration prerequisite

`--apply` (and `--rollback --apply`) requires that
`supabase/migrations/20260724000000_repair_audited_game_dates_fn.sql` has
already been applied to the target database -- that migration is authored
in this PR but **not applied** as part of it. Applying it is a separately
authorized step. Until it's applied, `--apply` mode will fail at the RPC
call with a "function does not exist" error (dry-run mode never needs the
function at all, since it only reads `games`/`game_stat_validation_results`
directly).

## Safety preconditions (checked for every one of the 13 records, every run)

1. The game exists.
2. Its `gc_game_id` matches the audited value.
3. Its `our_team_id` matches the audited team.
4. Its **current** `game_date` still equals the audited old value (or, for
   rollback, the audited new/repaired value).
5. Its `game_datetime_raw` still equals the audited raw evidence exactly.
6. (Repair direction only) the current, merged `parseDateTimeRaw()` still
   derives the proposed date from that raw evidence. This check is skipped
   for rollback, since a rollback deliberately restores the old, *wrong*
   value that the parser will never agree with -- that's the entire point.

If **any** of the 13 records fails **any** precondition, the tool makes
**zero** production changes, reports the exact failure, and exits nonzero.
There is no partial-repair path.

## Expected row counts

- Exactly 13 target games, always.
- `associated game_stat_validation_results` rows: expect 26 (2 per game) as
  of the audit date. If production shows a different count, the tool
  reports it -- a differing count does not by itself block the repair
  (that table is not touched either way), but investigate before proceeding
  if it doesn't match, since it hints at an unexpected production change.

## Cache treatment: `game_stat_validation_results`

Confirmed by reading every place this table is written
(`src/validate-team-stats.js` -- the only writer) and read (nowhere else in
the codebase): rows are `INSERT`-only, never `UPDATE`d or `DELETE`d, one
batch per validation *run*. This is an **append-only historical log**, not
a live cache that's expected to always reflect the current `game_date`.
Correcting these 13 games' `game_date` does not retroactively change what
was true at any past validation run.

**This tool never touches `game_stat_validation_results`.** The 26 existing
rows referencing the 13 games are left exactly as they are. **Documented
follow-up:** after the repair is applied (a separately authorized step),
re-run `src/validate-team-stats.js` for this team to produce a fresh,
correctly-dated validation run -- that is the existing, correct mechanism
for new validation data, not a responsibility of this repair tool.

## Output interpretation

Dry-run output reports, per record: PASS/FAIL and the exact failed
precondition if any, current vs. proposed date, and idempotency state
(`pre_repair` / `already_repaired` / `mixed` / `unexpected`). It ends with
either `NO WRITES WERE PERFORMED` (every non-apply invocation) or, in apply
mode, per-record before/after results after a successful write.

## Abort conditions

- Any unknown or contradictory CLI flag.
- A missing or structurally invalid allowlist file.
- Any of the 13 records failing any precondition.
- A `mixed` or `unexpected` overall state (some records repaired, some not,
  or a record showing a value that's neither the audited old nor new value).
- Production state changing between the pre-apply check and the write
  (re-checked immediately before the transaction).
- The RPC returning an `updatedCount` other than exactly 13.
- Post-write verification finding any of the 13 rows not showing the
  proposed date.

## Post-execution verification

Apply mode re-reads all 13 rows immediately after the write (inside the
same evaluation the tool already uses for preconditions) and reports
PASS/FAIL plus the exact before/after date for every record. A human
operator should additionally re-run the dry-run mode afterward as an
independent, from-scratch confirmation.

## Post-repair cleanup (recommended, not applied by this PR)

Once the repair has been applied and independently verified (dry-run
re-confirms all 13 rows show the proposed date, and the working team's
data looks correct in the admin UI), **`repair_audited_game_dates` should
be removed from production** -- it has no purpose once the one-time repair
it exists for is complete, and leaving a working, if narrowly-scoped,
SECURITY DEFINER function callable by `service_role` around indefinitely
is unnecessary residual attack surface. Recommended mechanism: a small
follow-up migration containing exactly

```sql
drop function if exists public.repair_audited_game_dates(text);
```

(Revoking execute alone would also work, but dropping the function
entirely is cleaner and self-documenting -- there is no plausible future
reason to re-run this exact hardcoded repair.) This cleanup is
intentionally **not** included in this PR or applied by it -- it's a
follow-up step for after the repair is confirmed successful.

## This is not a general cleanup utility

If you're reading this because you found *other* games with a similar
abbreviated-month or collapsed-date problem: **do not** add them to
`audited-game-dates-2026-07-24.allowlist.json`. That file is a closed,
already-reviewed manifest for exactly the 13 games identified by one
specific audit. A new set of candidates requires a new, separately
authorized audit and a new, separately reviewed allowlist/PR -- not an
edit to this one.
