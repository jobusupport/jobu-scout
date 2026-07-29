'use strict';

// A minimal, IN-MEMORY, STATEFUL fake of the subset of the Supabase
// query-builder surface src/high-school-import-repository.js actually
// uses (.from/.insert/.update/.select/.eq/.is/.single/.maybeSingle).
//
// ── Honest fidelity statement ─────────────────────────────────────────────
// This fake approximates, and does NOT claim to exactly reproduce, live
// PostgreSQL/PostgREST behavior. What it DOES model, deliberately and
// specifically because these are the properties this slice's own tests
// depend on: the migration's unique constraints (including
// partial/predicated ones, matched exactly against
// supabase/migrations/20260728220000_create_high_school_import_domain.sql),
// UUID-typed columns (rejecting non-UUID-shaped values the way a real uuid
// column would), and NOT NULL columns for the eight new tables, all
// surfaced as Postgres-shaped errors (code '23505' for a unique violation,
// code '23502' for a NOT NULL violation, code '22P02' for an invalid UUID)
// on the same table/column list the migration actually declares.
//
// What it explicitly does NOT model: composite foreign-key referential
// integrity ACROSS tables (e.g. that a team_id used here must actually
// exist as a row in hs_teams for the same org_id), CHECK-constraint enum
// validation, JSONB serialization edge cases, or genuine multi-statement
// transactional atomicity. Those properties were independently verified
// against a REAL, disposable Postgres 17 instance during this schema's own
// review (see PR #15's review) -- this fake's job is orchestration,
// idempotency, and uniqueness-semantics testing at the application layer,
// not a substitute for that live-database verification.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UUID-typed and NOT NULL columns per table, transcribed directly from the
// migration's own column definitions (not re-derived or approximated).
const TABLE_SCHEMA = {
  hs_games: {
    uuidColumns: ['org_id', 'program_id', 'team_id', 'season_id'],
    requiredColumns: ['org_id', 'program_id', 'team_id'],
  },
  hs_import_runs: {
    uuidColumns: ['org_id', 'program_id', 'team_id', 'season_id'],
    requiredColumns: ['org_id', 'program_id', 'team_id', 'source_provider', 'trigger_kind', 'status'],
  },
  hs_import_run_games: {
    uuidColumns: ['org_id', 'import_run_id', 'hs_game_id'],
    requiredColumns: ['org_id', 'import_run_id', 'source_game_ref', 'discovery_status'],
  },
  hs_raw_snapshots: {
    uuidColumns: ['org_id', 'import_run_id', 'import_run_game_id', 'hs_game_id'],
    requiredColumns: ['org_id', 'import_run_id', 'snapshot_kind', 'source_provider'],
  },
  hs_game_validation_results: {
    uuidColumns: ['org_id', 'import_run_id', 'import_run_game_id', 'hs_game_id', 'team_id'],
    requiredColumns: ['org_id', 'import_run_id', 'hs_game_id', 'team_id'],
  },
  hs_verified_totals: {
    uuidColumns: ['org_id', 'program_id', 'team_id', 'season_id', 'import_run_id'],
    requiredColumns: ['org_id', 'program_id', 'team_id', 'season_id'],
  },
  hs_player_advanced_stats: {
    uuidColumns: ['org_id', 'program_id', 'team_id', 'season_id', 'player_id', 'import_run_id'],
    requiredColumns: ['org_id', 'program_id', 'team_id', 'season_id', 'player_id'],
  },
  hs_pitcher_advanced_stats: {
    uuidColumns: ['org_id', 'program_id', 'team_id', 'season_id', 'player_id', 'import_run_id'],
    requiredColumns: ['org_id', 'program_id', 'team_id', 'season_id', 'player_id'],
  },
};

function notNullViolation(column) {
  return { code: '23502', message: `null value in column "${column}" violates not-null constraint` };
}

function invalidUuidError(column) {
  return { code: '22P02', message: `invalid input syntax for type uuid: column "${column}"` };
}

// Returns a Postgres-shaped error for the first schema violation found on
// an about-to-be-inserted row, or null if the row is schema-valid.
function findSchemaViolation(table, row) {
  const schema = TABLE_SCHEMA[table];
  if (!schema) return null;
  for (const column of schema.requiredColumns) {
    if (row[column] === undefined || row[column] === null) return notNullViolation(column);
  }
  for (const column of schema.uuidColumns) {
    const value = row[column];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !UUID_RE.test(value)) return invalidUuidError(column);
  }
  return null;
}

// Auto-generated primary keys are valid UUID-SHAPED strings (matching
// production's uuid_generate_v4() column default) rather than an opaque
// "fake-id-N" placeholder -- every hs_* table's id is a real uuid column,
// and a child row referencing a parent's id through a uuid-typed foreign
// key column (e.g. hs_import_run_games.import_run_id) must be able to
// pass THIS SAME fake's own UUID-format enforcement, the same way a real
// parent id always would.
let idCounter = 0;
function nextId() {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
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

    const schemaViolation = findSchemaViolation(this.table, row);
    if (schemaViolation) return { data: null, error: schemaViolation };

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
    // Test-only escape hatch: mutates a row IN PLACE, bypassing every
    // constraint this fake otherwise enforces -- used exclusively to
    // simulate a CONCURRENT publisher's write landing between two steps of
    // this repository's own multi-call sequences (see the
    // publishCurrentRow concurrency tests), which a single-threaded JS test
    // cannot otherwise produce.
    __mutateRow(table, id, patch) {
      const row = (state.tables.get(table) || []).find((r) => r.id === id);
      if (!row) throw new Error(`__mutateRow: no row ${id} in ${table}`);
      Object.assign(row, patch);
    },
    __reset() {
      state.tables.clear();
      touchedTables.clear();
    },
  };
  return client;
}

module.exports = { createFakeSupabaseClient };
