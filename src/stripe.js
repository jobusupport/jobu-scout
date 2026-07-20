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

// Applied to organizations.max_* columns whenever a plan change lands via
// webhook. Orgs with a manually-set override (e.g. an internal/house
// account) are untouched unless they go through a real Stripe plan change.
const PLAN_LIMITS = {
  free:         { maxOpponentTeams: 2,  maxReportsPerMonth: 1,  maxSelfScoutReportsPerMonth: 1,  maxMatchupReportsPerMonth: 1 },
  coach:        { maxOpponentTeams: 10, maxReportsPerMonth: 15, maxSelfScoutReportsPerMonth: 5,  maxMatchupReportsPerMonth: 5 },
  organization: { maxOpponentTeams: 30, maxReportsPerMonth: 45, maxSelfScoutReportsPerMonth: 15, maxMatchupReportsPerMonth: 15 },
};

function limitsColumnsForTier(tier) {
  const limits = PLAN_LIMITS[tier] || PLAN_LIMITS.free;
  return {
    max_opponent_teams: limits.maxOpponentTeams,
    max_reports_per_month: limits.maxReportsPerMonth,
    max_self_scout_reports_per_month: limits.maxSelfScoutReportsPerMonth,
    max_matchup_reports_per_month: limits.maxMatchupReportsPerMonth,
  };
}

module.exports = { stripe, priceIdFor, tierForPriceId, PRICE_IDS, PLAN_LIMITS, limitsColumnsForTier };
