'use strict';

const { createClient } = require('@supabase/supabase-js');

// Admin client — bypasses RLS. Used server-side only for scraper writes.
// NEVER send this key to the browser.
const adminClient = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// Build a user-scoped client from a JWT.
// RLS applies — users only see their own org's data.
function userClient(jwt) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } }
  );
}

module.exports = { adminClient, userClient };
