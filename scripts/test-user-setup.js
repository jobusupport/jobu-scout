'use strict';
// Creates (or tears down) a throwaway Supabase auth user for browser-driven
// checkout testing, linked to the given org as admin.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const mode = process.argv[2]; // 'create' | 'teardown'
const orgId = process.argv[3];

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env');
  process.exit(1);
}
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function create() {
  if (!orgId) { console.error('Usage: node scripts/test-user-setup.js create <org_id>'); process.exit(1); }
  const email = `claude-test+${Date.now()}@jobuscout.com`;
  const password = 'Test-' + Math.random().toString(36).slice(2, 10) + '-QA1!';

  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) { console.error('createUser failed:', error.message); process.exit(1); }

  const { error: memberErr } = await admin.from('org_members').insert({
    org_id: orgId, user_id: data.user.id, role: 'admin', accepted_at: new Date().toISOString(),
  });
  if (memberErr) { console.error('org_members insert failed:', memberErr.message); process.exit(1); }

  console.log('--- Test user created ---');
  console.log('user_id:', data.user.id);
  console.log('email:', email);
  console.log('password:', password);
}

async function teardown() {
  const userId = process.argv[3];
  if (!userId) { console.error('Usage: node scripts/test-user-setup.js teardown <user_id>'); process.exit(1); }
  await admin.from('org_members').delete().eq('user_id', userId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) { console.error('deleteUser failed:', error.message); process.exit(1); }
  console.log('Test user and membership deleted:', userId);
}

if (mode === 'create') create();
else if (mode === 'teardown') teardown();
else { console.error('Usage: node scripts/test-user-setup.js <create|teardown> <org_id|user_id>'); process.exit(1); }
