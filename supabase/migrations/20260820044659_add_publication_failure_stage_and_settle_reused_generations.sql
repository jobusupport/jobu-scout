-- HS Slice 2D final-review correction.
--
-- Three defects found by the final independent review, all at the publication
-- boundary. No table, column, index, policy or grant is added or altered beyond
-- the two failure_stage CHECK constraints named below; the RPC keeps
-- SECURITY INVOKER, search_path = '' and its jsonb return, and EXECUTE stays
-- limited to postgres and service_role.
--
-- 1. 'publication' was not an accepted failure stage. The opponent collector
--    reports it for every publication-boundary rejection -- unresolved identity,
--    an unsafe date, a source-event collision, a completeness regression, a
--    database constraint -- but the application validator refused it and the
--    caller swallowed the refusal, so those runs were never marked failed. They
--    sat in 'running' for ever with no process behind them, blocking retry.
--    hs_import_runs constrained the same five stages in the database; that
--    constraint is widened here and the equivalent constraint is added to
--    hs_opponent_import_runs, which had none at all.
--
-- 2. The opponent idempotent-reuse branch returned an existing generation
--    without settling the run that asked for it, so every replay of an
--    unchanged collection also stranded a run in 'running'.
--
-- 3. A privileged caller could present an observation reporting a previously
--    FINAL game as no longer final. The RPC accepted it, matched the existing
--    input-set hash, reused the generation and returned success while the
--    canonical row silently stayed 'final' -- a retraction that vanished. It is
--    now refused by name, before anything is written, with the prior verified
--    generation left current.
--
-- 'invalid' also joins the unsafe date resolutions: a source naming a day that
-- does not exist on the calendar (Feb 30, Apr 31, a non-leap Feb 29) is refused
-- here as it already is in the collector and the mapper.

-- ── Accepted failure stages ─────────────────────────────────────────────
-- Publication is a real stage of both pipelines: the point at which a fully
-- captured collection is offered to this function and can still be refused.
alter table public.hs_import_runs drop constraint if exists hs_import_runs_failure_stage_check;
alter table public.hs_import_runs add constraint hs_import_runs_failure_stage_check
  check (failure_stage is null or failure_stage = any (array[
    'discovery', 'snapshot_capture', 'reconstruction', 'validation', 'aggregation', 'publication']));

-- hs_opponent_import_runs never constrained this column, so an unrecognised
-- stage could be written silently. Same list, enforced the same way.
alter table public.hs_opponent_import_runs drop constraint if exists hs_opponent_import_runs_failure_stage_check;
alter table public.hs_opponent_import_runs add constraint hs_opponent_import_runs_failure_stage_check
  check (failure_stage is null or failure_stage = any (array[
    'discovery', 'snapshot_capture', 'reconstruction', 'validation', 'aggregation', 'publication']));

drop function if exists public.persist_hs_engine_collection(jsonb);

create function public.persist_hs_engine_collection(p_dto jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_org_id uuid := (p_dto #>> '{context,orgId}')::uuid;
  v_program_id uuid := (p_dto #>> '{context,programId}')::uuid;
  v_team_id uuid := (p_dto #>> '{context,teamId}')::uuid;
  v_season_id uuid := (p_dto #>> '{context,seasonId}')::uuid;
  v_import_run_id uuid := (p_dto #>> '{context,importRunId}')::uuid;
  v_provider text := p_dto #>> '{context,sourceProvider}';
  v_engine_version text := p_dto ->> 'engineVersion';
  v_input_hash text := p_dto ->> 'inputSetHash';
  v_content_hash text := p_dto ->> 'contentHash';
  v_payload_bytes integer := (p_dto ->> 'payloadBytes')::integer;
  v_existing public.hs_stat_generations%rowtype;
  v_generation public.hs_stat_generations%rowtype;
  v_observation jsonb;
  v_snapshot jsonb;
  v_player jsonb;
  v_noncanonical jsonb;
  v_run_game_id uuid;
  v_game_id uuid;
  v_alias_game_id uuid;
  v_candidate_count integer;
  v_candidate_game_id uuid;
  v_source_ref text;
  v_method text;
  v_identity_digest text;
  v_foundation_digest text;
  v_discriminators jsonb;
  v_resolution_kind text;
  v_prior_status text;
  v_totals jsonb := p_dto -> 'teamTotals';
  v_now timestamptz := now();
  v_subject jsonb := p_dto -> 'subject';
  v_subject_kind text;
  v_opponent_team_id uuid;
  v_source_team_id uuid;
  v_source_link_id uuid;
  v_opp_existing public.hs_opponent_stat_generations%rowtype;
  v_opp_generation public.hs_opponent_stat_generations%rowtype;
  v_final_count integer := 0;
  v_game_status text;
  v_final_digests text[] := '{}'::text[];
  v_prior_final_digests text[];
  v_publication_state text;
  v_missing_digest text;
begin
  if p_dto is null or jsonb_typeof(p_dto) <> 'object' or coalesce((p_dto ->> 'complete')::boolean, false) is not true then
    raise exception 'malformed_engine_collection: complete collection DTO required' using errcode = 'P0001';
  end if;
  if v_engine_version <> 'hs-baseball-engine/v1' then
    raise exception 'invalid_engine_version' using errcode = 'P0001';
  end if;
  if v_input_hash !~ '^[0-9a-f]{64}$' or v_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_collection_digest' using errcode = 'P0001';
  end if;
  if v_payload_bytes < 0 or v_payload_bytes > 4194304 then
    raise exception 'engine_collection_payload_too_large' using errcode = 'P0001';
  end if;
  if v_provider <> 'gamechanger' then
    raise exception 'invalid_source_provider' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_dto -> 'observations') <> 'array'
     or jsonb_typeof(p_dto -> 'canonicalPlayers') <> 'array'
     or jsonb_typeof(p_dto -> 'noncanonicalPlayers') <> 'array'
     or jsonb_typeof(v_totals) <> 'object' then
    raise exception 'malformed_engine_collection: arrays and teamTotals are required' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_dto) key
     where key not in (
       'complete', 'context', 'engineVersion', 'inputSetHash', 'contentHash', 'payloadBytes',
       'observations', 'snapshotCount', 'canonicalPlayers', 'noncanonicalPlayers',
       'teamTotals', 'officialTotalsComplete', 'subject'
     )
  ) then
    raise exception 'malformed_engine_collection: unexpected top-level property' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_dto -> 'observations') observation
     where jsonb_typeof(observation) <> 'object'
        or not (observation ?& array[
          'observationKey', 'sourceGameRef', 'sourceGameUrl', 'opponentName', 'gameDate',
          'identityMethod', 'identityStatus', 'identityDigest', 'foundationalDigest',
          'discriminators', 'authoritative', 'excludedFromOfficialTotals',
          'ambiguityComponentDigest', 'conflictFields', 'diagnostics', 'diagnostic',
          'validation', 'snapshots', 'engineVersion'
        ])
        or exists (
          select 1 from jsonb_object_keys(observation) observation_key
           where observation_key not in (
             'observationKey', 'sourceGameRef', 'sourceGameUrl', 'opponentName', 'gameDate',
             'identityMethod', 'identityStatus', 'identityDigest', 'foundationalDigest',
             'discriminators', 'authoritative', 'excludedFromOfficialTotals',
             'ambiguityComponentDigest', 'conflictFields', 'diagnostics', 'diagnostic',
             'validation', 'snapshots', 'engineVersion', 'gameStatus'
           )
        )
        or jsonb_typeof(observation -> 'observationKey') <> 'string'
        or (observation ->> 'observationKey') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(observation -> 'identityMethod') <> 'string'
        or btrim(observation ->> 'identityMethod') = ''
        or jsonb_typeof(observation -> 'identityStatus') <> 'string'
        or btrim(observation ->> 'identityStatus') = ''
        or jsonb_typeof(observation -> 'identityDigest') <> 'string'
        or coalesce(observation ->> 'identityDigest', '') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(observation -> 'engineVersion') <> 'string'
        or observation ->> 'engineVersion' <> v_engine_version
        or jsonb_typeof(observation -> 'authoritative') <> 'boolean'
        or jsonb_typeof(observation -> 'excludedFromOfficialTotals') <> 'boolean'
        or jsonb_typeof(observation -> 'discriminators') <> 'object'
        or jsonb_typeof(observation -> 'conflictFields') <> 'array'
        or jsonb_typeof(observation -> 'diagnostics') <> 'object'
        or jsonb_typeof(observation -> 'diagnostic') <> 'object'
        or not ((observation -> 'diagnostic') ? 'status')
        or exists (
          select 1 from jsonb_object_keys(observation -> 'diagnostic') diagnostic_key
           where diagnostic_key not in ('status', 'code', 'message')
        )
        or jsonb_typeof(observation #> '{diagnostic,status}') <> 'string'
        or btrim(observation #>> '{diagnostic,status}') = ''
        or observation #>> '{diagnostic,status}' not in ('not_run', 'ok', 'error')
        or case observation #>> '{diagnostic,status}'
          when 'not_run' then not (
            (observation -> 'diagnostic') ?& array['status', 'code']
            and not ((observation -> 'diagnostic') ? 'message')
            and jsonb_typeof(observation #> '{diagnostic,code}') = 'null'
          )
          when 'ok' then (select count(*) from jsonb_object_keys(observation -> 'diagnostic')) <> 1
          when 'error' then not (
            (observation -> 'diagnostic') ?& array['status', 'code', 'message']
            and jsonb_typeof(observation #> '{diagnostic,code}') = 'string'
            and observation #>> '{diagnostic,code}' = 'AMBIGUOUS_RECONSTRUCTION_FAILED'
            and jsonb_typeof(observation #> '{diagnostic,message}') = 'string'
            and observation #>> '{diagnostic,message}' = 'Ambiguous game diagnostic reconstruction failed.'
          )
          else true
        end
        or jsonb_typeof(observation -> 'snapshots') <> 'array'
        or jsonb_typeof(observation -> 'validation') <> 'object'
        or (jsonb_typeof(observation -> 'sourceGameRef') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'sourceGameUrl') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'opponentName') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'gameDate') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'foundationalDigest') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'ambiguityComponentDigest') not in ('string', 'null'))
        or (jsonb_typeof(observation -> 'foundationalDigest') = 'string' and (observation ->> 'foundationalDigest') !~ '^[0-9a-f]{64}$')
        or (jsonb_typeof(observation -> 'ambiguityComponentDigest') = 'string' and (observation ->> 'ambiguityComponentDigest') !~ '^[0-9a-f]{64}$')
        or exists (
          select 1 from jsonb_array_elements(observation -> 'snapshots') snapshot
           where jsonb_typeof(snapshot) <> 'object'
              or not (snapshot ?& array['kind', 'sourceRef', 'capturedAt', 'payload', 'integrityHash'])
              or exists (select 1 from jsonb_object_keys(snapshot) k where k not in ('kind', 'sourceRef', 'capturedAt', 'payload', 'integrityHash'))
              or jsonb_typeof(snapshot -> 'kind') <> 'string' or btrim(snapshot ->> 'kind') = ''
              or jsonb_typeof(snapshot -> 'capturedAt') <> 'string' or btrim(snapshot ->> 'capturedAt') = ''
              or jsonb_typeof(snapshot -> 'integrityHash') <> 'string' or (snapshot ->> 'integrityHash') !~ '^[0-9a-f]{64}$'
              or jsonb_typeof(snapshot -> 'sourceRef') not in ('string', 'null')
              or jsonb_typeof(snapshot -> 'payload') not in ('object', 'array')
        )
        or exists (
          select 1 from jsonb_object_keys(observation -> 'validation') k
           where k not in ('hasBoxScore', 'hasPlayByPlay', 'ownSide', 'opponentSide', 'boxScoreBatting',
             'boxScorePitching', 'reconstructedBatting', 'reconstructedPitching', 'deltas',
             'battingMatchesBox', 'quality', 'warnings', 'confidence', 'status')
        )
        or not ((observation -> 'validation') ?& array['hasBoxScore','hasPlayByPlay','ownSide','opponentSide','boxScoreBatting','boxScorePitching','reconstructedBatting','reconstructedPitching','deltas','battingMatchesBox','quality','warnings','confidence','status'])
        or jsonb_typeof(observation #> '{validation,hasBoxScore}') <> 'boolean'
        or jsonb_typeof(observation #> '{validation,hasPlayByPlay}') <> 'boolean'
        or jsonb_typeof(observation #> '{validation,battingMatchesBox}') <> 'boolean'
        or jsonb_typeof(observation #> '{validation,warnings}') <> 'array'
        or jsonb_typeof(observation #> '{validation,confidence}') <> 'string'
        or jsonb_typeof(observation #> '{validation,status}') <> 'string'
        or jsonb_typeof(observation #> '{validation,ownSide}') not in ('string', 'null')
        or jsonb_typeof(observation #> '{validation,opponentSide}') not in ('string', 'null')
        or jsonb_typeof(observation #> '{validation,boxScoreBatting}') <> 'object'
        or jsonb_typeof(observation #> '{validation,boxScorePitching}') <> 'object'
        or jsonb_typeof(observation #> '{validation,reconstructedBatting}') <> 'object'
        or jsonb_typeof(observation #> '{validation,reconstructedPitching}') <> 'object'
        or jsonb_typeof(observation #> '{validation,deltas}') <> 'object'
        or jsonb_typeof(observation #> '{validation,quality}') <> 'object'
  ) then
    raise exception 'malformed_engine_collection: invalid observation shape' using errcode = 'P0001';
  end if;
  if (
    select count(*) <> count(distinct observation ->> 'observationKey')
      from jsonb_array_elements(p_dto -> 'observations') observation
  ) then
    raise exception 'malformed_engine_collection: duplicate observation key' using errcode = 'P0001';
  end if;


  -- ── Discriminated collection subject (Slice 2D) ──────────────────────
  -- A DTO that omits `subject` entirely is an own-team collection, resolved
  -- exactly as Slice 2C resolved it. Nothing below changes that path.
  if v_subject is not null and jsonb_typeof(v_subject) <> 'object' then
    raise exception 'invalid_subject_kind' using errcode = 'P0001';
  end if;
  v_subject_kind := coalesce(nullif(btrim(coalesce(v_subject ->> 'kind', '')), ''), 'own_team');
  if v_subject_kind not in ('own_team', 'opponent_team') then
    raise exception 'invalid_subject_kind' using errcode = 'P0001';
  end if;
  if v_subject is not null then
    if (v_subject ? 'teamId') and (v_subject ? 'opponentTeamId') then
      raise exception 'ambiguous_collection_subject' using errcode = 'P0001';
    end if;
    if not (v_subject ? 'teamId') and not (v_subject ? 'opponentTeamId') then
      raise exception 'missing_collection_subject' using errcode = 'P0001';
    end if;
  end if;

  if v_subject_kind = 'opponent_team' then
    -- An opponent collection must not smuggle an own-team identifier through
    -- the legacy context fields; the two lineages never share a subject.
    if v_team_id is not null or v_import_run_id is not null then
      raise exception 'ambiguous_collection_subject' using errcode = 'P0001';
    end if;
    if not (v_subject ? 'opponentTeamId') then
      raise exception 'missing_collection_subject' using errcode = 'P0001';
    end if;
    v_opponent_team_id := (v_subject ->> 'opponentTeamId')::uuid;
    v_source_team_id := (v_subject ->> 'sourceTeamId')::uuid;
    v_import_run_id := (v_subject ->> 'importRunId')::uuid;
    if v_opponent_team_id is null or v_source_team_id is null or v_import_run_id is null then
      raise exception 'missing_collection_subject' using errcode = 'P0001';
    end if;

    -- Opponent players are never canonical in this slice: resolving them to
    -- durable identities is HS 2F's job, and a canonical row here would mean
    -- inventing roster membership from scraped data.
    if jsonb_array_length(p_dto -> 'canonicalPlayers') > 0 then
      raise exception 'opponent_collection_forbids_canonical_players' using errcode = 'P0001';
    end if;

    -- Competing publications for the same opponent must serialize, or two
    -- concurrent first-time publications would race on the current-generation
    -- index instead of one waiting and observing the other's result.
    --
    -- The own-team branch serializes by locking hs_teams FOR UPDATE, which in
    -- PostgreSQL requires UPDATE privilege on the locked table. Doing the same
    -- to hs_opponent_teams would mean granting service_role UPDATE on the
    -- identity foundation -- exactly the privilege this slice must NOT hold,
    -- because an ingestion run must never be able to edit the reviewed identity
    -- it is being authorised against. A transaction-scoped advisory lock keyed
    -- on the subject gives the same serialization, is released automatically on
    -- commit or rollback, and requires no table privileges at all. A hash
    -- collision between two different subjects can only cause harmless extra
    -- waiting, never an incorrect result.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_org_id::text || ':' || v_opponent_team_id::text || ':' || v_season_id::text, 0));

    perform 1 from public.hs_opponent_teams
     where id = v_opponent_team_id and org_id = v_org_id and program_id = v_program_id
       and season_id = v_season_id;
    if not found then raise exception 'opponent_team_not_found_for_org_program' using errcode = 'P0002'; end if;

    perform 1 from public.hs_source_teams where id = v_source_team_id and org_id = v_org_id;
    if not found then raise exception 'source_team_not_found_for_org' using errcode = 'P0002'; end if;

    -- Only a reviewed, currently linked source identity may authorise verified
    -- publication. pending / needs_review / rejected / superseded all block, and
    -- this branch never writes to the link table, so an ingestion run can never
    -- promote its own identity claim.
    select id into v_source_link_id from public.hs_opponent_source_links
     where org_id = v_org_id and program_id = v_program_id and opponent_team_id = v_opponent_team_id
       and season_id = v_season_id and source_team_id = v_source_team_id and status = 'linked';
    if not found then raise exception 'opponent_source_link_not_linked' using errcode = 'P0002'; end if;

    -- ── Source event identity collision ───────────────────────────────
    -- Two DISTINCT observations claiming one stable upstream game identifier
    -- resolve, further down, to a single canonical game via the alias lookup and
    -- the (opponent_team_id, source_game_ref) unique index. Before this guard the
    -- RPC accepted such a collection: it merged the two observations into one
    -- game while still counting both toward final_game_count, so a generation
    -- could claim two completed games that no longer existed separately, and one
    -- row's score was silently discarded.
    --
    -- The application detects this during discovery, but the check is repeated
    -- here so a privileged caller invoking the RPC directly cannot bypass it.
    -- Scoped to the opponent branch: the own-team path is unchanged.
    if exists (
      select 1
        from jsonb_array_elements(p_dto -> 'observations') observation
       where coalesce((observation ->> 'authoritative')::boolean, false)
         and nullif(btrim(coalesce(observation ->> 'sourceGameRef', '')), '') is not null
       group by observation ->> 'sourceGameRef'
      having count(*) > 1
    ) then
      raise exception 'opponent_source_event_identity_collision: two or more distinct observations claim one source game identity' using errcode = 'P0001';
    end if;

    -- A conflicting, unresolved or ambiguous identity is preserved as an
    -- observation but must never become verified output.
    if exists (
      select 1 from jsonb_array_elements(p_dto -> 'observations') observation
       where coalesce((observation ->> 'authoritative')::boolean, false)
         and (observation ->> 'identityStatus') in ('conflict', 'unresolved', 'ambiguous')
    ) then
      raise exception 'opponent_identity_unresolved' using errcode = 'P0001';
    end if;

    -- An observation the engine could not resolve has no durable source
    -- reference and no sufficient schedule composite, so neither lookup below
    -- can ever match it and every run would insert ANOTHER canonical game row.
    -- Capturing it as evidence is fine; publishing it as a canonical game is
    -- not. Checked on the identity METHOD, which is what decides matchability --
    -- the identityStatus guard above inspects the reconciliation outcome and
    -- does not cover this.
    if exists (
      select 1 from jsonb_array_elements(p_dto -> 'observations') observation
       where coalesce(observation ->> 'identityMethod', '') not in ('sourceGameId', 'scheduleComposite')
    ) then
      raise exception 'opponent_identity_unresolved: an observation has no durable source identity and no sufficient schedule composite' using errcode = 'P0001';
    end if;

    -- A date the source did not establish must never be published. Evidence the
    -- extractor explicitly marked ambiguous or conflicting is refused outright;
    -- after that an observation either carries a date or it does not, and a
    -- missing date is tolerated ONLY for a completed game anchored by a stable
    -- upstream reference.
    if exists (
      select 1 from jsonb_array_elements(p_dto -> 'observations') observation
       where coalesce(observation #>> '{diagnostics,dateResolution,status}', '') in ('ambiguous', 'conflicting', 'invalid')
    ) then
      raise exception 'opponent_schedule_date_unresolved: an observation carries a date the source did not establish' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_dto -> 'observations') observation
       where nullif(btrim(coalesce(observation ->> 'gameDate', '')), '') is null
         and (
           nullif(btrim(coalesce(observation ->> 'sourceGameRef', '')), '') is null
           or coalesce(observation ->> 'gameStatus', '') <> 'final'
         )
    ) then
      raise exception 'opponent_schedule_date_unresolved: an observation has no usable date and nothing to anchor it' using errcode = 'P0001';
    end if;

    -- A game this opponent has already published as FINAL may not be quietly
    -- walked back to a non-final status. A retraction upstream is real news, but
    -- silently overwriting a verified result -- or, at the idempotent-reuse
    -- branch below, returning success while keeping the old row -- would hide it.
    -- The prior verified generation stays current and the caller is told exactly
    -- what happened, so a human decides whether the source or the record is wrong.
    if exists (
      select 1
        from jsonb_array_elements(p_dto -> 'observations') observation
        join public.hs_opponent_games g
          on g.org_id = v_org_id
         and g.opponent_team_id = v_opponent_team_id
         and g.season_id = v_season_id
         and g.source_provider = v_provider
         and g.source_game_ref = nullif(btrim(coalesce(observation ->> 'sourceGameRef', '')), '')
       where g.game_status = 'final'
         and coalesce(observation ->> 'gameStatus', '') <> 'final'
    ) then
      raise exception 'opponent_game_status_regression: an observation reports a previously final game as no longer final' using errcode = 'P0001';
    end if;

    perform 1 from public.hs_opponent_import_runs
     where id = v_import_run_id and org_id = v_org_id and program_id = v_program_id
       and opponent_team_id = v_opponent_team_id and season_id = v_season_id
       and source_team_id = v_source_team_id and status = 'running'
     for update;
    if not found then
      select * into v_opp_existing from public.hs_opponent_stat_generations
       where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id
         and engine_version = v_engine_version and input_set_hash = v_input_hash;
      if found and v_opp_existing.content_hash = v_content_hash then
        return jsonb_build_object('subjectKind', 'opponent_team', 'generation', to_jsonb(v_opp_existing));
      end if;
      raise exception 'invalid_opponent_import_run_state' using errcode = 'P0001';
    end if;

    select * into v_opp_existing from public.hs_opponent_stat_generations
     where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id
       and engine_version = v_engine_version and input_set_hash = v_input_hash
     for update;
    if found then
      if v_opp_existing.content_hash <> v_content_hash then
        raise exception 'idempotency_content_mismatch' using errcode = 'P0001';
      end if;
      -- This run arrived 'running' and its work is done: the collection it
      -- carried is byte-for-byte the generation that already exists, so the run
      -- succeeded even though nothing new was inserted. Only the INSERT path
      -- used to settle the run, which left every idempotent replay sitting in
      -- 'running' for ever with no process behind it -- indistinguishable from a
      -- hung import, and enough to block the next retry.
      update public.hs_opponent_import_runs
         set status = 'succeeded', completed_at = v_now,
             games_processed = jsonb_array_length(p_dto -> 'observations'),
             games_succeeded = jsonb_array_length(p_dto -> 'observations'), games_failed = 0,
             result_summary = jsonb_build_object('generationId', v_opp_existing.id, 'engineVersion', v_engine_version,
               'inputSetHash', v_input_hash, 'officialTotalsComplete', v_opp_existing.official_totals_complete,
               'finalGameCount', v_opp_existing.final_game_count, 'publicationState', v_opp_existing.publication_state,
               'reusedExistingGeneration', true)
       where id = v_import_run_id and org_id = v_org_id and status = 'running';
      return jsonb_build_object('subjectKind', 'opponent_team', 'generation', to_jsonb(v_opp_existing));
    end if;

    for v_observation in select value from jsonb_array_elements(p_dto -> 'observations') order by value ->> 'observationKey'
    loop
      v_candidate_count := 0;
      v_candidate_game_id := null;
      v_resolution_kind := null;
      v_method := v_observation ->> 'identityMethod';
      v_identity_digest := v_observation ->> 'identityDigest';
      v_foundation_digest := v_observation ->> 'foundationalDigest';
      v_discriminators := coalesce(v_observation -> 'discriminators', '{}'::jsonb);
      v_source_ref := nullif(v_observation ->> 'sourceGameRef', '');
      v_game_status := coalesce(nullif(btrim(coalesce(v_observation ->> 'gameStatus', '')), ''), 'unknown');
      v_game_id := null;

      if coalesce((v_observation ->> 'authoritative')::boolean, false)
         and v_method in ('sourceGameId', 'scheduleComposite') then
        select opponent_game_id into v_alias_game_id from public.hs_opponent_game_identity_aliases
         where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id
           and source_provider = v_provider and identity_method = v_method and identity_digest = v_identity_digest;
        v_game_id := v_alias_game_id;

        -- A stable upstream identifier keeps the same canonical game across a
        -- reschedule: the date moved, the identity did not.
        if v_game_id is null and v_method = 'sourceGameId' and v_source_ref is not null then
          select id into v_game_id from public.hs_opponent_games
           where org_id = v_org_id and opponent_team_id = v_opponent_team_id and source_game_ref = v_source_ref;
          if v_game_id is not null then v_resolution_kind := 'automatic_durable'; end if;
        end if;

        -- Fallback identity adopts an existing game only when EXACTLY one alias
        -- matches the foundational digest and no discriminator contradicts it.
        -- Two or more candidates leave the observation unresolved rather than
        -- guessing, which is what keeps an indistinguishable doubleheader from
        -- silently collapsing into one game.
        if v_game_id is null and v_method = 'scheduleComposite' then
          select count(distinct a.opponent_game_id), min(a.opponent_game_id::text)::uuid
            into v_candidate_count, v_candidate_game_id
            from public.hs_opponent_game_identity_aliases a
           where a.org_id = v_org_id and a.opponent_team_id = v_opponent_team_id and a.season_id = v_season_id
             and a.source_provider = v_provider and a.identity_method = 'scheduleComposite'
             and a.foundational_digest = v_foundation_digest
             and exists (
               select 1 from jsonb_each_text(a.discriminators) old_d
               join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value = old_d.value
             )
             and not exists (
               select 1 from jsonb_each_text(a.discriminators) old_d
               join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value <> old_d.value
             );
          if v_candidate_count = 1 then
            v_game_id := v_candidate_game_id;
            v_resolution_kind := 'automatic_fallback_enrichment';
          end if;
          if v_candidate_count > 1 then v_game_id := null; end if;
        end if;

        if v_game_id is null and not (v_method = 'scheduleComposite' and coalesce(v_candidate_count, 0) > 1) then
          insert into public.hs_opponent_games
            (org_id, program_id, opponent_team_id, season_id, counterparty_name, game_date, game_status,
             source_provider, source_game_ref)
          values (v_org_id, v_program_id, v_opponent_team_id, v_season_id,
            nullif(v_observation ->> 'opponentName', ''), nullif(v_observation ->> 'gameDate', '')::date,
            v_game_status, v_provider, case when v_method = 'sourceGameId' then v_source_ref else null end)
          on conflict (opponent_team_id, source_game_ref) where source_game_ref is not null
          do update set updated_at = public.hs_opponent_games.updated_at
          returning id into v_game_id;
        end if;
      end if;

      -- The canonical game advances to the newest observation; every prior
      -- observation keeps its own observed_game_date / observed_game_status
      -- below, so a reschedule never destroys the former date.
      if v_game_id is not null then
        update public.hs_opponent_games
           set game_date = coalesce(nullif(v_observation ->> 'gameDate', '')::date, game_date),
               game_status = v_game_status,
               counterparty_name = coalesce(nullif(v_observation ->> 'opponentName', ''), counterparty_name)
         where org_id = v_org_id and id = v_game_id;

        insert into public.hs_opponent_game_identity_aliases
          (org_id, program_id, opponent_team_id, season_id, opponent_game_id, source_provider,
           identity_method, identity_digest, foundational_digest, discriminators)
        select v_org_id, v_program_id, v_opponent_team_id, v_season_id, v_game_id, v_provider,
               v_method, v_identity_digest, v_foundation_digest, v_discriminators
         where v_method in ('sourceGameId', 'scheduleComposite')
        on conflict (org_id, opponent_team_id, season_id, source_provider, identity_method, identity_digest) do nothing;
      end if;

      insert into public.hs_opponent_import_run_games
        (org_id, opponent_import_run_id, opponent_game_id, observation_key, source_provider, source_game_ref,
         source_game_url, observed_game_date, observed_game_status, discovery_status, game_outcome,
         identity_method, identity_status, identity_digest, authoritative, excluded_from_official_totals,
         ambiguity_component_digest, conflict_fields, engine_version, input_set_hash, diagnostics)
      values
        (v_org_id, v_import_run_id, v_game_id, v_observation ->> 'observationKey', v_provider, v_source_ref,
         nullif(v_observation ->> 'sourceGameUrl', ''), nullif(v_observation ->> 'gameDate', '')::date, v_game_status,
         'processed', case when v_game_id is null then 'replaced' else 'inserted' end,
         v_method, v_observation ->> 'identityStatus', v_identity_digest,
         coalesce((v_observation ->> 'authoritative')::boolean, false),
         coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false) or v_game_status <> 'final',
         nullif(v_observation ->> 'ambiguityComponentDigest', ''),
         coalesce(v_observation -> 'conflictFields', '[]'::jsonb),
         v_engine_version, v_input_hash, coalesce(v_observation -> 'diagnostics', '{}'::jsonb))
      returning id into v_run_game_id;

      if v_game_status = 'final' then
        v_final_count := v_final_count + 1;
        v_final_digests := v_final_digests || v_identity_digest;
      end if;

      if v_resolution_kind is not null and v_game_id is not null then
        v_prior_status := case v_observation ->> 'identityStatus'
          when 'deduplicated' then 'single'
          else v_observation ->> 'identityStatus'
        end;
        insert into public.hs_opponent_game_identity_resolutions
          (org_id, opponent_team_id, season_id, opponent_import_run_id, opponent_import_run_game_id,
           opponent_game_id, resolution_kind, prior_identity_status, evidence_digest)
        values
          (v_org_id, v_opponent_team_id, v_season_id, v_import_run_id, v_run_game_id,
           v_game_id, v_resolution_kind, v_prior_status, v_identity_digest)
        on conflict (org_id, opponent_import_run_game_id, opponent_game_id, evidence_digest) do nothing;
      end if;

      -- Snapshot identity is (observation, kind, integrity_hash): identical
      -- content is idempotent, changed content adds a row, nothing is ever
      -- overwritten.
      for v_snapshot in select value from jsonb_array_elements(coalesce(v_observation -> 'snapshots', '[]'::jsonb)) order by value ->> 'kind'
      loop
        insert into public.hs_opponent_raw_snapshots
          (org_id, opponent_import_run_id, opponent_import_run_game_id, opponent_game_id, snapshot_kind,
           source_provider, source_ref, captured_at, payload, content_type, schema_version, integrity_hash)
        values
          (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_snapshot ->> 'kind', v_provider,
           nullif(v_snapshot ->> 'sourceRef', ''), (v_snapshot ->> 'capturedAt')::timestamptz,
           coalesce(v_snapshot -> 'payload', '{}'::jsonb), 'json', v_engine_version, v_snapshot ->> 'integrityHash')
        on conflict (opponent_import_run_game_id, snapshot_kind, integrity_hash) do nothing;
      end loop;

      insert into public.hs_opponent_game_validation_results
        (org_id, opponent_import_run_id, opponent_import_run_game_id, opponent_game_id, opponent_team_id,
         has_box_score, has_play_by_play, subject_side, counterparty_side, box_score_batting, box_score_pitching,
         reconstructed_batting, reconstructed_pitching, deltas, batting_matches_box, quality, warnings,
         confidence, validation_status, identity_method, identity_status, identity_digest, authoritative,
         excluded_from_official_totals, conflict_fields, diagnostic_status, diagnostic_code,
         ambiguity_component_digest, engine_version, input_set_hash)
      values
        (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_opponent_team_id,
         coalesce((v_observation #>> '{validation,hasBoxScore}')::boolean, false),
         coalesce((v_observation #>> '{validation,hasPlayByPlay}')::boolean, false),
         nullif(v_observation #>> '{validation,ownSide}', ''), nullif(v_observation #>> '{validation,opponentSide}', ''),
         coalesce(v_observation #> '{validation,boxScoreBatting}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,boxScorePitching}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,reconstructedBatting}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,reconstructedPitching}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,deltas}', '{}'::jsonb),
         coalesce((v_observation #>> '{validation,battingMatchesBox}')::boolean, false),
         coalesce(v_observation #> '{validation,quality}', '{}'::jsonb),
         coalesce(v_observation #> '{validation,warnings}', '[]'::jsonb),
         coalesce(v_observation #>> '{validation,confidence}', 'low'),
         coalesce(v_observation #>> '{validation,status}', 'pending'),
         v_method, v_observation ->> 'identityStatus', v_identity_digest,
         coalesce((v_observation ->> 'authoritative')::boolean, false),
         coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false) or v_game_status <> 'final',
         coalesce(v_observation -> 'conflictFields', '[]'::jsonb),
         v_observation #>> '{diagnostic,status}', nullif(v_observation #>> '{diagnostic,code}', ''),
         nullif(v_observation ->> 'ambiguityComponentDigest', ''), v_engine_version, v_input_hash)
      on conflict (opponent_import_run_id, opponent_import_run_game_id) do nothing;
    end loop;

    -- ── Completeness-regression gate ──────────────────────────────────
    -- The dangerous case is not "zero completed games"; it is a later
    -- incomplete scrape silently replacing a generation that already carried
    -- verified statistics. A transient source failure, a partial capture and a
    -- legitimate correction all arrive looking similar, so the decision is made
    -- on the SET of completed-game identities rather than on a count or on
    -- whether the latest capture merely looks empty.
    --
    -- Evaluated before any supersession, so a rejected candidate leaves the
    -- prior verified generation current and its totals untouched.
    select final_identity_digests into v_prior_final_digests
      from public.hs_opponent_stat_generations
     where org_id = v_org_id and opponent_team_id = v_opponent_team_id
       and season_id = v_season_id and is_current and publication_state = 'verified'
     for update;

    if coalesce(array_length(v_prior_final_digests, 1), 0) > 0 then
      if coalesce(array_length(v_final_digests, 1), 0) = 0 then
        raise exception 'opponent_completeness_regression: the current verified generation has % completed game(s) and this candidate has none', array_length(v_prior_final_digests, 1) using errcode = 'P0001';
      end if;
      select d into v_missing_digest from unnest(v_prior_final_digests) d
       where d <> all (v_final_digests) limit 1;
      if v_missing_digest is not null then
        -- Adding games is progress; losing one is either a partial capture or a
        -- correction that a human has to confirm. Fail closed either way.
        raise exception 'opponent_completeness_regression: candidate no longer contains a previously verified completed game' using errcode = 'P0001';
      end if;
    end if;

    -- Schedule knowledge and verified statistics are different products. The
    -- state is DERIVED here from what was actually reconstructed, never taken
    -- from the caller, and the table's own check constraint ties it to
    -- final_game_count -- so a privileged caller invoking this RPC directly
    -- still cannot label a schedule-only capture as verified.
    v_publication_state := case when v_final_count > 0 then 'verified' else 'schedule_only' end;

    -- Supersession is scoped by opponent_team_id, so publishing for one
    -- opponent can never retire another opponent's current generation, and
    -- never touches own-team lineage at all.
    update public.hs_opponent_stat_generations set is_current = false, status = 'superseded', superseded_at = v_now
     where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id and is_current;
    update public.hs_opponent_verified_totals set is_current = false, superseded_at = v_now
     where org_id = v_org_id and opponent_team_id = v_opponent_team_id and season_id = v_season_id and is_current;

    insert into public.hs_opponent_stat_generations
      (org_id, program_id, opponent_team_id, season_id, opponent_import_run_id, source_team_id,
       opponent_source_link_id, engine_version, input_set_hash, content_hash, payload_bytes,
       observation_count, snapshot_count, noncanonical_player_count, final_game_count,
       final_identity_digests, publication_state, official_totals_complete, status, is_current, completed_at)
    values
      (v_org_id, v_program_id, v_opponent_team_id, v_season_id, v_import_run_id, v_source_team_id,
       v_source_link_id, v_engine_version, v_input_hash, v_content_hash, v_payload_bytes,
       jsonb_array_length(p_dto -> 'observations'), coalesce((p_dto ->> 'snapshotCount')::integer, 0),
       jsonb_array_length(p_dto -> 'noncanonicalPlayers'), v_final_count,
       v_final_digests, v_publication_state,
       -- A collection with no final game is schedule knowledge, never a
       -- completed statistical generation.
       coalesce((p_dto ->> 'officialTotalsComplete')::boolean, false) and v_final_count > 0,
       'completed', true, v_now)
    returning * into v_opp_generation;

    insert into public.hs_opponent_verified_totals
      (org_id, program_id, opponent_team_id, season_id, opponent_import_run_id, generation_id, games,
       box_score_games, play_by_play_games, validated_games, mismatch_games, subject_batting, subject_pitching,
       subject_batting_reconstructed, subject_pitching_reconstructed, tendencies, warnings, confidence,
       is_current, engine_version, input_set_hash)
    values
      (v_org_id, v_program_id, v_opponent_team_id, v_season_id, v_import_run_id, v_opp_generation.id,
       coalesce((v_totals ->> 'games')::integer, 0), coalesce((v_totals ->> 'boxScoreGames')::integer, 0),
       coalesce((v_totals ->> 'playByPlayGames')::integer, 0), coalesce((v_totals ->> 'validatedGames')::integer, 0),
       coalesce((v_totals ->> 'mismatchGames')::integer, 0), coalesce(v_totals -> 'officialBatting', '{}'::jsonb),
       coalesce(v_totals -> 'officialPitching', '{}'::jsonb), coalesce(v_totals -> 'reconstructedBatting', '{}'::jsonb),
       coalesce(v_totals -> 'reconstructedPitchingDefense', '{}'::jsonb), coalesce(v_totals -> 'tendencies', '{}'::jsonb),
       coalesce(v_totals -> 'warnings', '[]'::jsonb), coalesce(v_totals ->> 'confidence', 'low'), true,
       v_engine_version, v_input_hash);

    for v_noncanonical in select value from jsonb_array_elements(p_dto -> 'noncanonicalPlayers') order by value ->> 'engineIdentityKey', value ->> 'role'
    loop
      insert into public.hs_opponent_noncanonical_player_stats
        (org_id, opponent_team_id, season_id, generation_id, opponent_import_run_game_id, opponent_game_id,
         side, role, display_name, provider_player_id, engine_identity_key, unresolved_reason,
         is_counterparty, statistics)
      values
        (v_org_id, v_opponent_team_id, v_season_id, v_opp_generation.id, null, null,
         v_noncanonical ->> 'side', v_noncanonical ->> 'role', nullif(v_noncanonical ->> 'displayName', ''),
         nullif(v_noncanonical ->> 'providerPlayerId', ''), v_noncanonical ->> 'engineIdentityKey',
         v_noncanonical ->> 'reason', coalesce((v_noncanonical ->> 'isOpponent')::boolean, false),
         coalesce(v_noncanonical -> 'stats', '{}'::jsonb));
    end loop;

    update public.hs_opponent_import_runs
       set status = 'succeeded', completed_at = v_now,
           games_processed = jsonb_array_length(p_dto -> 'observations'),
           games_succeeded = jsonb_array_length(p_dto -> 'observations'), games_failed = 0,
           result_summary = jsonb_build_object('generationId', v_opp_generation.id, 'engineVersion', v_engine_version,
             'inputSetHash', v_input_hash, 'officialTotalsComplete', v_opp_generation.official_totals_complete,
             'finalGameCount', v_final_count, 'publicationState', v_opp_generation.publication_state)
     where id = v_import_run_id and org_id = v_org_id;

    return jsonb_build_object('subjectKind', 'opponent_team', 'generation', to_jsonb(v_opp_generation));
  end if;

  -- ── Own-team subject: the reviewed Slice 2C path, unchanged ──────────
  if v_subject is not null and (v_subject ->> 'teamId')::uuid is distinct from v_team_id then
    raise exception 'ambiguous_collection_subject' using errcode = 'P0001';
  end if;
  perform 1 from public.hs_teams
   where id = v_team_id and org_id = v_org_id and program_id = v_program_id
   for update;
  if not found then raise exception 'team_not_found_for_org_program' using errcode = 'P0002'; end if;

  perform 1 from public.hs_seasons
   where id = v_season_id and org_id = v_org_id and program_id = v_program_id
   for update;
  if not found then raise exception 'season_not_found_for_org_program' using errcode = 'P0002'; end if;

  perform 1 from public.hs_import_runs
   where id = v_import_run_id and org_id = v_org_id and program_id = v_program_id
     and team_id = v_team_id and season_id = v_season_id and status = 'running'
   for update;
  if not found then
    select * into v_existing from public.hs_stat_generations
     where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id
       and engine_version = v_engine_version and input_set_hash = v_input_hash;
    if found and v_existing.content_hash = v_content_hash then return jsonb_build_object('subjectKind', 'own_team', 'generation', to_jsonb(v_existing)); end if;
    raise exception 'invalid_import_run_state' using errcode = 'P0001';
  end if;

  select * into v_existing from public.hs_stat_generations
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id
     and engine_version = v_engine_version and input_set_hash = v_input_hash
   for update;
  if found then
    if v_existing.content_hash <> v_content_hash then
      raise exception 'idempotency_content_mismatch' using errcode = 'P0001';
    end if;
    return jsonb_build_object('subjectKind', 'own_team', 'generation', to_jsonb(v_existing));
  end if;

  for v_observation in select value from jsonb_array_elements(p_dto -> 'observations') order by value ->> 'observationKey'
  loop
    v_candidate_count := 0;
    v_candidate_game_id := null;
    v_resolution_kind := null;
    v_method := v_observation ->> 'identityMethod';
    v_identity_digest := v_observation ->> 'identityDigest';
    v_foundation_digest := v_observation ->> 'foundationalDigest';
    v_discriminators := coalesce(v_observation -> 'discriminators', '{}'::jsonb);
    v_source_ref := nullif(v_observation ->> 'sourceGameRef', '');
    v_game_id := null;

    if coalesce((v_observation ->> 'authoritative')::boolean, false)
       and v_method in ('sourceGameId', 'scheduleComposite') then
      select hs_game_id into v_alias_game_id from public.hs_game_identity_aliases
       where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id
         and source_provider = v_provider and identity_method = v_method and identity_digest = v_identity_digest;
      v_game_id := v_alias_game_id;

      if v_game_id is null and v_method = 'sourceGameId' and v_source_ref is not null then
        select id into v_game_id from public.hs_games
         where org_id = v_org_id and team_id = v_team_id and source_game_ref = v_source_ref;
        if v_game_id is not null then v_resolution_kind := 'automatic_durable'; end if;
      end if;

      if v_game_id is null and v_method = 'scheduleComposite' then
        select count(distinct a.hs_game_id), min(a.hs_game_id::text)::uuid
          into v_candidate_count, v_candidate_game_id
          from public.hs_game_identity_aliases a
         where a.org_id = v_org_id and a.team_id = v_team_id and a.season_id = v_season_id
           and a.source_provider = v_provider and a.identity_method = 'scheduleComposite'
           and a.foundational_digest = v_foundation_digest
           and exists (
             select 1 from jsonb_each_text(a.discriminators) old_d
             join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value = old_d.value
           )
           and not exists (
             select 1 from jsonb_each_text(a.discriminators) old_d
             join jsonb_each_text(v_discriminators) new_d on new_d.key = old_d.key and new_d.value <> old_d.value
           );
        if v_candidate_count = 1 then
          v_game_id := v_candidate_game_id;
          v_resolution_kind := 'automatic_fallback_enrichment';
        end if;
        if v_candidate_count > 1 then
          v_game_id := null;
        end if;
      end if;

      if v_game_id is null and not (v_method = 'scheduleComposite' and coalesce(v_candidate_count, 0) > 1) then
        insert into public.hs_games (org_id, program_id, team_id, season_id, opponent_name, game_date, source_provider, source_game_ref)
        values (v_org_id, v_program_id, v_team_id, v_season_id,
          nullif(v_observation ->> 'opponentName', ''), nullif(v_observation ->> 'gameDate', '')::date,
          v_provider, case when v_method = 'sourceGameId' then v_source_ref else null end)
        on conflict (team_id, source_game_ref) where source_game_ref is not null do update set updated_at = public.hs_games.updated_at
        returning id into v_game_id;
      end if;

      if v_game_id is not null then
        insert into public.hs_game_identity_aliases
          (org_id, program_id, team_id, season_id, hs_game_id, source_provider, identity_method, identity_digest, foundational_digest, discriminators)
        values (v_org_id, v_program_id, v_team_id, v_season_id, v_game_id, v_provider, v_method, v_identity_digest, v_foundation_digest, v_discriminators)
        on conflict (org_id, team_id, season_id, source_provider, identity_method, identity_digest) do nothing;
      end if;
    end if;

    insert into public.hs_import_run_games
      (org_id, import_run_id, hs_game_id, source_game_ref, source_game_url, discovery_status, game_outcome,
       diagnostics, observation_key, source_provider, identity_method, identity_status, identity_digest,
       authoritative, excluded_from_official_totals, ambiguity_component_digest, engine_version, input_set_hash)
    values
      (v_org_id, v_import_run_id, v_game_id, v_source_ref, nullif(v_observation ->> 'sourceGameUrl', ''), 'processed',
       case when v_game_id is null then 'replaced' else 'inserted' end,
       coalesce(v_observation -> 'diagnostics', '{}'::jsonb), v_observation ->> 'observationKey', v_provider,
       v_method, v_observation ->> 'identityStatus', v_identity_digest,
       coalesce((v_observation ->> 'authoritative')::boolean, false),
       coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false),
       nullif(v_observation ->> 'ambiguityComponentDigest', ''), v_engine_version, v_input_hash)
    on conflict (import_run_id, observation_key) where observation_key is not null
    do update set diagnostics = excluded.diagnostics
    returning id into v_run_game_id;

    if v_resolution_kind is not null and v_game_id is not null then
      v_prior_status := case v_observation ->> 'identityStatus'
        when 'deduplicated' then 'single'
        else v_observation ->> 'identityStatus'
      end;
      insert into public.hs_game_identity_resolutions
        (org_id, team_id, season_id, import_run_id, import_run_game_id, hs_game_id,
         resolution_kind, prior_identity_status, evidence_digest)
      values
        (v_org_id, v_team_id, v_season_id, v_import_run_id, v_run_game_id, v_game_id,
         v_resolution_kind, v_prior_status, v_identity_digest)
      on conflict (org_id, import_run_game_id, hs_game_id, evidence_digest) do nothing;
    end if;

    for v_snapshot in select value from jsonb_array_elements(coalesce(v_observation -> 'snapshots', '[]'::jsonb)) order by value ->> 'kind'
    loop
      insert into public.hs_raw_snapshots
        (org_id, import_run_id, import_run_game_id, hs_game_id, snapshot_kind, source_provider,
         source_ref, captured_at, payload, content_type, schema_version, integrity_hash)
      values
        (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_snapshot ->> 'kind', v_provider,
         nullif(v_snapshot ->> 'sourceRef', ''), (v_snapshot ->> 'capturedAt')::timestamptz,
         coalesce(v_snapshot -> 'payload', '{}'::jsonb), 'json', v_engine_version, v_snapshot ->> 'integrityHash')
      on conflict (import_run_game_id, snapshot_kind, captured_at) where import_run_game_id is not null do nothing;
    end loop;

    insert into public.hs_game_validation_results
      (org_id, import_run_id, import_run_game_id, hs_game_id, team_id, has_box_score, has_play_by_play,
       scouted_side, opponent_side, box_score_batting, box_score_pitching, reconstructed_batting,
       reconstructed_pitching, deltas, batting_matches_box, quality, warnings, confidence,
       validation_status, identity_method, identity_status, identity_digest, authoritative,
       excluded_from_official_totals, conflict_fields, diagnostic_status, diagnostic_code,
       ambiguity_component_digest, engine_version, input_set_hash)
    values
      (v_org_id, v_import_run_id, v_run_game_id, v_game_id, v_team_id,
       coalesce((v_observation #>> '{validation,hasBoxScore}')::boolean, false),
       coalesce((v_observation #>> '{validation,hasPlayByPlay}')::boolean, false),
       nullif(v_observation #>> '{validation,ownSide}', ''), nullif(v_observation #>> '{validation,opponentSide}', ''),
       coalesce(v_observation #> '{validation,boxScoreBatting}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,boxScorePitching}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,reconstructedBatting}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,reconstructedPitching}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,deltas}', '{}'::jsonb),
       coalesce((v_observation #>> '{validation,battingMatchesBox}')::boolean, false),
       coalesce(v_observation #> '{validation,quality}', '{}'::jsonb),
       coalesce(v_observation #> '{validation,warnings}', '[]'::jsonb),
       coalesce(v_observation #>> '{validation,confidence}', 'low'),
       coalesce(v_observation #>> '{validation,status}', 'pending'),
       v_method, v_observation ->> 'identityStatus', v_identity_digest,
       coalesce((v_observation ->> 'authoritative')::boolean, false),
       coalesce((v_observation ->> 'excludedFromOfficialTotals')::boolean, false),
       coalesce(v_observation -> 'conflictFields', '[]'::jsonb),
       v_observation #>> '{diagnostic,status}', nullif(v_observation #>> '{diagnostic,code}', ''),
       nullif(v_observation ->> 'ambiguityComponentDigest', ''), v_engine_version, v_input_hash)
    on conflict (import_run_id, import_run_game_id) where import_run_game_id is not null do nothing;
  end loop;

  update public.hs_stat_generations set is_current = false, status = 'superseded', superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;
  update public.hs_verified_totals set is_current = false, superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;
  update public.hs_player_advanced_stats set is_current = false, superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;
  update public.hs_pitcher_advanced_stats set is_current = false, superseded_at = v_now
   where org_id = v_org_id and team_id = v_team_id and season_id = v_season_id and is_current;

  insert into public.hs_stat_generations
    (org_id, program_id, team_id, season_id, import_run_id, engine_version, input_set_hash, content_hash,
     payload_bytes, observation_count, snapshot_count, canonical_player_count, noncanonical_player_count,
     official_totals_complete, status, is_current, completed_at)
  values
    (v_org_id, v_program_id, v_team_id, v_season_id, v_import_run_id, v_engine_version, v_input_hash, v_content_hash,
     v_payload_bytes, jsonb_array_length(p_dto -> 'observations'), coalesce((p_dto ->> 'snapshotCount')::integer, 0),
     jsonb_array_length(p_dto -> 'canonicalPlayers'), jsonb_array_length(p_dto -> 'noncanonicalPlayers'),
     coalesce((p_dto ->> 'officialTotalsComplete')::boolean, false), 'completed', true, v_now)
  returning * into v_generation;

  insert into public.hs_verified_totals
    (org_id, program_id, team_id, season_id, import_run_id, games, box_score_games, play_by_play_games,
     validated_games, mismatch_games, batting_official, pitching_official, batting_reconstructed,
     pitching_reconstructed, tendencies, warnings, confidence, is_current, generation_id, engine_version, input_set_hash)
  values
    (v_org_id, v_program_id, v_team_id, v_season_id, v_import_run_id,
     coalesce((v_totals ->> 'games')::integer, 0), coalesce((v_totals ->> 'boxScoreGames')::integer, 0),
     coalesce((v_totals ->> 'playByPlayGames')::integer, 0), coalesce((v_totals ->> 'validatedGames')::integer, 0),
     coalesce((v_totals ->> 'mismatchGames')::integer, 0), coalesce(v_totals -> 'officialBatting', '{}'::jsonb),
     coalesce(v_totals -> 'officialPitching', '{}'::jsonb), coalesce(v_totals -> 'reconstructedBatting', '{}'::jsonb),
     coalesce(v_totals -> 'reconstructedPitchingDefense', '{}'::jsonb), coalesce(v_totals -> 'tendencies', '{}'::jsonb),
     coalesce(v_totals -> 'warnings', '[]'::jsonb), coalesce(v_totals ->> 'confidence', 'low'), true,
     v_generation.id, v_engine_version, v_input_hash);

  for v_player in select value from jsonb_array_elements(p_dto -> 'canonicalPlayers') order by value ->> 'playerId', value ->> 'role'
  loop
    perform 1 from public.hs_roster_memberships rm
     where rm.org_id = v_org_id and rm.team_id = v_team_id and rm.season_id = v_season_id
       and rm.player_id = (v_player ->> 'playerId')::uuid;
    if not found then raise exception 'player_not_on_roster' using errcode = 'P0002'; end if;
    if v_player ->> 'role' = 'batter' then
      insert into public.hs_player_advanced_stats
        (org_id, program_id, team_id, season_id, player_id, import_run_id, games, errors, bunts,
         is_current, generation_id, engine_version, input_set_hash, statistics)
      values
        (v_org_id, v_program_id, v_team_id, v_season_id, (v_player ->> 'playerId')::uuid, v_import_run_id,
         nullif(v_player #>> '{stats,games}', '')::integer, coalesce(nullif(v_player #>> '{stats,E}', '')::integer, 0),
         coalesce(nullif(v_player #>> '{stats,bunts}', '')::integer, 0), true, v_generation.id,
         v_engine_version, v_input_hash, coalesce(v_player -> 'stats', '{}'::jsonb));
    elsif v_player ->> 'role' = 'pitcher' then
      insert into public.hs_pitcher_advanced_stats
        (org_id, program_id, team_id, season_id, player_id, import_run_id, games, wp, bk, pik,
         is_current, generation_id, engine_version, input_set_hash, statistics)
      values
        (v_org_id, v_program_id, v_team_id, v_season_id, (v_player ->> 'playerId')::uuid, v_import_run_id,
         nullif(v_player #>> '{stats,games}', '')::integer, coalesce(nullif(v_player #>> '{stats,WP}', '')::integer, 0),
         coalesce(nullif(v_player #>> '{stats,BK}', '')::integer, 0), coalesce(nullif(v_player #>> '{stats,PIK}', '')::integer, 0),
         true, v_generation.id, v_engine_version, v_input_hash, coalesce(v_player -> 'stats', '{}'::jsonb));
    else
      raise exception 'invalid_canonical_player_role' using errcode = 'P0001';
    end if;
  end loop;

  for v_noncanonical in select value from jsonb_array_elements(p_dto -> 'noncanonicalPlayers') order by value ->> 'engineIdentityKey', value ->> 'role'
  loop
    insert into public.hs_noncanonical_player_stats
      (org_id, team_id, season_id, generation_id, import_run_game_id, hs_game_id, side, role,
       display_name, provider_player_id, engine_identity_key, unresolved_reason, is_opponent, statistics)
    values
      (v_org_id, v_team_id, v_season_id, v_generation.id, null, null,
       v_noncanonical ->> 'side', v_noncanonical ->> 'role', nullif(v_noncanonical ->> 'displayName', ''),
       nullif(v_noncanonical ->> 'providerPlayerId', ''), v_noncanonical ->> 'engineIdentityKey',
       v_noncanonical ->> 'reason', coalesce((v_noncanonical ->> 'isOpponent')::boolean, false),
       coalesce(v_noncanonical -> 'stats', '{}'::jsonb));
  end loop;

  update public.hs_import_runs
     set status = 'succeeded', completed_at = v_now,
         games_processed = jsonb_array_length(p_dto -> 'observations'),
         games_succeeded = jsonb_array_length(p_dto -> 'observations'), games_failed = 0,
         result_summary = jsonb_build_object('generationId', v_generation.id, 'engineVersion', v_engine_version,
           'inputSetHash', v_input_hash, 'officialTotalsComplete', v_generation.official_totals_complete)
   where id = v_import_run_id and org_id = v_org_id;

  return jsonb_build_object('subjectKind', 'own_team', 'generation', to_jsonb(v_generation));
end;
$function$;

revoke execute on function public.persist_hs_engine_collection(jsonb) from public, anon, authenticated;
grant execute on function public.persist_hs_engine_collection(jsonb) to postgres, service_role;
