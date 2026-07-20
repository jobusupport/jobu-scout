'use strict';
// One-time setup: registers the production (or any public URL) webhook
// endpoint with Stripe and prints the signing secret to save as
// STRIPE_WEBHOOK_SECRET. Idempotent — updates the existing endpoint for this
// URL instead of duplicating it if re-run.
require('dotenv').config();
const Stripe = require('stripe');

const targetUrl = process.argv[2];
if (!targetUrl) {
  console.error('Usage: node scripts/stripe-webhook-setup.js <webhook-url>');
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is not set in .env');
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];

async function main() {
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  let endpoint = existing.data.find(e => e.url === targetUrl);

  if (endpoint) {
    endpoint = await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: EVENTS });
    console.log(`Updated existing webhook endpoint ${endpoint.id} -> ${targetUrl}`);
    console.log('\nNOTE: the signing secret is only shown once, at creation time.');
    console.log('If you do not already have STRIPE_WEBHOOK_SECRET saved, delete this');
    console.log('endpoint in the Stripe Dashboard and re-run this script to get a fresh one.');
    return;
  }

  endpoint = await stripe.webhookEndpoints.create({
    url: targetUrl,
    enabled_events: EVENTS,
    description: 'Jobu Scout subscription billing',
  });
  console.log(`Created webhook endpoint ${endpoint.id} -> ${targetUrl}`);
  console.log('\n--- Add this to .env / Railway env vars ---');
  console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
}

main().catch(err => {
  console.error('Webhook setup failed:', err.message);
  if (err.raw) console.error(err.raw);
  process.exit(1);
});
