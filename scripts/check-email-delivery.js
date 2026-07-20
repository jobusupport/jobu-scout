'use strict';
// Live check: triggers a real password-reset email and reports whether
// Supabase's mailer actually accepted it. With no custom SMTP configured,
// Supabase's default mailer only delivers to addresses that are members of
// the Supabase organization's team — everything else fails with
// "Email address not authorized". This surfaces that immediately instead of
// relying on the app's forgot-password endpoint, which always returns 200
// to real end users regardless (that's correct behavior for them; this
// script is for verifying delivery, not the user-facing flow).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const email = process.argv[2];
  if (!email) { console.error('Usage: node scripts/check-email-delivery.js <email>'); process.exit(1); }

  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { error } = await anon.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.APP_URL || 'http://localhost:3333'}/?reset=1`,
  });

  if (error) {
    console.log(`FAIL — ${email}: ${error.message}`);
    if (/not authorized/i.test(error.message)) {
      console.log('\nThis means no custom SMTP is configured: the default Supabase mailer only');
      console.log('delivers to addresses that are members of your Supabase org team. Real');
      console.log('customers will never receive reset emails until custom SMTP is set up:');
      console.log('https://supabase.com/docs/guides/auth/auth-smtp');
    }
    process.exit(1);
  }

  console.log(`OK — Supabase accepted the send request for ${email}.`);
  console.log('Note: acceptance is not proof of inbox delivery — check the actual inbox (and spam folder).');
}

main();
