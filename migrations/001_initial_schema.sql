-- ============================================================
-- Voodoo Scout — SQLite Schema v1
-- Run once to initialize the database.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Teams ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_name        TEXT    NOT NULL,
  raw_team_name    TEXT,
  gc_search_name   TEXT,
  gc_team_url      TEXT,
  pg_team_url      TEXT,              -- Perfect Game URL (optional)
  classification   TEXT,              -- e.g. "Varsity", "16U"
  age_group        TEXT,              -- e.g. "16", "17"
  city             TEXT,
  state            TEXT,
  season_year      INTEGER,
  season_type      TEXT,              -- "spring" | "summer" | "fall"
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (gc_team_url)
);

-- ── Games ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  gc_game_id       TEXT    UNIQUE,    -- extracted from GC URL slug
  gc_game_url      TEXT,
  game_date        TEXT,              -- ISO 8601 date: "2026-04-12"
  game_time        TEXT,              -- "14:00"
  game_datetime_raw TEXT,             -- raw string from GC header
  result           TEXT,              -- "W" | "L" | "T" | null
  score_us         INTEGER,
  score_them       INTEGER,
  opponent_name    TEXT,
  location         TEXT,
  season_type      TEXT,
  json_file        TEXT,              -- path to raw extracted JSON
  screenshot_file  TEXT,              -- path to fallback screenshot (if any)
  captured_at      TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Batting Lines ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS batting_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_name      TEXT    NOT NULL,
  batting_order    INTEGER,
  is_our_team      INTEGER,           -- 1 = our team, 0 = opponent, null = unknown
  team_side        TEXT,              -- "away" | "home"
  team_name_raw    TEXT,              -- full GC team name e.g. "Birmingham Stars 14U"
  position         TEXT,              -- "CF", "SS", "P", etc.
  ab               INTEGER,           -- at-bats
  r                INTEGER,           -- runs
  h                INTEGER,           -- hits
  rbi              INTEGER,
  bb               INTEGER,           -- walks
  so               INTEGER,           -- strikeouts
  avg              TEXT,              -- batting average (stored as text e.g. ".333")
  obp              TEXT,
  slg              TEXT,
  doubles          INTEGER,
  triples          INTEGER,
  hr               INTEGER,
  sb               INTEGER,           -- stolen bases
  hbp              INTEGER,           -- hit by pitch
  sac              INTEGER,           -- sacrifice
  lob              INTEGER,           -- left on base
  raw_json         TEXT,              -- full raw row as JSON blob
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Pitching Lines ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pitching_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_name      TEXT    NOT NULL,
  is_our_team      INTEGER,           -- 1 = our team, 0 = opponent, null = unknown
  team_side        TEXT,              -- "away" | "home"
  team_name_raw    TEXT,              -- full GC team name e.g. "Birmingham Stars 14U"
  ip               TEXT,              -- innings pitched e.g. "3.2"
  ip_decimal       REAL,              -- computed: 3.2 → 3.667
  bf               INTEGER,           -- batters faced
  pc               INTEGER,           -- pitch count
  strikes          INTEGER,
  h_allowed        INTEGER,
  r_allowed        INTEGER,
  er               INTEGER,           -- earned runs
  bb               INTEGER,
  so               INTEGER,
  hr_allowed       INTEGER,
  era              TEXT,
  whip             TEXT,
  raw_json         TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Play-by-Play Events ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS play_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  sequence_num     INTEGER NOT NULL,  -- chronological order within game
  inning           TEXT,              -- e.g. "Top 3", "Bottom 5"
  inning_num       INTEGER,
  inning_half      TEXT,              -- "top" | "bottom"
  event_type       TEXT,              -- normalized: "single","strikeout","walk", etc.
  batter_name      TEXT,
  pitcher_name     TEXT,
  description      TEXT,              -- raw play text
  runners_on       TEXT,              -- "bases_empty","first","first_second", etc.
  outs_before      INTEGER,
  result_rbi       INTEGER,
  is_scoring_play  INTEGER DEFAULT 0, -- boolean
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Tendencies (AI-generated, stored per team) ───────────────
CREATE TABLE IF NOT EXISTS team_tendencies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  generated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  games_analyzed   INTEGER,
  -- Batting tendencies
  pull_pct         REAL,              -- % of balls pulled
  oppo_pct         REAL,
  gb_pct           REAL,              -- ground ball %
  fb_pct           REAL,              -- fly ball %
  k_pct            REAL,              -- strikeout %
  bb_pct           REAL,              -- walk %
  -- Pitching tendencies
  avg_pitch_count  REAL,
  avg_ip_per_game  REAL,
  -- Summary blobs (AI output)
  batting_summary  TEXT,
  pitching_summary TEXT,
  game_plan_notes  TEXT,
  raw_analysis     TEXT,              -- full AI JSON response
  model_version    TEXT               -- claude model used
);

-- ── Scouting Reports ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scouting_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  report_type      TEXT    NOT NULL,  -- "full_scout" | "game_summary" | "tendency"
  generated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  games_covered    TEXT,              -- JSON array of game_ids
  file_path        TEXT,              -- path to .docx or .pdf
  file_format      TEXT,              -- "docx" | "pdf"
  delivered        INTEGER DEFAULT 0, -- boolean: emailed/pushed
  delivered_at     TEXT,
  recipient_email  TEXT
);

-- ── Coaches / Subscribers ────────────────────────────────────
CREATE TABLE IF NOT EXISTS coaches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL UNIQUE,
  team_id          INTEGER REFERENCES teams(id),
  subscription_active INTEGER DEFAULT 1,
  report_frequency TEXT    DEFAULT 'weekly',  -- "daily" | "weekly" | "on_game"
  report_format    TEXT    DEFAULT 'pdf',
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_games_team_id   ON games(team_id);
CREATE INDEX IF NOT EXISTS idx_games_date      ON games(game_date);
CREATE INDEX IF NOT EXISTS idx_batting_game    ON batting_lines(game_id);
CREATE INDEX IF NOT EXISTS idx_batting_player  ON batting_lines(player_name);
CREATE INDEX IF NOT EXISTS idx_pitching_game   ON pitching_lines(game_id);
CREATE INDEX IF NOT EXISTS idx_plays_game      ON play_events(game_id);
CREATE INDEX IF NOT EXISTS idx_plays_type      ON play_events(event_type);
CREATE INDEX IF NOT EXISTS idx_tendencies_team ON team_tendencies(team_id);

-- ============================================================
-- Voodoo Scout — Migration: Add Advanced Stats Tables
-- Add this block to the END of 001_initial_schema.sql
-- ============================================================

-- ── Player Advanced Stats (batting) ──────────────────────────
CREATE TABLE IF NOT EXISTS player_advanced_stats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_name      TEXT    NOT NULL,
  is_our_team      INTEGER NOT NULL DEFAULT 1,  -- 1 = our team, 0 = opponent
  generated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  games            INTEGER,
  total_pitches    INTEGER,
  -- Batted ball
  gb               INTEGER,
  fb               INTEGER,
  ld               INTEGER,
  batted_balls     INTEGER,
  gb_pct           REAL,
  fb_pct           REAL,
  ld_pct           REAL,
  -- Spray zones (counts)
  spray_lf         INTEGER,
  spray_cf         INTEGER,
  spray_rf         INTEGER,
  spray_3b         INTEGER,
  spray_ss         INTEGER,
  spray_2b         INTEGER,
  spray_1b         INTEGER,
  spray_pc         INTEGER,
  -- Spray zones (percentages)
  spray_lf_pct     REAL,
  spray_cf_pct     REAL,
  spray_rf_pct     REAL,
  spray_3b_pct     REAL,
  spray_ss_pct     REAL,
  spray_2b_pct     REAL,
  spray_1b_pct     REAL,
  spray_pc_pct     REAL,
  -- RISP
  risp_ab          INTEGER,
  risp_h           INTEGER,
  ba_risp          REAL,
  -- Swing decisions (JSON blob)
  swing_decisions  TEXT,
  -- Plate discipline
  k_pct            REAL,
  bb_pct           REAL,
  UNIQUE (team_id, player_name, is_our_team)
);

-- ── Pitcher Advanced Stats ────────────────────────────────────
CREATE TABLE IF NOT EXISTS pitcher_advanced_stats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_name      TEXT    NOT NULL,
  is_our_team      INTEGER NOT NULL DEFAULT 1,
  generated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  games            INTEGER,
  total_pitches    INTEGER,
  strikes          INTEGER,
  s_pct            REAL,   -- strike percentage
  -- Batted ball allowed
  gb               INTEGER,
  fb               INTEGER,
  ld               INTEGER,
  gb_pct           REAL,
  fb_pct           REAL,
  ld_pct           REAL,
  go_ao            REAL,   -- ground out / air out ratio
  -- Per-7-inning rates
  so_per7          REAL,
  bb_per7          REAL,
  -- Per-BF rates
  k_pct_bf         REAL,
  bb_pct_bf        REAL,
  -- Efficiency
  p_per_ip         REAL,
  -- Misc
  wp               INTEGER,
  bk               INTEGER,
  pik              INTEGER,
  UNIQUE (team_id, player_name, is_our_team)
);

-- ── Indexes for advanced stats ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_player_adv_team   ON player_advanced_stats(team_id);
CREATE INDEX IF NOT EXISTS idx_pitcher_adv_team  ON pitcher_advanced_stats(team_id);