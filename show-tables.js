const D = require('better-sqlite3'); const d = new D('voodoo-scout.db'); console.log(JSON.stringify(d.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table'), null, 2));
