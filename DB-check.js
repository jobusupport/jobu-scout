'use strict';
require('dotenv').config();
const db = require('./src/db');
db.init('./voodoo-scout.db');
const d = db.getDb();

const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

const games = d.prepare("SELECT COUNT(*) as n FROM games WHERE team_id=1").get();
console.log('Birmingham games in DB:', games.n);

const adv = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='player_advanced_stats'").get();
console.log('player_advanced_stats exists:', !!adv);

if (games.n > 0) {
  const sample = d.prepare("SELECT player_name, ab, h, hr, doubles, triples, bb, so, obp, slg FROM batting_lines WHERE team_id=1 AND is_our_team=1 LIMIT 3").all();
  console.log('\nSample batting lines:');
  sample.forEach(r => console.log(' ', JSON.stringify(r)));

  const plays = d.prepare("SELECT COUNT(*) as n FROM play_events WHERE team_id=1").get();
  console.log('\nPlay events:', plays.n);

  if (adv) {
    const advRows = d.prepare("SELECT COUNT(*) as n FROM player_advanced_stats WHERE team_id=1").get();
    console.log('player_advanced_stats rows:', advRows.n);

    const pitAdv = d.prepare("SELECT COUNT(*) as n FROM pitcher_advanced_stats WHERE team_id=1").get();
    console.log('pitcher_advanced_stats rows:', pitAdv.n);

    const sample2 = d.prepare("SELECT player_name, gb_pct, fb_pct, spray_lf_pct, spray_cf_pct, spray_rf_pct, k_pct, bb_pct FROM player_advanced_stats WHERE team_id=1 LIMIT 3").all();
    console.log('\nSample advanced stats:');
    sample2.forEach(r => console.log(' ', JSON.stringify(r)));
  }
}