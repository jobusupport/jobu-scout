'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'src', 'generate-report.js');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const VALID_ORG_ID = '99999999-9999-4999-8999-999999999999';
const SECRET_SENTINEL = 'synthetic-service-secret-must-not-leak';

function runReport(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const key of ['JOBU_JOB_ORG_ID', 'USE_SUPABASE', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (envOverrides[key] === undefined) delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--list'], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr, output: stdout + stderr }));
  });
}

function assertBoundedConfigurationFailure(result, expected) {
  assert.notEqual(result.code, 0);
  assert.match(result.output, expected);
  assert.doesNotMatch(result.output, /supabaseUrl is required|\bat [^(\r\n]+\(|node_modules|[A-Z]:\\|\/(?:home|Users|workspace)\//i);
  assert.doesNotMatch(result.output, new RegExp(SECRET_SENTINEL));
  assert.ok(Buffer.byteLength(result.output, 'utf8') < 2000, 'expected validation output must remain bounded');
}

test('report bootstrap source validates job context and database mode before loading the database adapter', () => {
  const orgGate = SOURCE.indexOf('requireJobOrgContext()');
  const modeGate = SOURCE.indexOf('resolveDatabaseMode()');
  const dbLoad = SOURCE.indexOf("require('./db')");
  assert.ok(orgGate >= 0 && modeGate > orgGate && dbLoad > modeGate);
});

test('invalid job context wins over missing Supabase configuration with bounded diagnostics', async () => {
  const result = await runReport({
    NODE_ENV: 'production',
    USE_SUPABASE: 'true',
    SUPABASE_ANON_KEY: 'synthetic-anon',
    SUPABASE_SERVICE_ROLE_KEY: SECRET_SENTINEL,
  });
  assertBoundedConfigurationFailure(result, /JOBU_JOB_ORG_ID is required/);
});

test('valid job context reaches bounded database-mode validation before loading the adapter', async () => {
  const result = await runReport({ NODE_ENV: 'production', JOBU_JOB_ORG_ID: VALID_ORG_ID });
  assertBoundedConfigurationFailure(result, /requires USE_SUPABASE=true to be set explicitly/);
});

test('valid bootstrap ordering still reaches database initialization', () => {
  const dbLoad = SOURCE.indexOf("require('./db')");
  const dbInit = SOURCE.indexOf('db.init(DB_PATH)');
  assert.ok(dbLoad >= 0 && dbInit > dbLoad, 'the validated bootstrap must still load and initialize the adapter');
});

test('shared server modules can load in validated SQLite mode without constructing a Supabase client', async () => {
  const script = "const { adminClient } = require('./src/supabase'); if (adminClient !== null) process.exit(2);";
  const env = { ...process.env, NODE_ENV: 'test', USE_SUPABASE: 'false' };
  delete env.SUPABASE_URL;
  delete env.SUPABASE_ANON_KEY;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: REPO_ROOT, env });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /supabaseUrl is required|node_modules|[A-Z]:\\/i);
});
