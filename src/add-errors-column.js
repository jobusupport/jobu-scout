/**
 * add-errors-column.js
 *
 * One-off local migration: adds the `errors` column to
 * player_advanced_stats and pitcher_advanced_stats in your local SQLite
 * dev database (voodoo-scout.db), mirroring the Supabase migration already
 * applied to production. Safe to run more than once — checks for the
 * column first and skips it if already present, rather than relying on
 * SQLite's "ADD COLUMN IF NOT EXISTS" (only available in newer SQLite
 * versions, so this is the more portable approach).
 *
 * Run from project root:
 *   node src/add-errors-column.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'voodoo-scout.db');

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

function main() {
  const db = new Database(DB_PATH);

  const tables = ['player_advanced_stats', 'pitcher_advanced_stats'];

  for (const table of tables) {
    if (columnExists(db, table, 'errors')) {
      console.log(`[migrate] ${table}.errors already exists — skipping.`);
      continue;
    }

    console.log(`[migrate] Adding errors column to ${table}...`);
    db.prepare(`ALTER TABLE ${table} ADD COLUMN errors INTEGER DEFAULT 0`).run();
    console.log(`[migrate] Done: ${table}.errors added.`);
  }

  db.close();
  console.log('\n[migrate] Local SQLite schema is now up to date.');
}

main();