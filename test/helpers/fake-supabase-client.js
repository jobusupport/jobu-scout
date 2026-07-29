'use strict';

// A minimal, IN-MEMORY, STATEFUL fake of the subset of the Supabase
// query-builder surface src/high-school-import-repository.js actually
// uses (.from/.insert/.update/.select/.eq/.is/.single/.maybeSingle),
// enforcing REAL unique-constraint behavior (including partial/predicated
// uniqueness) and returning Postgres-shaped errors (code '23505' on
// conflict) exactly like the live PostgREST API does.
//
// This is deliberately NOT a general-purpose Supabase mock -- it only
// implements the exact call shapes the repository module makes, which is
// why it's safe to keep this small rather than pulling in a heavier
// mocking library. Per this slice's own testing requirement ("simple
// one-line mocks are insufficient for idempotency and lifecycle tests"),
// this fake is what lets the REAL repository module (not a hand-written
// stand-in) be exercised in both repository-level and service-level tests
// with zero network access -- see fake-high-school-import-repository.js's
// header for why a service test can just do
// createHighSchoolImportRepository(createFakeSupabaseClient()) rather than
// maintaining a second, parallel fake repository implementation.

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `fake-id-${idCounter}`;
}

// Column-level unique constraints per table, each optionally predicated
// (mirrors the migration's own partial unique indexes exactly).
const UNIQUE_CONSTRAINTS = {
  hs_import_run_games: [
    { columns: ['import_run_id', 'source_game_ref'] },
    { columns: ['import_run_id', 'hs_game_id'], predicate: (row) => row.hs_game_id != null },
  ],
  hs_raw_snapshots: [
    { columns: ['import_run_game_id', 'snapshot_kind', 'captured_at'], predicate: (row) => row.import_run_game_id != null },
    { columns: ['import_run_id', 'snapshot_kind', 'captured_at'], predicate: (row) => row.import_run_game_id == null },
  ],
  hs_games: [
    { columns: ['team_id', 'source_game_ref'], predicate: (row) => row.source_game_ref != null },
  ],
  hs_game_validation_results: [
    { columns: ['import_run_id', 'hs_game_id'] },
  ],
  hs_verified_totals: [
    { columns: ['team_id', 'season_id'], predicate: (row) => row.is_current === true },
  ],
  hs_player_advanced_stats: [
    { columns: ['player_id', 'team_id', 'season_id'], predicate: (row) => row.is_current === true },
  ],
  hs_pitcher_advanced_stats: [
    { columns: ['player_id', 'team_id', 'season_id'], predicate: (row) => row.is_current === true },
  ],
};

const TABLES_WITH_UPDATED_AT = new Set([
  'hs_games', 'hs_import_runs', 'hs_import_run_games',
  'hs_verified_totals', 'hs_player_advanced_stats', 'hs_pitcher_advanced_stats',
]);

function conflictError() {
  return { code: '23505', message: 'duplicate key value violates unique constraint' };
}

function matchesConstraint(constraint, a, b) {
  if (constraint.predicate && (!constraint.predicate(a) || !constraint.predicate(b))) return false;
  return constraint.columns.every((col) => a[col] === b[col]);
}

function findConflict(state, table, candidateRow, excludeId) {
  const constraints = UNIQUE_CONSTRAINTS[table] || [];
  const rows = state.tables.get(table) || [];
  for (const constraint of constraints) {
    for (const existing of rows) {
      if (existing.id === excludeId) continue;
      if (matchesConstraint(constraint, existing, candidateRow)) return existing;
    }
  }
  return null;
}

class FakeQueryBuilder {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.filters = [];
    this.operation = null; // 'insert' | 'update' | 'select'
    this.payload = null;
    this.singleMode = null; // 'single' | 'maybeSingle' | null
  }

  insert(row) {
    this.operation = 'insert';
    this.payload = row;
    return this;
  }

  update(patch) {
    this.operation = 'update';
    this.payload = patch;
    return this;
  }

  select() {
    if (!this.operation) this.operation = 'select';
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ type: 'is', column, value });
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  _rows() {
    return this.state.tables.get(this.table) || [];
  }

  // Returns a SHALLOW COPY, never the live internal reference -- a real
  // PostgREST response is a JSON snapshot, not a handle into the server's
  // memory. Without this, a row object returned from one call could be
  // silently mutated later by an unrelated .update() call on the same
  // table (exactly the kind of aliasing bug a real client can never have).
  static snapshot(row) {
    return row ? { ...row } : row;
  }

  _matches(row) {
    return this.filters.every((f) => {
      if (f.type === 'is') return f.value === null ? row[f.column] == null : row[f.column] === f.value;
      return row[f.column] === f.value;
    });
  }

  _execute() {
    if (this.operation === 'insert') return this._executeInsert();
    if (this.operation === 'update') return this._executeUpdate();
    return this._executeSelect();
  }

  _executeInsert() {
    const now = new Date().toISOString();
    const row = { id: this.payload.id || nextId(), created_at: this.payload.created_at || now, ...this.payload };
    if (TABLES_WITH_UPDATED_AT.has(this.table) && !row.updated_at) row.updated_at = now;

    const conflict = findConflict(this.state, this.table, row, null);
    if (conflict) return { data: null, error: conflictError() };

    if (!this.state.tables.has(this.table)) this.state.tables.set(this.table, []);
    this.state.tables.get(this.table).push(row);

    if (this.singleMode) return { data: FakeQueryBuilder.snapshot(row), error: null };
    return { data: [FakeQueryBuilder.snapshot(row)], error: null };
  }

  _executeUpdate() {
    const rows = this._rows().filter((r) => this._matches(r));
    for (const row of rows) {
      const candidate = { ...row, ...this.payload };
      const conflict = findConflict(this.state, this.table, candidate, row.id);
      if (conflict) return { data: null, error: conflictError() };
    }
    const now = new Date().toISOString();
    for (const row of rows) {
      Object.assign(row, this.payload);
      if (TABLES_WITH_UPDATED_AT.has(this.table)) row.updated_at = now;
    }

    if (this.singleMode === 'single') {
      if (rows.length === 0) return { data: null, error: { message: 'no rows found for update' } };
      return { data: FakeQueryBuilder.snapshot(rows[0]), error: null };
    }
    if (this.singleMode === 'maybeSingle') {
      return { data: FakeQueryBuilder.snapshot(rows[0]) || null, error: null };
    }
    return { data: rows.map(FakeQueryBuilder.snapshot), error: null };
  }

  _executeSelect() {
    const rows = this._rows().filter((r) => this._matches(r));
    if (this.singleMode === 'single') {
      if (rows.length !== 1) return { data: null, error: { message: `expected exactly one row, got ${rows.length}` } };
      return { data: FakeQueryBuilder.snapshot(rows[0]), error: null };
    }
    if (this.singleMode === 'maybeSingle') {
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows returned for maybeSingle' } };
      return { data: FakeQueryBuilder.snapshot(rows[0]) || null, error: null };
    }
    return { data: rows.map(FakeQueryBuilder.snapshot), error: null };
  }

  then(onFulfilled, onRejected) {
    return Promise.resolve(this._execute()).then(onFulfilled, onRejected);
  }
}

function createFakeSupabaseClient() {
  const state = { tables: new Map() };
  const touchedTables = new Set();
  const client = {
    from(table) {
      touchedTables.add(table);
      return new FakeQueryBuilder(state, table);
    },
    __touchedTables: touchedTables,
    __getRows(table) {
      return (state.tables.get(table) || []).map((r) => ({ ...r }));
    },
    __reset() {
      state.tables.clear();
      touchedTables.clear();
    },
  };
  return client;
}

module.exports = { createFakeSupabaseClient };
