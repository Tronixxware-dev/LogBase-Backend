// The plans LogBase sells. Change prices and limits HERE and nowhere else: the server reads them for
// every payment and every limit check, and the Billing page gets them from the server.
//
// Prices are in kobo (1 naira = 100 kobo), which is what Paystack wants.
// A limit of null means "no limit".
const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    tagline: 'To try LogBase with a small shop',
    monthly: 0,
    yearly: 0,
    limits: { staff: 0, stocks: 50 },
    features: { activityLog: false },
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    tagline: 'For a shop with a few helpers',
    monthly: 500000, // ₦5,000
    yearly: 5000000, // ₦50,000 (two months free)
    limits: { staff: 3, stocks: 500 },
    features: { activityLog: false },
  },
  business: {
    key: 'business',
    name: 'Business',
    tagline: 'For a growing business',
    monthly: 1500000, // ₦15,000
    yearly: 15000000, // ₦150,000 (two months free)
    limits: { staff: null, stocks: null },
    features: { activityLog: true },
  },
};

const PLAN_ORDER = ['free', 'starter', 'business'];
const PAID_PLANS = ['starter', 'business'];
const INTERVALS = ['monthly', 'yearly'];

// Every new business (and every business that existed before billing) starts with this plan for this long.
const TRIAL_PLAN = 'business';
const TRIAL_DAYS = 14;

const CURRENCY = 'NGN';

function priceOf(plan, interval) {
  const p = PLANS[plan];
  if (!p || !INTERVALS.includes(interval)) return null;
  return p[interval];
}

module.exports = { PLANS, PLAN_ORDER, PAID_PLANS, INTERVALS, TRIAL_PLAN, TRIAL_DAYS, CURRENCY, priceOf };
