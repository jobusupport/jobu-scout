-- Narrowly-scoped repair function for the 13 games identified by the
-- read-only production game-date audit (see game-date-production-audit.md
-- / game-date-remediation-manifest.json, produced against PR #7's merged
-- abbreviated-month parser fix). All 13 belong to one team and were
-- incorrectly stamped with the same stored game_date; each has preserved,
-- unambiguous game_datetime_raw evidence pointing to a different true date.
--
-- ── Security review correction (this revision) ──────────────────────────
-- The prior revision of this function accepted the entire repair set
-- (p_records jsonb) as caller-supplied input, validated only for internal
-- self-consistency against whatever the CURRENT row happened to contain.
-- That made it, in effect, a generic "update any game's date, subject to
-- an optimistic-concurrency check the caller can trivially satisfy by
-- reading the row first" RPC -- nothing prevented a caller with RPC access
-- from substituting a different game ID, a different proposed date, a
-- different count of targets, or touching a game outside the audited 13.
-- Client-side allowlist validation (src/repairs/repair-audited-game-dates.js
-- loading the JSON allowlist) is NOT a security boundary -- anything able
-- to call this RPC directly bypasses that entirely.
--
-- The fix: the exact 13-record before/after mapping is now a literal,
-- hardcoded constant INSIDE this function body (v_repairs below), copied
-- verbatim from src/repairs/audited-game-dates-2026-07-24.allowlist.json
-- and covered by test/repair-audited-game-dates.test.js's own byte-for-byte
-- comparison against that same file. The function's ONLY parameter is now
-- p_operation, constrained to exactly 'repair' or 'rollback' -- there is no
-- calling convention through which any caller (correct, buggy, or
-- malicious) can supply a game ID, a date, or a count that differs from
-- this hardcoded mapping. This function cannot be used to modify any game
-- outside the audited 13, under any input, by construction.
--
-- Same architectural reason as admin_update_org_product (see that
-- migration's own header comment) for why this needs to be a single
-- Postgres function at all: the application only talks to Postgres through
-- @supabase/supabase-js (src/supabase.js), where every `.from(...).update()`
-- call is its own independent HTTP request with no shared transaction.
-- Applying 13 heterogeneous per-row date corrections "all or nothing" is
-- only possible inside a single Postgres function body, which executes as
-- one implicit transaction -- if any precondition check or any update
-- fails, the entire call rolls back and none of the 13 rows change.
--
-- Two-pass design, per operation direction:
--   'repair':   expected current = oldDate, target = newDate.
--   'rollback': expected current = newDate, target = oldDate (the mirror).
--   Pass 1 validates every one of the 13 hardcoded records' preconditions
--   (existence, gc_game_id, team_id, current game_date, current
--   game_datetime_raw -- all checked against the row locked by `for
--   update`) -- raising immediately on the first mismatch, before any
--   UPDATE has been issued at all, so a precondition failure on record #13
--   can never leave records #1-12 already written.
--   Pass 2 applies the updates only after every record in pass 1 passed,
--   then asserts the number of rows actually updated equals 13 exactly --
--   a defense-in-depth check against any UPDATE unexpectedly affecting
--   zero rows.
--
-- This function deliberately does NOT touch game_stat_validation_results.
-- That table is written only via INSERT from src/validate-team-stats.js
-- (verified directly -- no UPDATE/DELETE of it exists anywhere in this
-- codebase) and nothing reads it back as "current" state; it is an
-- append-only historical log of past validation runs, not a live cache.
-- Correcting these 13 games' game_date does not retroactively change what
-- was true at any past validation run, so existing rows are left exactly
-- as they are -- a fresh validation run (a separate, already-existing
-- tool: src/validate-team-stats.js) is the correct way to produce new,
-- correctly-dated rows after this repair, not a mutation performed here.
--
-- SET search_path = '' + fully schema-qualified references, SECURITY
-- DEFINER + explicit revoke/grant: identical hardening rationale to
-- admin_update_org_product (see that migration's own comment for the full
-- explanation) -- only service_role may ever call this function. This
-- function performs no dynamic SQL and interpolates no caller-controlled
-- string into any query -- every value read from v_repairs or p_operation
-- is used only as a bind-style plpgsql variable in ordinary parameterized
-- statements (::uuid / ::date casts, `where id = v_game_id`), never
-- concatenated into SQL text, so there is no SQL-injection surface here
-- regardless of p_operation's value (which is itself constrained to two
-- literal strings before any use).
--
-- Recommended cleanup after a successful, verified repair (not performed
-- by this migration): revoke execute from service_role and postgres, or
-- drop the function entirely, in a follow-up migration -- this function
-- has no purpose once the one-time repair it exists for has been applied
-- and independently verified. See src/repairs/README.md.
--
-- This migration is NOT applied to production as part of authoring it.
-- Applying it, and actually invoking this function in --apply mode, is a
-- separately authorized execution step.

create or replace function public.repair_audited_game_dates(p_operation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  -- Immutable, hardcoded, exactly 13 records -- copied verbatim from
  -- src/repairs/audited-game-dates-2026-07-24.allowlist.json. NO part of
  -- this array is ever influenced by caller input. If this literal and the
  -- JSON file it was copied from ever drift apart, test/repair-audited-game-dates.test.js's
  -- own comparison test fails the build.
  v_repairs constant jsonb := '[
    {"gameId":"134ab4af-6ccd-4362-aade-81e5c47220a8","gcGameId":"78539ac6-a12c-45f7-97fd-8e59c5961f78","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-03-15","rawDateTime":"Sun Mar 15, 12:00 PM - 2:00 PM ET"},
    {"gameId":"3e269efb-54dc-41fd-8446-efee29894681","gcGameId":"9121fc4f-c894-4417-8582-f3c5a66191b7","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-04-04","rawDateTime":"Sat Apr 4, 10:00 AM - 11:45 AM ET"},
    {"gameId":"21e3e91c-3ede-4721-a50a-428503b3b44d","gcGameId":"a913cfaf-688e-4e84-8375-e1bc281d53c2","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-04-04","rawDateTime":"Sat Apr 4, 7:00 PM - 8:45 PM ET"},
    {"gameId":"03699fb0-e2e4-41ba-9d6c-0920485a37af","gcGameId":"9cf58c60-e7b4-4ffc-90c1-e09c3408968b","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-04-19","rawDateTime":"Sun Apr 19, 12:30 PM - 2:20 PM ET"},
    {"gameId":"0551f42f-fcc6-4082-a83b-c16d2fd050e7","gcGameId":"73489841-375f-464f-89a7-41d43bdf93fc","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-05-01","rawDateTime":"Fri May 1, 6:00 PM - 7:45 PM ET"},
    {"gameId":"21d6946a-318f-4071-b8df-88562ade7c12","gcGameId":"4aadb80f-2525-4ca5-bd9c-8c0f1a2f7147","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-05-08","rawDateTime":"Fri May 8, 8:15 PM - 10:00 PM ET"},
    {"gameId":"45ef0442-d96a-4f6b-8771-78be7c0195ff","gcGameId":"58e0eb22-5346-4da1-852c-1341d1f86e02","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-05-09","rawDateTime":"Sat May 9, 7:30 PM - 9:15 PM ET"},
    {"gameId":"242d5c76-8923-479e-8cec-692cf5123cdf","gcGameId":"5c691273-749a-4418-9a0e-ea7671b78164","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-05-10","rawDateTime":"Sun May 10, 10:45 AM - 12:30 PM ET"},
    {"gameId":"4c115845-1ec9-41e7-bf6f-7abaa021910d","gcGameId":"89be7315-f6c3-4c52-94c8-5e34f7266540","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-05-10","rawDateTime":"Sun May 10, 1:00 PM - 2:00 PM ET"},
    {"gameId":"52a2fd5a-d200-4234-a44b-af9420b8dcd8","gcGameId":"865c7c94-6f53-4e2f-b81e-9534f1984563","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-05-22","rawDateTime":"Fri May 22, 7:00 PM - 8:45 PM ET"},
    {"gameId":"47d615ea-265f-4cf8-8853-782bfe2baf4b","gcGameId":"8bc6b841-b46b-40a1-87f8-3c7175f83e10","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-06-05","rawDateTime":"Fri Jun 5, 4:00 PM - 5:50 PM ET"},
    {"gameId":"19e82305-6025-4254-bf6f-e5784a3a23f2","gcGameId":"ce29c4fe-1a63-447e-848b-918a1988fcb4","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-06-07","rawDateTime":"Sun Jun 7, 1:30 PM - 3:20 PM ET"},
    {"gameId":"1104a50e-cc1b-4cd5-9e07-a13d6894242c","gcGameId":"2c33d7be-7f99-47b4-9e34-22e345069334","teamId":"8058e65c-254a-40f0-a2e4-64833f6ff30e","oldDate":"2026-05-24","newDate":"2026-06-21","rawDateTime":"Sun Jun 21, 5:00 PM - 6:45 PM CT"}
  ]'::jsonb;

  v_rec jsonb;
  v_game_id uuid;
  v_gc_game_id text;
  v_team_id uuid;
  v_expected_current_date date;
  v_target_date date;
  v_raw text;
  v_current_game_date date;
  v_current_gc_game_id text;
  v_current_team_id uuid;
  v_current_raw text;
  v_updated_count int := 0;
  v_expected_count int;
  v_rows_affected int;
begin
  if p_operation is distinct from 'repair' and p_operation is distinct from 'rollback' then
    raise exception 'invalid operation: % (must be exactly ''repair'' or ''rollback'')', p_operation;
  end if;

  v_expected_count := jsonb_array_length(v_repairs);

  -- ── Pass 1: validate every hardcoded record against the CURRENT locked
  -- row state. Nothing is written in this loop. `for update` locks each
  -- target row for the remainder of this transaction (serializing against
  -- any concurrent writer), and doubles as the existence check this
  -- function trusts.
  for v_rec in select * from jsonb_array_elements(v_repairs)
  loop
    v_game_id    := (v_rec->>'gameId')::uuid;
    v_gc_game_id := v_rec->>'gcGameId';
    v_team_id    := (v_rec->>'teamId')::uuid;
    v_raw        := v_rec->>'rawDateTime';

    if p_operation = 'repair' then
      v_expected_current_date := (v_rec->>'oldDate')::date;
      v_target_date           := (v_rec->>'newDate')::date;
    else
      v_expected_current_date := (v_rec->>'newDate')::date;
      v_target_date           := (v_rec->>'oldDate')::date;
    end if;

    select game_date, gc_game_id, our_team_id, game_datetime_raw
      into v_current_game_date, v_current_gc_game_id, v_current_team_id, v_current_raw
      from public.games
      where id = v_game_id
      for update;

    if not found then
      raise exception 'game_not_found: %', v_game_id using errcode = 'P0002';
    end if;

    if v_current_gc_game_id is distinct from v_gc_game_id then
      raise exception 'gc_game_id_mismatch for %: expected %, found %', v_game_id, v_gc_game_id, v_current_gc_game_id;
    end if;

    if v_current_team_id is distinct from v_team_id then
      raise exception 'team_id_mismatch for %: expected %, found %', v_game_id, v_team_id, v_current_team_id;
    end if;

    if v_current_game_date is distinct from v_expected_current_date then
      raise exception 'game_date_precondition_failed for %: expected %, found %', v_game_id, v_expected_current_date, v_current_game_date;
    end if;

    -- rollback does not require raw evidence to still match (it never did
    -- for the repair direction's own header text either -- the raw text
    -- never changes; only game_date does) -- checked in both directions
    -- for defense-in-depth: the row's raw text should never differ from
    -- what was audited, regardless of which direction we're running.
    if v_current_raw is distinct from v_raw then
      raise exception 'raw_evidence_mismatch for %', v_game_id;
    end if;
  end loop;

  -- ── Pass 2: every record above passed. Apply the writes. ────────────────
  -- Each UPDATE repeats the expected-current-date check as an explicit
  -- WHERE predicate -- an atomic, database-level conditional update, not
  -- merely a prior SELECT check. The `for update` lock taken in pass 1
  -- already serializes any concurrent writer for the rest of this
  -- transaction, which alone would make this predicate redundant -- but
  -- this does not depend on a future reader correctly reasoning about lock
  -- semantics: if this UPDATE ever matches zero rows for any reason, GET
  -- DIAGNOSTICS catches it immediately and the whole call rolls back,
  -- rather than silently reporting success on a no-op write.
  for v_rec in select * from jsonb_array_elements(v_repairs)
  loop
    v_game_id := (v_rec->>'gameId')::uuid;
    if p_operation = 'repair' then
      v_expected_current_date := (v_rec->>'oldDate')::date;
      v_target_date           := (v_rec->>'newDate')::date;
    else
      v_expected_current_date := (v_rec->>'newDate')::date;
      v_target_date           := (v_rec->>'oldDate')::date;
    end if;

    update public.games
       set game_date = v_target_date
     where id = v_game_id
       and game_date = v_expected_current_date;
    get diagnostics v_rows_affected = row_count;

    if v_rows_affected <> 1 then
      raise exception 'update_affected_unexpected_row_count for %: expected 1, affected %', v_game_id, v_rows_affected;
    end if;

    v_updated_count := v_updated_count + v_rows_affected;
  end loop;

  if v_updated_count <> v_expected_count or v_updated_count <> 13 then
    raise exception 'updated_count_mismatch: expected 13, actually updated %', v_updated_count;
  end if;

  return jsonb_build_object('operation', p_operation, 'updatedCount', v_updated_count);
end;
$function$;

revoke execute on function public.repair_audited_game_dates(text) from public, anon, authenticated;
grant execute on function public.repair_audited_game_dates(text) to postgres, service_role;
