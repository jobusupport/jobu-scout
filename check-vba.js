const db = require('better-sqlite3')('voodoo-scout.db');
console.table(db.prepare("SELECT id, team_name, pg_team_url FROM teams WHERE team_name LIKE '%VBA%'").all());
db.close();
