'use strict';
// Issues a real session for an EXISTING user via Supabase's magic-link
// verification flow, without ever reading or changing their password.
// Prints a JSON blob matching the app's localStorage 'vs_auth' shape.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const email = process.argv[2];
  if (!email) { console.error('Usage: node scripts/test-magic-session.js <email>'); process.exit(1); }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const anon  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkError) { console.error('generateLink failed:', linkError.message); process.exit(1); }

  const hashedToken = linkData.properties?.hashed_token;
  if (!hashedToken) { console.error('No hashed_token in generateLink response'); process.exit(1); }

  const { data: verifyData, error: verifyError } = await anon.auth.verifyOtp({
    type: 'magiclink', token_hash: hashedToken,
  });
  if (verifyError) { console.error('verifyOtp failed:', verifyError.message); process.exit(1); }

  console.log(JSON.stringify({
    ok: true,
    accessToken: verifyData.session.access_token,
    refreshToken: verifyData.session.refresh_token,
    expiresAt: verifyData.session.expires_at,
    user: { id: verifyData.user.id, email: verifyData.user.email },
  }));
}

main();
