-- Real-Postgres relational checks for hs_team_source_registrations.
-- Every CHECK block is self-contained (its own BEGIN/ROLLBACK); fixtures
-- (org/program/seasons/teams/source_teams/contexts) are created once,
-- committed, then reused by id across checks via psql \gset variables.
--
-- On cleanup: the SETUP fixtures below are deliberately COMMITTED, not
-- rolled back, so their ids remain valid and reusable across every later
-- CHECK block in this script. Every CHECK block that mutates
-- hs_team_source_registrations rolls its own transaction back (or, for
-- CHECK7, explicitly deletes the two rows it committed) -- nothing this
-- script writes to hs_team_source_registrations itself survives the
-- script. The SETUP fixtures (one organizations/hs_programs/hs_seasons/
-- hs_teams/hs_source_teams/hs_source_team_contexts row set) are the only
-- thing left committed at the end of a run; cleanup of THOSE happens at
-- the disposable-cluster level (the whole Postgres data directory this
-- database lives in is destroyed after the test run), not per-script --
-- this is intentional and safe specifically because the target is always
-- a throwaway instance, never anything persistent.

\set ON_ERROR_STOP off

\echo '>>> SETUP_START'
begin;
insert into organizations (name, slug, customer_type, primary_product, enabled_products)
values ('Slice1 Reg Test Org', 'slice1-reg-test-' || substr(md5(random()::text),1,10), 'high_school', 'high_school', array['high_school'])
returning id as org_id \gset

insert into hs_programs (org_id, name) values (:'org_id', 'Reg Test Program') returning id as program_id \gset

insert into hs_seasons (org_id, program_id, name, school_year) values (:'org_id', :'program_id', 'Reg Season One', '2026-2027') returning id as season1_id \gset
insert into hs_seasons (org_id, program_id, name, school_year) values (:'org_id', :'program_id', 'Reg Season Two', '2027-2028') returning id as season2_id \gset

insert into hs_teams (org_id, program_id, level, name) values (:'org_id', :'program_id', 'varsity', 'Reg Team One') returning id as team1_id \gset
insert into hs_teams (org_id, program_id, level, name) values (:'org_id', :'program_id', 'junior_varsity', 'Reg Team Two') returning id as team2_id \gset

insert into hs_source_teams (org_id, source_provider, source_team_ref) values (:'org_id', 'gamechanger', 'reg-ref-a-' || substr(md5(random()::text),1,8)) returning id as source_a \gset
insert into hs_source_teams (org_id, source_provider, source_team_ref) values (:'org_id', 'gamechanger', 'reg-ref-b-' || substr(md5(random()::text),1,8)) returning id as source_b \gset

insert into hs_source_team_contexts (org_id, source_team_id, hs_season_id) values (:'org_id', :'source_a', :'season1_id') returning id as ctx_a_s1 \gset
insert into hs_source_team_contexts (org_id, source_team_id, hs_season_id) values (:'org_id', :'source_a', :'season2_id') returning id as ctx_a_s2 \gset
insert into hs_source_team_contexts (org_id, source_team_id, hs_season_id) values (:'org_id', :'source_b', :'season1_id') returning id as ctx_b_s1 \gset
commit;
\echo '>>> SETUP_END'

-- CHECK1: same-scope replacement succeeds; exactly one authoritative row after.
\echo '>>> CHECK1_START same_scope_replacement_succeeds'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active') returning id as old1 \gset
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_b', 'pending') returning id as new1 \gset
update hs_team_source_registrations set status='superseded', superseded_at=now(), superseded_by_registration_id=:'new1' where id=:'old1' and status='active';
update hs_team_source_registrations set status='active', decided_at=now() where id=:'new1' and status='pending';
select 'CHECK1_COUNTS' as tag,
  (select count(*) from hs_team_source_registrations where id=:'old1' and status='superseded' and superseded_by_registration_id=:'new1' and superseded_at is not null) as old_correctly_superseded,
  (select count(*) from hs_team_source_registrations where id=:'new1' and status='active') as new_is_active,
  (select count(*) from hs_team_source_registrations where team_id=:'team1_id' and season_id=:'season1_id' and status='active') as active_count_for_slot;
rollback;
\echo '>>> CHECK1_END'

-- CHECK2: cross-team replacement pointer fails.
\echo '>>> CHECK2_START cross_team_pointer_fails'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active') returning id as old2 \gset
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team2_id', :'season1_id', :'source_b', 'pending') returning id as wrong_team2 \gset
savepoint sp2;
update hs_team_source_registrations set status='superseded', superseded_at=now(), superseded_by_registration_id=:'wrong_team2' where id=:'old2' and status='active';
rollback to savepoint sp2;
rollback;
\echo '>>> CHECK2_END'

-- CHECK3: cross-season replacement pointer fails.
\echo '>>> CHECK3_START cross_season_pointer_fails'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active') returning id as old3 \gset
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season2_id', :'source_a', 'pending') returning id as wrong_season3 \gset
savepoint sp3;
update hs_team_source_registrations set status='superseded', superseded_at=now(), superseded_by_registration_id=:'wrong_season3' where id=:'old3' and status='active';
rollback to savepoint sp3;
rollback;
\echo '>>> CHECK3_END'

-- CHECK4: a registration with a syntactically-valid but non-existent
-- program_id fails. Because hs_programs enforces unique(org_id) (exactly
-- one real program per org), it is not possible to construct a SECOND
-- real program under this same org to build a genuine "two real programs"
-- cross-program fixture -- any such attempt would itself be rejected by
-- hs_programs_org_id_key before this migration's own constraints are ever
-- reached. This check instead proves the org+program existence FK
-- (hs_team_source_registrations_org_program_fkey) rejects a garbage
-- program_id outright. Note this is NOT the same as independently
-- exercising hs_team_source_registrations_org_program_team_fkey's "team
-- belongs to THIS program" guarantee in isolation -- under today's
-- one-program-per-org constraint, that FK can never fail without
-- org_program_fkey having already failed first, since a team's real
-- program is definitionally the org's only program. Both FKs remain in
-- the schema and both would matter independently the moment (if ever)
-- hs_programs_org_id_key is relaxed to allow multiple programs per org.
\echo '>>> CHECK4_START garbage_program_id_fails'
begin;
savepoint sp4;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', '00000000-0000-0000-0000-000000000000'::uuid, :'team1_id', :'season1_id', :'source_a', 'pending');
rollback to savepoint sp4;
rollback;
\echo '>>> CHECK4_END'

-- CHECK5: a non-superseded row carrying stray supersession metadata fails
-- -- test for 'active', 'pending', and 'rejected'.
\echo '>>> CHECK5_START stray_metadata_on_active_fails'
begin;
savepoint sp5a;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status, superseded_at, superseded_by_registration_id)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active', now(), null);
rollback to savepoint sp5a;
rollback;
\echo '>>> CHECK5_END'

\echo '>>> CHECK5B_START stray_metadata_on_pending_fails'
begin;
savepoint sp5b;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status, superseded_at)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'pending', now());
rollback to savepoint sp5b;
rollback;
\echo '>>> CHECK5B_END'

\echo '>>> CHECK5C_START stray_metadata_on_rejected_fails'
begin;
savepoint sp5c;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status, decided_by_user_id, decided_at, superseded_by_registration_id)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'rejected', null, now(),
  (select id from hs_team_source_registrations limit 1));
rollback to savepoint sp5c;
rollback;
\echo '>>> CHECK5C_END'

-- CHECK6: a superseded row missing superseded_at, missing the pointer, or
-- missing both, fails -- all three combinations.
\echo '>>> CHECK6A_START superseded_missing_at_fails'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active') returning id as anchor6a \gset
savepoint sp6a;
update hs_team_source_registrations set status='superseded', superseded_by_registration_id=:'anchor6a', superseded_at=null where id=:'anchor6a';
rollback to savepoint sp6a;
rollback;
\echo '>>> CHECK6A_END'

\echo '>>> CHECK6B_START superseded_missing_pointer_fails'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active') returning id as anchor6b \gset
savepoint sp6b;
update hs_team_source_registrations set status='superseded', superseded_at=now(), superseded_by_registration_id=null where id=:'anchor6b';
rollback to savepoint sp6b;
rollback;
\echo '>>> CHECK6B_END'

\echo '>>> CHECK6C_START superseded_missing_both_fails'
begin;
savepoint sp6c;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status, superseded_at, superseded_by_registration_id)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'superseded', null, null);
rollback to savepoint sp6c;
rollback;
\echo '>>> CHECK6C_END'

-- CHECK7: forced failure mid-swap rolls back completely -- old row stays
-- active, candidate stays pending, verified in a FRESH connection-visible
-- state after rollback (not just asserted inline).
\echo '>>> CHECK7_START forced_rollback_restores_prior_state'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active') returning id as old7 \gset
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_b', 'pending') returning id as new7 \gset
commit;

begin;
update hs_team_source_registrations set status='superseded', superseded_at=now(), superseded_by_registration_id=:'new7' where id=:'old7' and status='active';
-- Force an unrelated failure before completing the swap's second statement.
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status) values (null, null, null, null, null, null);
rollback;

-- Proves the ENTIRE authoritative row state reverted -- not just the
-- status label. old7 must be exactly as it was before the swap was
-- attempted (active, no supersession metadata, still bound to source_a);
-- new7 must be exactly as it was before (pending, no decision metadata,
-- still bound to source_b). A single field reverting while another stays
-- corrupted would fail this, unlike a status-only check.
select 'CHECK7_POST_ROLLBACK' as tag,
  (select status = 'active'
     and superseded_at is null
     and superseded_by_registration_id is null
     and source_team_id = :'source_a'::uuid
   from hs_team_source_registrations where id = :'old7') as old_fully_restored,
  (select status = 'pending'
     and decided_at is null
     and decided_by_user_id is null
     and source_team_id = :'source_b'::uuid
   from hs_team_source_registrations where id = :'new7') as new_fully_restored;

-- cleanup (outside any failed transaction)
begin;
delete from hs_team_source_registrations where id in (:'old7', :'new7');
commit;
\echo '>>> CHECK7_END'

-- CHECK8: direct duplicate active insert (bypassing the swap) fails.
\echo '>>> CHECK8_START direct_duplicate_active_fails'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active');
savepoint sp8;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_b', 'active');
rollback to savepoint sp8;
rollback;
\echo '>>> CHECK8_END'

-- CHECK9: rejected with null decision metadata fails.
\echo '>>> CHECK9_START rejected_without_decision_fails'
begin;
savepoint sp9;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'rejected');
rollback to savepoint sp9;
rollback;
\echo '>>> CHECK9_END'

-- CHECK10: active with null decision metadata SUCCEEDS (deliberate, not a gap).
\echo '>>> CHECK10_START active_without_decision_succeeds'
begin;
insert into hs_team_source_registrations (org_id, program_id, team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'team1_id', :'season1_id', :'source_a', 'active') returning id as check10_id \gset
select 'CHECK10_RESULT' as tag, status, decided_by_user_id, decided_at from hs_team_source_registrations where id=:'check10_id';
rollback;
\echo '>>> CHECK10_END'
