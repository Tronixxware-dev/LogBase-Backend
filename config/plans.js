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
    monthly: 100000, // ₦1,000
    yearly: 1000000, // ₦10,000 (two months free)
    limits: { staff: 3, stocks: 300 },
    features: { activityLog: false },
  },
  business: {
    key: 'business',
    name: 'Business',
    tagline: 'For a growing business',
    monthly: 300000, // ₦3,000
    yearly: 3000000, // ₦30,000 (two months free)
    limits: { staff: null, stocks: null },
    features: { activityLog: true },
  },
};

// FOR TESTING PAYMENTS ONLY: set PAYSTACK_TEST_PRICES=on in the server's environment and Starter costs
// N100 a month (N1,000 a year) and Business N200 a month (N2,000 a year). Remove the variable (or set it to
// anything else) and the real prices above are back. Nothing else needs to change.
const TEST_PRICES = process.env.PAYSTACK_TEST_PRICES === 'on';
if (TEST_PRICES) {
  PLANS.starter.monthly = 10000; // N100
  PLANS.starter.yearly = 100000; // N1,000
  PLANS.business.monthly = 20000; // N200
  PLANS.business.yearly = 200000; // N2,000
  console.warn('WARNING: PAYSTACK_TEST_PRICES is on. Customers are being charged test prices (N100 / N200).');
}

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