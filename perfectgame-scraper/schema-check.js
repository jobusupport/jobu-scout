require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = process.env.GC_DB_PATH || 
  path.join(__dirname, "../gamechanger-scraper/database/gamechanger.db");

console.log("Looking for DB at:", DB_PATH);

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error("Could not open database:", err.message);
    console.error("Set GC_DB_PATH in your .env to the correct path.");
    process.exit(1);
  }
});

db.all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`, [], (err, tables) => {
  if (err) { console.error(err); return; }
  console.log("\nTABLES FOUND:", tables.map(t => t.name).join(", "));

  for (const { name } of tables) {
    db.all(`PRAGMA table_info(${name})`, [], (err2, cols) => {
      if (err2) return;
      console.log(`\n${name}:\n  ` + cols.map(c => `${c.name} (${c.type})`).join("\n  "));
    });
  }
});