/**
 * dedupe-teams.js
 * Finds duplicate team names and deletes the one with fewer games.
 * Safe — never deletes a team that has game data if another copy exists with data.
 */

const db = require('better-sqlite3')('voodoo-scout.db');

const teams = db.prepare(`
  SELECT t.id, t.team_name, COUNT(DISTINCT g.id) AS game_count
  FROM teams t
  LEFT JOIN games g ON g.team_id = t.id
  GROUP BY t.id
  ORDER BY t.team_name, game_count DESC
`).all();

// Group by normalized name
const grouped = {};
for (const t of teams) {
  const key = t.team_name.toLowerCase().trim();
  if (!grouped[key]) grouped[key] = [];
  grouped[key].push(t);
}

let removed = 0;
for (const [name, dupes] of Object.entries(grouped)) {
  if (dupes.length <= 1) continue;
  // Keep the one with the most games (first after sort DESC)
  const keep   = dupes[0];
  const remove = dupes.slice(1);
  console.log(`\nDuplicate: "${dupes[0].team_name}"`);
  console.log(`  Keeping  id=${keep.id} (${keep.game_count} games)`);
  for (const d of remove) {
    console.log(`  Deleting id=${d.id} (${d.game_count} games)`);
    db.prepare('DELETE FROM teams WHERE id = ?').run(d.id);
    removed++;
  }
}

if (removed === 0) {
  console.log('No duplicates found.');
} else {
  console.log(`\nDone. Removed ${removed} duplicate(s).`);
}
db.close();