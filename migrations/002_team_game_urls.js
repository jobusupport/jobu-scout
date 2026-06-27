'use strict';

/**
 * migrations/002_team_game_urls.js
 * Adds the team_game_urls table for teams not tracked in GameChanger.
 * Run once: node migrations/002_team_game_urls.js
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'voodoo-scout.db');
const db      = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_game_urls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    gc_game_url  TEXT    NOT NULL,
    label        TEXT    DEFAULT '',
    box_side     TEXT    NOT NULL DEFAULT 'away' CHECK(box_side IN ('away','home')),
    processed_at TEXT,
    created_at   TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_team_game_urls_team_id ON team_game_urls(team_id);
`);

db.close();
console.log('✓ Migration 002: team_game_urls table created.');