-- Foundational schema baseline (Slice 1 branch-validation follow-up), part 3 of 5.
-- See supabase/README.md for the full explanation of why this exists.
-- Reconstructed via read-only introspection (Supabase list_tables +
-- information_schema/pg_catalog queries), NOT a pg_dump/db push output.

-- Views and non-primary-key/non-unique indexes for foundational tables.
-- (Primary key and unique indexes were already created implicitly by
-- their constraints in file 1 -- not repeated here.)

-- ── Views ────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.team_summary AS
 SELECT t.id,
    t.org_id,
    t.team_name,
    t.age_group,
    t.is_our_team,
    t.gc_team_url,
    t.pg_team_url,
    count(DISTINCT g.id) AS game_count,
    count(DISTINCT g.id) FILTER (WHERE ((t.is_our_team AND (g.our_score > g.opponent_score)) OR ((NOT t.is_our_team) AND (g.opponent_score > g.our_score)))) AS wins,
    count(DISTINCT g.id) FILTER (WHERE ((t.is_our_team AND (g.our_score < g.opponent_score)) OR ((NOT t.is_our_team) AND (g.opponent_score < g.our_score)))) AS losses,
    max(g.game_date) AS last_game_date,
    count(DISTINCT p.id) AS player_count
   FROM ((teams t
     LEFT JOIN games g ON (((g.our_team_id = t.id) OR (g.opponent_id = t.id))))
     LEFT JOIN players p ON ((p.team_id = t.id)))
  GROUP BY t.id;

CREATE OR REPLACE VIEW public.recent_scrape_jobs AS
 SELECT DISTINCT ON (team_id) id,
    org_id,
    team_id,
    source,
    status,
    games_found,
    games_ingested,
    error_message,
    started_at,
    finished_at,
    created_at
   FROM scrape_jobs
  ORDER BY team_id, created_at DESC;

CREATE OR REPLACE VIEW public.v_team_verified_stats_health AS
 SELECT t.id AS team_id,
    t.team_name,
    v.updated_at,
    v.games,
    v.box_score_games,
    v.play_by_play_games,
    v.validated_games,
    v.mismatch_games,
    v.confidence,
    ((v.batting_official ->> 'pa'::text))::integer AS official_pa,
    ((v.batting_official ->> 'ab'::text))::integer AS official_ab,
    ((v.batting_official ->> 'h'::text))::integer AS official_h,
    ((v.batting_official ->> 'bb'::text))::integer AS official_bb,
    ((v.batting_official ->> 'so'::text))::integer AS official_so,
    ((v.batting_official ->> 'hbp'::text))::integer AS official_hbp,
    ((v.pitching_reconstructed ->> 'wp'::text))::integer AS side_attributed_wp,
    ((v.pitching_reconstructed ->> 'pb'::text))::integer AS side_attributed_pb,
    v.warnings
   FROM (derived_team_verified_totals v
     JOIN teams t ON ((t.id = v.team_id)));

-- ── Indexes ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_batting_lines_team_game ON public.batting_lines USING btree (team_id, game_id);
CREATE INDEX IF NOT EXISTS idx_games_date ON public.games USING btree (org_id, game_date DESC);
CREATE INDEX IF NOT EXISTS idx_games_opponent ON public.games USING btree (org_id, opponent_id);
CREATE INDEX IF NOT EXISTS idx_games_org_id ON public.games USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_games_our_team ON public.games USING btree (org_id, our_team_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON public.org_members USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON public.org_members USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_pitches_at_bat_id ON public.pitches USING btree (at_bat_id);
CREATE INDEX IF NOT EXISTS idx_pitches_game_id ON public.pitches USING btree (game_id);
CREATE INDEX IF NOT EXISTS idx_pitches_org_id ON public.pitches USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_pitches_pitcher_id ON public.pitches USING btree (pitcher_id);
CREATE INDEX IF NOT EXISTS idx_pitching_lines_team_game ON public.pitching_lines USING btree (team_id, game_id);
CREATE INDEX IF NOT EXISTS idx_play_events_team_game ON public.play_events USING btree (team_id, game_id);
CREATE INDEX IF NOT EXISTS idx_players_name_trgm ON public.players USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_players_org_id ON public.players USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_players_team_id ON public.players USING btree (team_id);
CREATE INDEX IF NOT EXISTS idx_reports_linked_team ON public.reports USING btree (org_id, linked_team_id);
CREATE INDEX IF NOT EXISTS idx_reports_org_id ON public.reports USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_org_id ON public.scrape_jobs USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON public.scrape_jobs USING btree (status) WHERE (status = ANY (ARRAY['pending'::scrape_status, 'running'::scrape_status]));
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_team_id ON public.scrape_jobs USING btree (team_id);
CREATE INDEX IF NOT EXISTS idx_stat_validation_runs_team_created ON public.stat_validation_runs USING btree (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_teams_archived ON public.teams USING btree (archived);
CREATE INDEX IF NOT EXISTS idx_teams_org_id ON public.teams USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_teams_our_team ON public.teams USING btree (org_id, is_our_team);
CREATE INDEX IF NOT EXISTS idx_at_bats_batter_id ON public.at_bats USING btree (batter_id);
CREATE INDEX IF NOT EXISTS idx_at_bats_game_id ON public.at_bats USING btree (game_id);
CREATE INDEX IF NOT EXISTS idx_at_bats_org_id ON public.at_bats USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_at_bats_pitcher_id ON public.at_bats USING btree (pitcher_id);
CREATE INDEX IF NOT EXISTS idx_derived_team_verified_totals_run ON public.derived_team_verified_totals USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_game_stat_validation_results_run ON public.game_stat_validation_results USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_game_stat_validation_results_team_game ON public.game_stat_validation_results USING btree (team_id, game_id);
