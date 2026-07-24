-- Narrowly-scoped repair function for the 13 games identified by the
-- read-only production game-date audit (see game-date-production-audit.md
-- / game-date-remediation-manifest.json, produced against PR #7's merged
-- abbreviated-month parser fix). All 13 belong to one team and were
-- incorrectly stamped with the same stored game_date; each has preserved,
-- unambiguous game_datetime_raw evidence pointing to a different true date.
--
-- This is NOT a general "fix any date" mechanism. It only ever operates on
-- the exact rows passed in by the caller, and only after re-verifying every
-- precondition against the CURRENT row state, inside this same transaction.
--
-- Same architectural reason as admin_update_org_product (see that
-- migration's own header comment): the application only talks to Postgres
-- through @supabase/supabase-js (src/supabase.js), where every
-- `.from(...).update()` call is its own independent HTTP request with no
-- shared transaction. Applying 13 heterogeneous per-row date corrections
-- "all or nothing" is only possible inside a single Postgres function body,
-- which executes as one implicit transaction -- if any precondition check
-- or any update fails, the entire call rolls back and none of the 13 rows
-- change.
--
-- Two-pass design:
--   Pass 1 validates every record's preconditions (existence, gc_game_id,
--   team_id, current game_date, current game_datetime_raw) against a
--   `for update`-locked read of the current row -- raising immediately on
--   the first mismatch, before any UPDATE has been issued at all, so a
--   precondition failure on record #13 can never leave records #1-12
--   already written.
--   Pass 2 applies the updates only after every record in pass 1 passed,
--   then asserts the number of rows actually updated equals the number of
--   input records -- a defense-in-depth check against any UPDATE
--   unexpectedly affecting zero rows.
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
-- explanation) -- only service_role may ever call this function.
--
-- This migration is NOT applied to production as part of authoring it.
-- Applying it, and actually invoking this function in --apply mode, is a
-- separately authorized execution step.

create or replace function public.repair_audited_game_dates(p_records jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rec jsonb;
  v_game_id uuid;
  v_gc_game_id text;
  v_team_id uuid;
  v_old_date date;
  v_new_date date;
  v_new_time text;
  v_raw text;
  v_current_game_date date;
  v_current_gc_game_id text;
  v_current_team_id uuid;
  v_current_raw text;
  v_updated_count int := 0;
  v_expected_count int;
begin
  if p_records is null or jsonb_typeof(p_records) <> 'array' then
    raise exception 'p_records must be a non-null JSON array';
  end if;

  v_expected_count := jsonb_array_length(p_records);
  if v_expected_count = 0 then
    raise exception 'p_records must not be empty';
  end if;

  -- ── Pass 1: validate every record against the CURRENT locked row state ──
  -- Nothing is written in this loop. `for update` locks each target row for
  -- the remainder of this transaction (serializing against any concurrent
  -- writer), and doubles as the existence check this function trusts --
  -- never a value merely passed in by the caller.
  for v_rec in select * from jsonb_array_elements(p_records)
  loop
    v_game_id    := (v_rec->>'gameId')::uuid;
    v_gc_game_id := v_rec->>'gcGameId';
    v_team_id    := (v_rec->>'teamId')::uuid;
    v_old_date   := (v_rec->>'oldDate')::date;
    v_raw        := v_rec->>'rawDateTime';

    if v_game_id is null or v_gc_game_id is null or v_team_id is null or v_old_date is null or v_raw is null then
      raise exception 'record missing a required field: %', v_rec;
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

    if v_current_game_date is distinct from v_old_date then
      raise exception 'game_date_precondition_failed for %: expected %, found %', v_game_id, v_old_date, v_current_game_date;
    end if;

    if v_current_raw is distinct from v_raw then
      raise exception 'raw_evidence_mismatch for %', v_game_id;
    end if;
  end loop;

  -- ── Pass 2: every record above passed. Apply the writes. ────────────────
  for v_rec in select * from jsonb_array_elements(p_records)
  loop
    v_game_id := (v_rec->>'gameId')::uuid;
    v_new_date := (v_rec->>'newDate')::date;
    v_new_time := v_rec->>'newTime';

    if v_new_date is null then
      raise exception 'newDate missing for %', v_game_id;
    end if;

    if v_new_time is not null then
      update public.games set game_date = v_new_date, game_time = v_new_time where id = v_game_id;
    else
      update public.games set game_date = v_new_date where id = v_game_id;
    end if;
    v_updated_count := v_updated_count + 1;
  end loop;

  if v_updated_count <> v_expected_count then
    raise exception 'updated_count_mismatch: expected %, actually updated %', v_expected_count, v_updated_count;
  end if;

  return jsonb_build_object('updatedCount', v_updated_count);
end;
$function$;

revoke execute on function public.repair_audited_game_dates(jsonb) from public, anon, authenticated;
grant execute on function public.repair_audited_game_dates(jsonb) to postgres, service_role;
