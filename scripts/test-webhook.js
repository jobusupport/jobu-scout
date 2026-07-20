'use strict';
// Fires a self-signed synthetic Stripe event at the local webhook endpoint,
// bypassing the need for `stripe listen`. Only exercises event.type branches
// that don't call back out to the Stripe API (subscription.updated/deleted,
// invoice.payment_failed) — checkout.session.completed needs a real
// subscription and is better verified via an actual browser checkout.
require('dotenv').config();
const crypto = require('crypto');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3333';
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
if (!SECRET) {
  console.error('STRIPE_WEBHOOK_SECRET is not set in .env');
  process.exit(1);
}

function signAndSend(eventObj) {
  const payload = JSON.stringify(eventObj);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto.createHmac('sha256', SECRET).update(signedPayload).digest('hex');
  const header = `t=${timestamp},v1=${signature}`;

  return fetch(`${BASE_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  });
}

async function run() {
  const orgId = process.argv[2];
  const priceId = process.argv[3];
  if (!orgId || !priceId) {
    console.error('Usage: node scripts/test-webhook.js <org_id> <coach_price_id>');
    process.exit(1);
  }

  const subId = `sub_test_${Date.now()}`;
  const custId = `cus_test_${Date.now()}`;
  const updatedEvent = {
    id: `evt_test_updated_${Date.now()}`,
    type: 'customer.subscription.updated',
    data: { object: {
      id: subId,
      customer: custId,
      status: 'active',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      metadata: { org_id: orgId },
      items: { data: [{ price: { id: priceId } }] },
    } },
  };

  console.log('\n[1] customer.subscription.updated (org should move to coach/active)');
  let res = await signAndSend(updatedEvent);
  console.log('  status:', res.status, await res.text());

  console.log('\n[2] replay same event.id (Stripe retry simulation — should dedupe, not double-apply)');
  res = await signAndSend(updatedEvent);
  console.log('  status:', res.status, await res.text());

  console.log('\n[3] invoice.payment_failed (org should flag past_due)');
  res = await signAndSend({
    id: `evt_test_invoice_failed_${Date.now()}`,
    type: 'invoice.payment_failed',
    data: { object: { customer: custId } },
  });
  console.log('  status:', res.status, await res.text());

  console.log('\n[4] bad signature (should be rejected with 400)');
  res = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=deadbeef' },
    body: JSON.stringify({ id: 'evt_bad', type: 'customer.subscription.updated', data: { object: {} } }),
  });
  console.log('  status:', res.status, await res.text());

  console.log('\n[5] customer.subscription.deleted (org should revert to free/canceled)');
  res = await signAndSend({
    id: `evt_test_deleted_${Date.now()}`,
    type: 'customer.subscription.deleted',
    data: { object: {
      id: subId,
      customer: custId,
      metadata: { org_id: orgId },
    } },
  });
  console.log('  status:', res.status, await res.text());
}

run().catch(err => { console.error(err); process.exit(1); });
