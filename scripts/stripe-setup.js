'use strict';
// One-time setup: creates the Stripe Products/Prices used by the billing
// integration (idempotent — safe to re-run, matches on lookup_key).
require('dotenv').config();
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is not set in .env');
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = [
  {
    tier: 'coach',
    productName: 'Jobu Scout — Coach Plan',
    prices: [
      { lookup_key: 'coach_monthly', unit_amount: 4900, interval: 'month' },
      { lookup_key: 'coach_yearly', unit_amount: 49000, interval: 'year' },
    ],
  },
  {
    tier: 'organization',
    productName: 'Jobu Scout — Organization Plan',
    prices: [
      { lookup_key: 'org_monthly', unit_amount: 19900, interval: 'month' },
      { lookup_key: 'org_yearly', unit_amount: 199000, interval: 'year' },
    ],
  },
];

async function findProductByName(name) {
  const list = await stripe.products.list({ limit: 100 });
  return list.data.find(p => p.name === name) || null;
}

async function findPriceByLookupKey(lookupKey) {
  const list = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  return list.data[0] || null;
}

async function main() {
  const result = {};
  for (const plan of PLANS) {
    let product = await findProductByName(plan.productName);
    if (!product) {
      product = await stripe.products.create({
        name: plan.productName,
        metadata: { plan_tier: plan.tier },
      });
      console.log(`Created product ${product.id} (${plan.productName})`);
    } else {
      console.log(`Found existing product ${product.id} (${plan.productName})`);
    }

    for (const p of plan.prices) {
      let price = await findPriceByLookupKey(p.lookup_key);
      if (!price) {
        price = await stripe.prices.create({
          product: product.id,
          currency: 'usd',
          unit_amount: p.unit_amount,
          recurring: { interval: p.interval },
          lookup_key: p.lookup_key,
          metadata: { plan_tier: plan.tier },
        });
        console.log(`  Created price ${price.id} (${p.lookup_key})`);
      } else {
        console.log(`  Found existing price ${price.id} (${p.lookup_key})`);
      }
      result[p.lookup_key] = price.id;
    }
  }

  console.log('\n--- Add these to .env ---');
  console.log(`STRIPE_PRICE_COACH_MONTHLY=${result.coach_monthly}`);
  console.log(`STRIPE_PRICE_COACH_YEARLY=${result.coach_yearly}`);
  console.log(`STRIPE_PRICE_ORG_MONTHLY=${result.org_monthly}`);
  console.log(`STRIPE_PRICE_ORG_YEARLY=${result.org_yearly}`);
}

main().catch(err => {
  console.error('Stripe setup failed:', err.message);
  if (err.raw) console.error(err.raw);
  process.exit(1);
});
