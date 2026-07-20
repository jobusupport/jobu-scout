'use strict';
const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const PRICE_IDS = {
  coach: {
    month: process.env.STRIPE_PRICE_COACH_MONTHLY,
    year:  process.env.STRIPE_PRICE_COACH_YEARLY,
  },
  organization: {
    month: process.env.STRIPE_PRICE_ORG_MONTHLY,
    year:  process.env.STRIPE_PRICE_ORG_YEARLY,
  },
};

function priceIdFor(tier, interval) {
  return PRICE_IDS[tier]?.[interval] || null;
}

function tierForPriceId(priceId) {
  for (const [tier, intervals] of Object.entries(PRICE_IDS)) {
    if (Object.values(intervals).includes(priceId)) return tier;
  }
  return null;
}

module.exports = { stripe, priceIdFor, tierForPriceId, PRICE_IDS };
