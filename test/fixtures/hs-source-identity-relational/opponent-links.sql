-- Real-Postgres relational checks for hs_opponent_source_links.
-- Same structure as registrations.sql -- see that file's comments for the
-- general approach, the CHECK4 program-id caveat, and the cleanup-model
-- note (SETUP fixtures are committed and cleaned up at the
-- disposable-cluster level, not per-script; everything this script writes
-- to hs_opponent_source_links itself is rolled back or explicitly deleted).

\set ON_ERROR_STOP off

\echo '>>> SETUP_START'
begin;
insert into organizations (name, slug, customer_type, primary_product, enabled_products)
values ('Slice1 Link Test Org', 'slice1-link-test-' || substr(md5(random()::text),1,10), 'high_school', 'high_school', array['high_school'])
returning id as org_id \gset

insert into hs_programs (org_id, name) values (:'org_id', 'Link Test Program') returning id as program_id \gset

insert into hs_seasons (org_id, program_id, name, school_year) values (:'org_id', :'program_id', 'Link Season One', '2026-2027') returning id as season1_id \gset
insert into hs_seasons (org_id, program_id, name, school_year) values (:'org_id', :'program_id', 'Link Season Two', '2027-2028') returning id as season2_id \gset

insert into hs_opponent_programs (org_id, program_id, name) values (:'org_id', :'program_id', 'Rival High') returning id as opp_program_id \gset

insert into hs_opponent_teams (org_id, program_id, opponent_program_id, season_id, level) values (:'org_id', :'program_id', :'opp_program_id', :'season1_id', 'varsity') returning id as ot1_id \gset
insert into hs_opponent_teams (org_id, program_id, opponent_program_id, season_id, level) values (:'org_id', :'program_id', :'opp_program_id', :'season1_id', 'junior_varsity') returning id as ot2_id \gset
insert into hs_opponent_teams (org_id, program_id, opponent_program_id, season_id, level) values (:'org_id', :'program_id', :'opp_program_id', :'season2_id', 'varsity') returning id as ot1_season2_id \gset

insert into hs_source_teams (org_id, source_provider, source_team_ref) values (:'org_id', 'gamechanger', 'link-ref-a-' || substr(md5(random()::text),1,8)) returning id as source_a \gset
insert into hs_source_teams (org_id, source_provider, source_team_ref) values (:'org_id', 'gamechanger', 'link-ref-b-' || substr(md5(random()::text),1,8)) returning id as source_b \gset

insert into hs_source_team_contexts (org_id, source_team_id, hs_season_id) values (:'org_id', :'source_a', :'season1_id') returning id as ctx_a_s1 \gset
insert into hs_source_team_contexts (org_id, source_team_id, hs_season_id) values (:'org_id', :'source_a', :'season2_id') returning id as ctx_a_s2 \gset
insert into hs_source_team_contexts (org_id, source_team_id, hs_season_id) values (:'org_id', :'source_b', :'season1_id') returning id as ctx_b_s1 \gset
commit;
\echo '>>> SETUP_END'

-- CHECK1: same-scope replacement succeeds.
\echo '>>> CHECK1_START same_scope_replacement_succeeds'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as old1 \gset
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_b', 'pending') returning id as new1 \gset
update hs_opponent_source_links set status='superseded', superseded_at=now(), superseded_by_link_id=:'new1' where id=:'old1' and status='linked';
update hs_opponent_source_links set status='linked', decided_at=now() where id=:'new1' and status='pending';
select 'CHECK1_COUNTS' as tag,
  (select count(*) from hs_opponent_source_links where id=:'old1' and status='superseded' and superseded_by_link_id=:'new1' and superseded_at is not null) as old_correctly_superseded,
  (select count(*) from hs_opponent_source_links where id=:'new1' and status='linked') as new_is_linked,
  (select count(*) from hs_opponent_source_links where opponent_team_id=:'ot1_id' and status='linked') as linked_count_for_slot;
rollback;
\echo '>>> CHECK1_END'

-- CHECK2: cross-opponent-team replacement pointer fails.
\echo '>>> CHECK2_START cross_team_pointer_fails'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as old2 \gset
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot2_id', :'season1_id', :'source_b', 'pending') returning id as wrong_team2 \gset
savepoint sp2;
update hs_opponent_source_links set status='superseded', superseded_at=now(), superseded_by_link_id=:'wrong_team2' where id=:'old2' and status='linked';
rollback to savepoint sp2;
rollback;
\echo '>>> CHECK2_END'

-- CHECK3: cross-season replacement pointer fails.
\echo '>>> CHECK3_START cross_season_pointer_fails'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as old3 \gset
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_season2_id', :'season2_id', :'source_a', 'pending') returning id as wrong_season3 \gset
savepoint sp3;
update hs_opponent_source_links set status='superseded', superseded_at=now(), superseded_by_link_id=:'wrong_season3' where id=:'old3' and status='linked';
rollback to savepoint sp3;
rollback;
\echo '>>> CHECK3_END'

-- CHECK4: same caveat as the registrations script -- see that file's
-- CHECK4 comment. hs_programs.unique(org_id) makes a genuine two-real-
-- programs fixture unconstructible; this proves the org+program
-- existence FK on hs_opponent_teams rejects a garbage program_id when
-- attempting to create an opponent team under it (the closest reachable
-- proxy for "cross-program" given today's constraint).
\echo '>>> CHECK4_START garbage_program_id_fails'
begin;
savepoint sp4;
insert into hs_opponent_teams (org_id, program_id, opponent_program_id, season_id, level)
values (:'org_id', '00000000-0000-0000-0000-000000000000'::uuid, :'opp_program_id', :'season1_id', 'varsity');
rollback to savepoint sp4;
rollback;
\echo '>>> CHECK4_END'

-- CHECK5: non-superseded row with stray supersession metadata fails.
\echo '>>> CHECK5_START stray_metadata_on_linked_fails'
begin;
savepoint sp5a;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status, superseded_at)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked', now());
rollback to savepoint sp5a;
rollback;
\echo '>>> CHECK5_END'

\echo '>>> CHECK5B_START stray_metadata_on_pending_fails'
begin;
savepoint sp5b;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status, superseded_at)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'pending', now());
rollback to savepoint sp5b;
rollback;
\echo '>>> CHECK5B_END'

\echo '>>> CHECK5C_START stray_metadata_on_needs_review_fails'
begin;
savepoint sp5c;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status, superseded_at)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'needs_review', now());
rollback to savepoint sp5c;
rollback;
\echo '>>> CHECK5C_END'

-- CHECK6: superseded missing superseded_at / pointer / both.
\echo '>>> CHECK6A_START superseded_missing_at_fails'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as anchor6a \gset
savepoint sp6a;
update hs_opponent_source_links set status='superseded', superseded_by_link_id=:'anchor6a', superseded_at=null where id=:'anchor6a';
rollback to savepoint sp6a;
rollback;
\echo '>>> CHECK6A_END'

\echo '>>> CHECK6B_START superseded_missing_pointer_fails'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as anchor6b \gset
savepoint sp6b;
update hs_opponent_source_links set status='superseded', superseded_at=now(), superseded_by_link_id=null where id=:'anchor6b';
rollback to savepoint sp6b;
rollback;
\echo '>>> CHECK6B_END'

\echo '>>> CHECK6C_START superseded_missing_both_fails'
begin;
savepoint sp6c;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status, superseded_at, superseded_by_link_id)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'superseded', null, null);
rollback to savepoint sp6c;
rollback;
\echo '>>> CHECK6C_END'

-- CHECK7: forced rollback restores prior state.
\echo '>>> CHECK7_START forced_rollback_restores_prior_state'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as old7 \gset
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_b', 'pending') returning id as new7 \gset
commit;

begin;
update hs_opponent_source_links set status='superseded', superseded_at=now(), superseded_by_link_id=:'new7' where id=:'old7' and status='linked';
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status) values (null, null, null, null, null, null);
rollback;

-- Proves the ENTIRE authoritative row state reverted, not just the status
-- label -- see registrations.sql's CHECK7 for the identical rationale.
select 'CHECK7_POST_ROLLBACK' as tag,
  (select status = 'linked'
     and superseded_at is null
     and superseded_by_link_id is null
     and source_team_id = :'source_a'::uuid
   from hs_opponent_source_links where id = :'old7') as old_fully_restored,
  (select status = 'pending'
     and decided_at is null
     and decided_by_user_id is null
     and source_team_id = :'source_b'::uuid
   from hs_opponent_source_links where id = :'new7') as new_fully_restored;

begin;
delete from hs_opponent_source_links where id in (:'old7', :'new7');
commit;
\echo '>>> CHECK7_END'

-- CHECK8: direct duplicate linked insert fails (both uniqueness angles:
-- same opponent_team_id, and same source_team_id+season_id).
\echo '>>> CHECK8_START direct_duplicate_linked_per_opponent_team_fails'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked');
savepoint sp8a;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_b', 'linked');
rollback to savepoint sp8a;
rollback;
\echo '>>> CHECK8_END'

\echo '>>> CHECK8B_START direct_duplicate_linked_per_source_season_fails'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked');
savepoint sp8b;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot2_id', :'season1_id', :'source_a', 'linked');
rollback to savepoint sp8b;
rollback;
\echo '>>> CHECK8B_END'

-- CHECK9: rejected with null decision metadata fails.
\echo '>>> CHECK9_START rejected_without_decision_fails'
begin;
savepoint sp9;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'rejected');
rollback to savepoint sp9;
rollback;
\echo '>>> CHECK9_END'

-- CHECK10: linked with null decision metadata AND null confidence succeeds.
\echo '>>> CHECK10_START linked_without_decision_or_confidence_succeeds'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as check10_id \gset
select 'CHECK10_RESULT' as tag, status, confidence, decided_by_user_id, decided_at from hs_opponent_source_links where id=:'check10_id';
rollback;
\echo '>>> CHECK10_END'

-- CHECK11 (link-specific): a source player ID / source-team scoping
-- sanity check -- same source_team_id reused across two DIFFERENT
-- seasons both reach 'linked' simultaneously (already proven structurally
-- by CHECK1's sibling logic, but explicitly re-verified here for the
-- opponent-side "same GC team reused next season" scenario named in the
-- design documents).
\echo '>>> CHECK11_START same_source_team_reused_across_seasons_succeeds'
begin;
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_id', :'season1_id', :'source_a', 'linked') returning id as s1link \gset
insert into hs_opponent_source_links (org_id, program_id, opponent_team_id, season_id, source_team_id, status)
values (:'org_id', :'program_id', :'ot1_season2_id', :'season2_id', :'source_a', 'linked') returning id as s2link \gset
select 'CHECK11_RESULT' as tag,
  (select count(*) from hs_opponent_source_links where id in (:'s1link', :'s2link') and status='linked') as both_linked_count;
rollback;
\echo '>>> CHECK11_END'
