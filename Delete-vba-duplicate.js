const db = require('better-sqlite3')('voodoo-scout.db');
db.prepare('DELETE FROM teams WHERE id = 42').run();
console.log('Deleted duplicate VBA team (id 42)');
db.close();