const db = require('better-sqlite3')('voodoo-scout.db');
const teams = db.prepare(`
  SELECT t.id, t.team_name, t.gc_team_url, t.pg_team_url,
         COUNT(DISTINCT g.id) AS game_count
  FROM teams t
  LEFT JOIN games g ON g.team_id = t.id
  GROUP BY t.id
  ORDER BY t.team_name, t.id
`).all();

console.log(`\nTotal teams: ${teams.length}\n`);
for (const t of teams) {
  console.log(`[${t.id}] "${t.team_name}"`);
  console.log(`      games: ${t.game_count}`);
  console.log(`      gc:    ${t.gc_team_url || '(none)'}`);
  console.log(`      pg:    ${t.pg_team_url || '(none)'}`);
  console.log('');
}
db.close();