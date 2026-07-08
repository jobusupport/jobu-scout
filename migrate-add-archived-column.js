'use strict';

/**
 * migrate-add-archived-column.js
 * One-time migration: adds teams.archived (INTEGER, default 0) to the local
 * SQLite DB if it isn't already there. Safe to run more than once.
 *
 * Usage (from project root, C:\playwright-projects\gamechanger-scraper):
 *   node migrate-add-archived-column.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'voodoo-scout.db');
const db = new Database(DB_PATH);

const cols = db.prepare(`PRAGMA table_info(teams)`).all().map(c => c.name);

if (cols.includes('archived')) {
  console.log('[migrate] teams.archived already exists — nothing to do.');
} else {
  db.exec(`ALTER TABLE teams ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_teams_archived ON teams(archived);`);
  console.log('[migrate] Added teams.archived column and index.');
}

db.close();
console.log('[migrate] Done.');
