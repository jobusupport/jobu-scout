'use strict';

/**
 * sync-to-supabase.js
 * JoBu Scout — One-way sync from local SQLite → Supabase Postgres
 *
 * Run from project root:
 *   node sync-to-supabase.js
 *
 * Safe to re-run — uses upsert/dedup on all tables.
 * Does NOT delete anything from Supabase.
 */

require('dotenv').config();

const Database  = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const path      = require('path');

const DB_PATH = path.join(__dirname, 'voodoo-scout.db');

let ORG_ID       = null; // set from SYNC_ORG_ID env var in main()
let OUR_TEAM_SB_ID = null; // Supabase UUID of the "our team" row

// ── Supabase client (service role — bypasses RLS) ────────────────────────────
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── SQLite connection ─────────────────────────────────────────────────────────
const sqlite = new Database(DB_PATH, { readonly: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

const BATCH = 200;

async function upsertBatch(table, rows, conflictCol, label) {
  if (!rows.length) { console.log(`  (no rows to insert)`); return 0; }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from(table).upsert(chunk, { onConflict: conflictCol, ignoreDuplicates: true });
    if (error) {
      console.error(`  ✗ ${label} batch ${i}–${i + chunk.length}: ${error.message}`);
    } else {
      inserted += chunk.length;
      process.stdout.write(`\r  → ${label}: ${inserted}/${rows.length}`);
    }
  }
  console.log();
  return inserted;
}

// ── ID maps (SQLite integer id → Supabase uuid) ───────────────────────────────
const teamIdMap = new Map();  // sqlite_id → supabase_uuid
const gameIdMap = new Map();  // sqlite_id → supabase_uuid

// ── 1. Teams ──────────────────────────────────────────────────────────────────

async function syncTeams() {
  console.log('\n[1/7] Syncing teams...');

  const rows = sqlite.prepare('SELECT * FROM teams ORDER BY id').all();
  console.log(`  Found ${rows.length} teams in SQLite`);

  for (const row of rows) {
    const payload = {
      org_id:         ORG_ID,
      team_name:      row.team_name,
      raw_team_name:  row.raw_team_name  || null,
      gc_search_name: row.gc_search_name || null,
      gc_team_url:    row.gc_team_url    || null,
      pg_team_url:    row.pg_team_url    || null,
      classification: row.classification || null,
      age_group:      row.age_group      || null,
      city:           row.city           || null,
      state:          row.state          || null,
      season_year:    row.season_year    ? String(row.season_year) : null,
      season_type:    row.season_type    || null,
      is_our_team:    false,
    };

    let existing = null;
    if (payload.gc_team_url) {
      const { data } = await sb.from('teams').select('id').eq('gc_team_url', payload.gc_team_url).maybeSingle();
      existing = data;
    }
    if (!existing) {
      const { data } = await sb.from('teams').select('id').ilike('team_name', payload.team_name).maybeSingle();
      existing = data;
    }

    if (existing) {
      teamIdMap.set(row.id, existing.id);
    } else {
      const { data, error } = await sb.from('teams').insert(payload).select('id').single();
      if (error) {
        console.error(`  ✗ Team "${row.team_name}": ${error.message}`);
      } else {
        teamIdMap.set(row.id, data.id);
      }
    }
  }

  console.log(`  ✓ Teams synced: ${teamIdMap.size} mapped`);

  // ── Resolve "our team" Supabase UUID ──────────────────────────────────────
  // Our team should already exist in Supabase with is_our_team = true.
  // If SYNC_OUR_TEAM_ID is set, use that directly; otherwise look it up.
  if (process.env.SYNC_OUR_TEAM_ID) {
    OUR_TEAM_SB_ID = process.env.SYNC_OUR_TEAM_ID;
    console.log(`  Our team ID (from env): ${OUR_TEAM_SB_ID}`);
  } else {
    const { data, error } = await sb
      .from('teams')
      .select('id, team_name')
      .eq('org_id', ORG_ID)
      .eq('is_our_team', true)
      .maybeSingle();

    if (error || !data) {
      console.error('  ✗ Could not find "our team" in Supabase (is_our_team = true).');
      console.error('    Set SYNC_OUR_TEAM_ID=<uuid> in .env, or ensure your team has is_our_team=true in Supabase.');
      process.exit(1);
    }
    OUR_TEAM_SB_ID = data.id;
    console.log(`  Our team: "${data.team_name}" → ${OUR_TEAM_SB_ID}`);
  }
}

// ── 2. Games ──────────────────────────────────────────────────────────────────

async function syncGames() {
  console.log('\n[2/7] Syncing games...');

  const rows = sqlite.prepare('SELECT * FROM games ORDER BY id').all();
  console.log(`  Found ${rows.length} games in SQLite`);

  let synced = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    // In SQLite, team_id = the opponent team scraped
    const sbOpponentId = teamIdMap.get(row.team_id);
    if (!sbOpponentId) {
      console.warn(`  ⚠ Game ${row.id}: no Supabase team for SQLite team_id ${row.team_id} — skipping`);
      skipped++;
      continue;
    }

    // Check if game already exists
    if (row.gc_game_id) {
      const { data } = await sb.from('games').select('id').eq('gc_game_id', row.gc_game_id).maybeSingle();
      if (data) {
        gameIdMap.set(row.id, data.id);
        skipped++;
        continue;
      }
    }

    const payload = {
      org_id:            ORG_ID,
      our_team_id:       OUR_TEAM_SB_ID,   // ← the "us" side, always the same org team
      opponent_id:       sbOpponentId,      // ← the team we scraped / scouted
      gc_game_id:        row.gc_game_id        || null,
      gc_game_url:       row.gc_game_url       || null,
      game_date:         row.game_date         || null,
      game_time:         row.game_time         || null,
      game_datetime_raw: row.game_datetime_raw || null,
      result:            row.result            || null,
      score_us:          row.score_us          ?? null,
      score_them:        row.score_them        ?? null,
      opponent_name:     row.opponent_name     || null,
      location:          row.location          || null,
      season_type:       row.season_type       || null,
      json_file:         row.json_file         || null,
      screenshot_file:   row.screenshot_file   || null,
      captured_at:       row.captured_at       || null,
    };

    const { data, error } = await sb.from('games').insert(payload).select('id').single();
    if (error) {
      console.error(`  ✗ Game ${row.id} (${row.gc_game_id}): ${error.message}`);
      failed++;
    } else {
      gameIdMap.set(row.id, data.id);
      synced++;
      if (synced % 10 === 0) process.stdout.write(`\r  → ${synced} games inserted...`);
    }
  }

  console.log(`\n  ✓ Games: ${synced} inserted, ${skipped} already existed, ${failed} failed`);
}

// ── 3. Batting Lines ──────────────────────────────────────────────────────────

async function syncBattingLines() {
  console.log('\n[3/7] Syncing batting lines...');

  const rows = sqlite.prepare('SELECT * FROM batting_lines ORDER BY id').all();
  console.log(`  Found ${rows.length} batting lines in SQLite`);

  const mapped = [];
  let skipped = 0;

  for (const row of rows) {
    const sbGameId = gameIdMap.get(row.game_id);
    const sbTeamId = teamIdMap.get(row.team_id);
    if (!sbGameId || !sbTeamId) { skipped++; continue; }

    mapped.push({
      game_id:       sbGameId,
      team_id:       sbTeamId,
      org_id:        ORG_ID,
      player_name:   row.player_name,
      batting_order: row.batting_order  ?? null,
      is_our_team:   row.is_our_team    === 1,
      team_side:     row.team_side      || null,
      team_name_raw: row.team_name_raw  || null,
      position:      row.position       || null,
      ab:            row.ab             ?? 0,
      r:             row.r              ?? 0,
      h:             row.h              ?? 0,
      rbi:           row.rbi            ?? 0,
      bb:            row.bb             ?? 0,
      so:            row.so             ?? 0,
      avg:           row.avg            ? parseFloat(row.avg)  : null,
      obp:           row.obp            ? parseFloat(row.obp)  : null,
      slg:           row.slg            ? parseFloat(row.slg)  : null,
      doubles:       row.doubles        ?? 0,
      triples:       row.triples        ?? 0,
      hr:            row.hr             ?? 0,
      sb:            row.sb             ?? 0,
      hbp:           row.hbp            ?? 0,
      sac:           row.sac            ?? 0,
      lob:           row.lob            ?? 0,
      raw_json:      row.raw_json       || null,
    });
  }

  if (skipped) console.log(`  ⚠ Skipped ${skipped} rows with unmapped game/team IDs`);
  // Conflict on game_id + player_name + is_our_team (no sqlite id in payload)
  await upsertBatch('batting_lines', mapped, 'game_id,player_name,is_our_team', 'batting lines');
}

// ── 4. Pitching Lines ─────────────────────────────────────────────────────────

async function syncPitchingLines() {
  console.log('\n[4/7] Syncing pitching lines...');

  const rows = sqlite.prepare('SELECT * FROM pitching_lines ORDER BY id').all();
  console.log(`  Found ${rows.length} pitching lines in SQLite`);

  const mapped = [];
  let skipped = 0;

  for (const row of rows) {
    const sbGameId = gameIdMap.get(row.game_id);
    const sbTeamId = teamIdMap.get(row.team_id);
    if (!sbGameId || !sbTeamId) { skipped++; continue; }

    mapped.push({
      game_id:       sbGameId,
      team_id:       sbTeamId,
      org_id:        ORG_ID,
      player_name:   row.player_name,
      is_our_team:   row.is_our_team    === 1,
      team_side:     row.team_side      || null,
      team_name_raw: row.team_name_raw  || null,
      ip:            row.ip             || null,
      ip_decimal:    row.ip_decimal     ?? null,
      bf:            row.bf             ?? 0,
      pc:            row.pc             ?? 0,
      strikes:       row.strikes        ?? 0,
      h_allowed:     row.h_allowed      ?? 0,
      r_allowed:     row.r_allowed      ?? 0,
      er:            row.er             ?? 0,
      bb:            row.bb             ?? 0,
      so:            row.so             ?? 0,
      hr_allowed:    row.hr_allowed     ?? 0,
      era:           row.era            ? parseFloat(row.era)  : null,
      whip:          row.whip           ? parseFloat(row.whip) : null,
      raw_json:      row.raw_json       || null,
    });
  }

  if (skipped) console.log(`  ⚠ Skipped ${skipped} rows with unmapped game/team IDs`);
  await upsertBatch('pitching_lines', mapped, 'game_id,player_name,is_our_team', 'pitching lines');
}

// ── 5. Play Events ────────────────────────────────────────────────────────────

async function syncPlayEvents() {
  console.log('\n[5/7] Syncing play events...');

  const rows = sqlite.prepare('SELECT * FROM play_events ORDER BY id').all();
  console.log(`  Found ${rows.length} play events in SQLite`);

  const mapped = [];
  let skipped = 0;

  for (const row of rows) {
    const sbGameId = gameIdMap.get(row.game_id);
    const sbTeamId = teamIdMap.get(row.team_id);
    if (!sbGameId || !sbTeamId) { skipped++; continue; }

    mapped.push({
      game_id:         sbGameId,
      team_id:         sbTeamId,
      org_id:          ORG_ID,
      sequence_num:    row.sequence_num    ?? null,
      inning:          row.inning          || null,
      inning_num:      row.inning_num      ?? null,
      inning_half:     row.inning_half     || null,
      event_type:      row.event_type      || null,
      batter_name:     row.batter_name     || null,
      pitcher_name:    row.pitcher_name    || null,
      description:     row.description     || null,
      runners_on:      row.runners_on      || null,
      outs_before:     row.outs_before     ?? null,
      result_rbi:      row.result_rbi      ?? 0,
      is_scoring_play: row.is_scoring_play === 1,
    });
  }

  if (skipped) console.log(`  ⚠ Skipped ${skipped} rows with unmapped game/team IDs`);
  // play_events dedup on game_id + sequence_num
  await upsertBatch('play_events', mapped, 'game_id,sequence_num', 'play events');
}

// ── 6. Player Advanced Stats ──────────────────────────────────────────────────

async function syncPlayerAdvancedStats() {
  console.log('\n[6/7] Syncing player advanced stats...');

  const rows = sqlite.prepare('SELECT * FROM player_advanced_stats ORDER BY id').all();
  console.log(`  Found ${rows.length} player advanced stat rows in SQLite`);

  const mapped = [];
  let skipped = 0;

  for (const row of rows) {
    const sbTeamId = teamIdMap.get(row.team_id);
    if (!sbTeamId) { skipped++; continue; }

    mapped.push({
      team_id:      sbTeamId,
      org_id:       ORG_ID,
      player_name:  row.player_name,
      is_our_team:  row.is_our_team === 1,
      games:        row.games         ?? null,
      total_pitches: row.total_pitches ?? null,
      gb: row.gb ?? null, fb: row.fb ?? null, ld: row.ld ?? null,
      batted_balls: row.batted_balls  ?? null,
      gb_pct: row.gb_pct ?? null, fb_pct: row.fb_pct ?? null, ld_pct: row.ld_pct ?? null,
      spray_lf: row.spray_lf ?? null, spray_cf: row.spray_cf ?? null,
      spray_rf: row.spray_rf ?? null, spray_3b: row.spray_3b ?? null,
      spray_ss: row.spray_ss ?? null, spray_2b: row.spray_2b ?? null,
      spray_1b: row.spray_1b ?? null, spray_pc: row.spray_pc ?? null,
      spray_lf_pct: row.spray_lf_pct ?? null, spray_cf_pct: row.spray_cf_pct ?? null,
      spray_rf_pct: row.spray_rf_pct ?? null, spray_3b_pct: row.spray_3b_pct ?? null,
      spray_ss_pct: row.spray_ss_pct ?? null, spray_2b_pct: row.spray_2b_pct ?? null,
      spray_1b_pct: row.spray_1b_pct ?? null, spray_pc_pct: row.spray_pc_pct ?? null,
      risp_ab: row.risp_ab ?? null, risp_h: row.risp_h ?? null, ba_risp: row.ba_risp ?? null,
      swing_decisions: row.swing_decisions || null,
      k_pct: row.k_pct ?? null, bb_pct: row.bb_pct ?? null,
    });
  }

  if (skipped) console.log(`  ⚠ Skipped ${skipped} rows with unmapped team IDs`);
  await upsertBatch('player_advanced_stats', mapped, 'team_id,player_name,is_our_team', 'player adv stats');
}

// ── 7. Pitcher Advanced Stats ─────────────────────────────────────────────────

async function syncPitcherAdvancedStats() {
  console.log('\n[7/7] Syncing pitcher advanced stats...');

  const rows = sqlite.prepare('SELECT * FROM pitcher_advanced_stats ORDER BY id').all();
  console.log(`  Found ${rows.length} pitcher advanced stat rows in SQLite`);

  const mapped = [];
  let skipped = 0;

  for (const row of rows) {
    const sbTeamId = teamIdMap.get(row.team_id);
    if (!sbTeamId) { skipped++; continue; }

    mapped.push({
      team_id:      sbTeamId,
      org_id:       ORG_ID,
      player_name:  row.player_name,
      is_our_team:  row.is_our_team === 1,
      games:        row.games        ?? null,
      total_pitches: row.total_pitches ?? null,
      strikes:      row.strikes      ?? null,
      s_pct:        row.s_pct        ?? null,
      gb: row.gb ?? null, fb: row.fb ?? null, ld: row.ld ?? null,
      gb_pct: row.gb_pct ?? null, fb_pct: row.fb_pct ?? null, ld_pct: row.ld_pct ?? null,
      go_ao:    row.go_ao    ?? null,
      so_per7:  row.so_per7  ?? null, bb_per7:   row.bb_per7   ?? null,
      k_pct_bf: row.k_pct_bf ?? null, bb_pct_bf: row.bb_pct_bf ?? null,
      p_per_ip: row.p_per_ip ?? null,
      wp: row.wp ?? null, bk: row.bk ?? null, pik: row.pik ?? null,
    });
  }

  if (skipped) console.log(`  ⚠ Skipped ${skipped} rows with unmapped team IDs`);
  await upsertBatch('pitcher_advanced_stats', mapped, 'team_id,player_name,is_our_team', 'pitcher adv stats');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  JoBu Scout — SQLite → Supabase Sync');
  console.log('═══════════════════════════════════════════════');
  console.log(`  SQLite: ${DB_PATH}`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL}`);
  console.log('');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  if (!process.env.SYNC_ORG_ID) {
    console.error('✗ Missing SYNC_ORG_ID in .env');
    process.exit(1);
  }

  ORG_ID = process.env.SYNC_ORG_ID;
  console.log(`  Org ID: ${ORG_ID}`);

  const start = Date.now();

  try {
    await syncTeams();   // also resolves OUR_TEAM_SB_ID
    await syncGames();
    await syncBattingLines();
    await syncPitchingLines();
    await syncPlayEvents();
    await syncPlayerAdvancedStats();
    await syncPitcherAdvancedStats();
  } catch (err) {
    console.error('\n✗ Sync failed:', err.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  ✓ Sync complete in ${elapsed}s`);
  console.log('═══════════════════════════════════════════════\n');
}

main();