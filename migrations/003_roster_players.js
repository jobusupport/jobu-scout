'use strict';

/**
 * migrations/003_roster_players.js
 * Adds the roster_players table backing the My Team > Roster tab: manually
 * maintained per-team roster (name, jersey, handedness, positions,
 * availability/injury status, pickup-player flag).
 *
 * Named roster_players (not "players") to avoid colliding with the
 * pre-existing public.players table in Supabase, which is a different
 * concept (stat-tracking player identity linked to at_bats/pitches for the
 * pitch-by-pitch feature) with a different column layout.
 *
 * Run once: node migrations/003_roster_players.js
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'voodoo-scout.db');
const db      = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS roster_players (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id              INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    first_name           TEXT    NOT NULL,
    last_name             TEXT    NOT NULL,
    jersey_number        TEXT,
    handedness           TEXT,              -- e.g. "R/R","L/L","S/R","S/L","R/L","L/R" (bats/throws)
    positions            TEXT,              -- comma-separated, e.g. "SS,2B"
    is_pickup            INTEGER NOT NULL DEFAULT 0,
    availability_status  TEXT    NOT NULL DEFAULT 'available'
                           CHECK(availability_status IN ('available','unavailable','injured')),
    unavailable_until    TEXT,              -- date; set when availability_status = 'unavailable'
    injury_return_date   TEXT,              -- date, or NULL for "TBD"; set when availability_status = 'injured'
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_roster_players_team ON roster_players(team_id);
`);

db.close();
console.log('✓ Migration 003: roster_players table created.');
