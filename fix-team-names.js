const db = require('better-sqlite3')('voodoo-scout.db');
const teams = db.prepare('SELECT id, team_name FROM teams').all();
let fixed = 0;
for (const t of teams) {
  const clean = t.team_name.replace(/\([0-9-]+ in [0-9]{4}\)/g, '').trim();
  if (clean !== t.team_name) {
    db.prepare('UPDATE teams SET team_name = ? WHERE id = ?').run(clean, t.id);
    console.log('Fixed:', t.team_name, '->', clean);
    fixed++;
  }
}
console.log('Total fixed:', fixed);
db.close();
