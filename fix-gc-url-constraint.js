/**
 * fix-gc-url-constraint.js
 * Removes the UNIQUE constraint on gc_team_url in the teams table.
 * Multiple teams can legitimately have no GC URL (null), which
 * violates a UNIQUE constraint when more than one row is null.
 *
 * SQLite doesn't support DROP CONSTRAINT so we recreate the table.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'voodoo-scout.db');
const db      = new Database(DB_PATH);

// Check current schema
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='teams'").get();
console.log('Current teams schema:');
console.log(schema.sql);
console.log('');

if (!schema.sql.toUpperCase().includes('UNIQUE')) {
  console.log('✓ No UNIQUE constraint found on teams table — nothing to fix.');
  db.close();
  process.exit(0);
}

console.log('Found UNIQUE constraint — recreating table without it...');

db.exec(`
  PRAGMA foreign_keys = OFF;

  -- Create replacement table without UNIQUE on gc_team_url
  CREATE TABLE IF NOT EXISTS teams_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_name       TEXT    NOT NULL,
    raw_team_name   TEXT,
    gc_search_name  TEXT,
    gc_team_url     TEXT,
    pg_team_url     TEXT,
    classification  TEXT,
    age_group       TEXT,
    city            TEXT,
    state           TEXT,
    season_year     INTEGER,
    season_type     TEXT,
    created_at      TEXT    DEFAULT (datetime('now')),
    updated_at      TEXT    DEFAULT (datetime('now'))
  );

  -- Copy all data
  INSERT INTO teams_new
    SELECT id, team_name, raw_team_name, gc_search_name,
           gc_team_url, pg_team_url, classification, age_group,
           city, state, season_year, season_type, created_at, updated_at
    FROM teams;

  -- Swap tables
  DROP TABLE teams;
  ALTER TABLE teams_new RENAME TO teams;

  PRAGMA foreign_keys = ON;
`);

// Verify
const newSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='teams'").get();
console.log('');
console.log('New teams schema:');
console.log(newSchema.sql);

const count = db.prepare('SELECT COUNT(*) as n FROM teams').get();
console.log(`\n✓ Done. ${count.n} teams preserved.`);
db.close();