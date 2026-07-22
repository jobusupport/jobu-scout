-- Foundational schema baseline (Slice 1 branch-validation follow-up), part 3 of 6.
-- See supabase/README.md for the full explanation of why this exists.
-- Reconstructed via read-only introspection (Supabase list_tables +
-- information_schema/pg_catalog queries), NOT a pg_dump/db push output.

-- Views and non-primary-key/non-unique indexes for foundational and
-- tracked-migration tables. (Primary key and unique indexes were already
-- created implicitly by their constraints in files 1 and 2 -- not repeated
-- here.)

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

-- ── Tracked-migration view (admin_customer_overview_view) ──────────────────
CREATE OR REPLACE VIEW public.admin_customer_overview AS
 SELECT id,
    name,
    slug,
    contact_email,
    plan,
    status,
    subscription_status,
    stripe_customer_id,
    stripe_subscription_id,
    plan_expires_at,
    max_opponent_teams,
    max_reports_per_month,
    max_users,
    max_self_scout_reports_per_month,
    max_matchup_reports_per_month,
    created_at,
    ( SELECT count(*) AS count
           FROM org_members m
          WHERE ((m.org_id = o.id) AND (m.accepted_at IS NOT NULL))) AS member_count,
    ( SELECT count(*) AS count
           FROM teams t
          WHERE (t.org_id = o.id)) AS team_count,
    ( SELECT count(*) AS count
           FROM reports r
          WHERE (r.org_id = o.id)) AS reports_total,
    ( SELECT count(*) AS count
           FROM reports r
          WHERE ((r.org_id = o.id) AND (r.created_at >= date_trunc('month'::text, now())))) AS reports_this_period,
    ( SELECT COALESCE(sum(a.estimated_cost_usd), (0)::numeric) AS "coalesce"
           FROM ai_usage_events a
          WHERE (a.org_id = o.id)) AS ai_cost_total_usd,
    ( SELECT COALESCE(sum(a.estimated_cost_usd), (0)::numeric) AS "coalesce"
           FROM ai_usage_events a
          WHERE ((a.org_id = o.id) AND (a.created_at >= date_trunc('month'::text, now())))) AS ai_cost_this_period_usd,
    ( SELECT r.generated_at
           FROM reports r
          WHERE ((r.org_id = o.id) AND (r.generated_at IS NOT NULL))
          ORDER BY r.generated_at DESC
         LIMIT 1) AS last_report_at,
    ( SELECT (r.status)::text AS status
           FROM reports r
          WHERE (r.org_id = o.id)
          ORDER BY r.created_at DESC
         LIMIT 1) AS last_report_status,
    ( SELECT s.finished_at
           FROM scrape_jobs s
          WHERE ((s.org_id = o.id) AND (s.status = 'done'::scrape_status))
          ORDER BY s.finished_at DESC
         LIMIT 1) AS last_successful_scrape_at,
    ( SELECT (s.status)::text AS status
           FROM scrape_jobs s
          WHERE (s.org_id = o.id)
          ORDER BY s.created_at DESC
         LIMIT 1) AS last_scrape_status
   FROM organizations o;

-- Grants on this view were found NOT to follow the standard Supabase
-- default set (verified against production, not assumed) -- service_role
-- only, deliberately excluding anon/authenticated since this is an
-- admin-only aggregate over every tenant's data.
revoke all on public.admin_customer_overview from anon, authenticated;
grant select, insert, update, delete, references, trigger, truncate on public.admin_customer_overview to service_role;

-- ── Indexes for tracked-migration tables ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON public.admin_audit_log USING btree (action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_user_id ON public.admin_audit_log USING btree (admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON public.admin_audit_log USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_org_id ON public.admin_audit_log USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_admin_support_sessions_org_id ON public.admin_support_sessions USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_admin_support_sessions_token ON public.admin_support_sessions USING btree (token);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created_at ON public.ai_usage_events USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_org_id ON public.ai_usage_events USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_report_id ON public.ai_usage_events USING btree (report_id);
CREATE INDEX IF NOT EXISTS idx_org_entitlement_overrides_org_id ON public.org_entitlement_overrides USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_org_support_notes_org_id ON public.org_support_notes USING btree (org_id);
CREATE INDEX IF NOT EXISTS idx_platform_admins_user_id ON public.platform_admins USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_player_gc_spray_charts_team ON public.player_gc_spray_charts USING btree (team_id);
CREATE INDEX IF NOT EXISTS idx_player_gc_stats_team ON public.player_gc_stats USING btree (team_id);
CREATE INDEX IF NOT EXISTS idx_player_handedness_team ON public.player_handedness USING btree (team_id);
CREATE INDEX IF NOT EXISTS idx_player_handedness_team_matchkey ON public.player_handedness USING btree (team_id, match_key);
CREATE INDEX IF NOT EXISTS idx_roster_players_team ON public.roster_players USING btree (team_id);
