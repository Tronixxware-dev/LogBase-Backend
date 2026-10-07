// What each business may do, and how payments turn into plan time. The rules live here so the controllers,
// the limit checks and the tests all use the same code.

const Subscription = require('../models/Subscription');
const BillingPayment = require('../models/BillingPayment');
const Product = require('../models/Product');
const User = require('../models/User');
const paystack = require('./paystack');
const { httpError } = require('./httpError');
const { PLANS, PLAN_ORDER, TRIAL_PLAN, TRIAL_DAYS } = require('../config/plans');

const DAY = 24 * 60 * 60 * 1000;

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * DAY);
}

// Calendar months, and a 31st that does not exist in the target month becomes that month's last day.
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}

function periodMonths(interval) {
  return interval === 'yearly' ? 12 : 1;
}

// The business's subscription. A business that has none yet (new, or from before billing existed)
// starts its free trial now.
async function getSubscription(businessId, now = new Date()) {
  const found = await Subscription.findOne({ business: businessId });
  if (found) return found;
  try {
    return await Subscription.findOneAndUpdate(
      { business: businessId },
      {
        $setOnInsert: {
          business: businessId,
          status: 'trialing',
          plan: TRIAL_PLAN,
          interval: 'monthly',
          trialEndsAt: addDays(now, TRIAL_DAYS),
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err && err.code === 11000) return Subscription.findOne({ business: businessId }); // created a moment ago by another request
    throw err;
  }
}

// What the business gets right now:
//   state 'active'      paid, period not over
//   state 'trialing'    free trial not over (Business features)
//   state 'expired'     paid period is over -> Free
//   state 'trial_ended' trial is over and nothing was paid -> Free
function entitlementsFor(sub, now = new Date()) {
  const t = now.getTime();
  let plan = 'free';
  let state = 'trial_ended';

  if (sub.status === 'active' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() > t) {
    plan = sub.plan;
    state = 'active';
  } else if (sub.status === 'trialing' && sub.trialEndsAt && new Date(sub.trialEndsAt).getTime() > t) {
    plan = TRIAL_PLAN;
    state = 'trialing';
  } else if (sub.status === 'active') {
    state = 'expired';
  }

  const def = PLANS[plan];
  const end = state === 'active' ? sub.currentPeriodEnd : state === 'trialing' ? sub.trialEndsAt : null;
  return {
    plan,
    planName: def.name,
    state,
    limits: def.limits,
    features: def.features,
    interval: sub.interval,
    trialEndsAt: sub.trialEndsAt || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    endsAt: end,
    daysLeft: end ? Math.max(0, Math.ceil((new Date(end).getTime() - t) / DAY)) : 0,
    // what the business last paid for, even when that has run out (shown as "was on Starter")
    lastPaidPlan: sub.status === 'active' ? sub.plan : null,
  };
}

async function entitlements(businessId, now = new Date()) {
  return entitlementsFor(await getSubscription(businessId, now), now);
}

// ---- limits -------------------------------------------------------------------------------------------------
// Limits only stop NEW things being added. Whatever a business already has is never taken away or hidden.

async function assertCanAddStock(businessId) {
  const ent = await entitlements(businessId);
  const limit = ent.limits.stocks;
  if (limit == null) return;
  const count = await Product.countDocuments({ business: businessId, isActive: true });
  if (count >= limit) {
    throw httpError(402, `Your ${ent.planName} plan allows up to ${limit} stocks. Upgrade your plan on the Billing page to add more.`);
  }
}

async function assertCanAddStaff(businessId) {
  const ent = await entitlements(businessId);
  const limit = ent.limits.staff;
  if (limit == null) return;
  if (limit === 0) {
    throw httpError(402, `The ${ent.planName} plan does not include staff accounts. Upgrade your plan on the Billing page to add staff.`);
  }
  const count = await User.countDocuments({ business: businessId, role: 'staff', isActive: true });
  if (count >= limit) {
    throw httpError(402, `Your ${ent.planName} plan allows up to ${limit} staff. Upgrade your plan on the Billing page to add more.`);
  }
}

// Express middleware: lets the request through only when the plan includes the feature.
function requireFeature(feature, label) {
  return async (req, res, next) => {
    try {
      const ent = await entitlements(req.businessId);
      if (!ent.features[feature]) {
        throw httpError(402, `${label} is part of the Business plan. Upgrade on the Billing page to use it.`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---- payments -----------------------------------------------------------------------------------------------

// Works out the new subscription numbers for a payment that has been confirmed.
// Paying again for the SAME plan while it is still running adds the time on the end; anything else
// (first payment, plan change, running out) starts a fresh period today.
function nextPeriod(sub, payment, now = new Date()) {
  const running = sub.status === 'active' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() > now.getTime();
  const start = running && sub.plan === payment.plan ? new Date(sub.currentPeriodEnd) : now;
  return { start, end: addMonths(start, periodMonths(payment.interval)) };
}

async function applyPayment(payment, now = new Date()) {
  const sub = await getSubscription(payment.business, now);
  const { start, end } = nextPeriod(sub, payment, now);
  const updated = await Subscription.findOneAndUpdate(
    { business: payment.business },
    { $set: { status: 'active', plan: payment.plan, interval: payment.interval, currentPeriodEnd: end, lastPaymentAt: now } },
    { new: true }
  );
  await BillingPayment.updateOne({ _id: payment._id }, { $set: { periodStart: start, periodEnd: end } });
  return updated;
}

// After a payment is applied: look after automatic renewal.
//  - an automatic charge that worked: clear the failure count (nothing else changes; the person may have switched it off meanwhile)
//  - a payment where the person asked for automatic renewal: keep the card Paystack gives back, if it can be charged again
//  - a payment where they did not ask: switch it off
// Returns 'on', 'unsupported' (they asked, but this payment method cannot be charged again, e.g. a bank transfer),
// 'off', or null (nothing to report).
async function rememberCard(payment, tx) {
  const reset = { renewalAttempts: 0, renewalFailure: '', nextRenewalAt: null, renewalLockUntil: null };
  if (payment.renewal) {
    await Subscription.updateOne({ business: payment.business }, { $set: reset });
    return null;
  }
  if (!payment.autoRenew) {
    await Subscription.updateOne({ business: payment.business }, { $set: { autoRenew: false, ...reset } });
    return 'off';
  }
  const a = tx && tx.authorization;
  if (!a || a.reusable !== true || typeof a.authorization_code !== 'string' || !a.authorization_code) {
    await Subscription.updateOne({ business: payment.business }, { $set: { autoRenew: false, ...reset } });
    return 'unsupported';
  }
  const email = (tx.customer && tx.customer.email) || null;
  await Subscription.updateOne(
    { business: payment.business },
    {
      $set: {
        autoRenew: true,
        ...reset,
        card: {
          authorizationCode: a.authorization_code,
          email,
          brand: String(a.card_type || '').trim().toLowerCase() || null,
          last4: a.last4 ? String(a.last4) : null,
          expMonth: a.exp_month ? String(a.exp_month) : null,
          expYear: a.exp_year ? String(a.exp_year) : null,
          bank: a.bank ? String(a.bank) : null,
          savedAt: new Date(),
        },
      },
    }
  );
  return 'on';
}

// Confirms a payment with Paystack and, if it is good, gives the business its plan time. Safe to call any
// number of times for the same reference (the browser coming back AND the webhook both call it):
// only the first call that finds it still "pending" applies it.
async function settlePayment(reference, now = new Date()) {
  const payment = await BillingPayment.findOne({ reference });
  if (!payment) throw httpError(404, 'Payment not found');
  if (payment.status === 'success') return { payment, applied: false, outcome: 'success' };
  if (payment.status === 'flagged') return { payment, applied: false, outcome: 'flagged' };

  const tx = await paystack.verifyTransaction(reference);

  if (!tx || tx.status !== 'success') {
    if (tx && tx.status === 'failed') {
      await BillingPayment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed' } });
      return { payment, applied: false, outcome: 'failed' };
    }
    return { payment, applied: false, outcome: 'pending' }; // not paid (yet)
  }

  // Paystack says paid. It must be the amount and currency WE asked for, for this reference.
  if (tx.reference !== payment.reference || Number(tx.amount) !== payment.amount || tx.currency !== payment.currency) {
    await BillingPayment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'flagged' } });
    return { payment, applied: false, outcome: 'flagged' };
  }

  // (a payment we gave up on as "failed" is claimable too: if Paystack really did take the money, the plan time is owed)
  const claimed = await BillingPayment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ['pending', 'failed'] } },
    { $set: { status: 'success', paidAt: now, gatewayId: tx.id, channel: tx.channel } },
    { new: true }
  );
  if (!claimed) {
    // someone else applied it between our read and now
    return { payment: await BillingPayment.findOne({ reference }), applied: false, outcome: 'success' };
  }

  try {
    const subscription = await applyPayment(claimed, now);
    const cardState = await rememberCard(claimed, tx).catch(() => null); // a card that could not be saved never undoes a payment
    return { payment: claimed, subscription, applied: true, outcome: 'success', autoRenew: cardState };
  } catch (err) {
    // the plan time was not added, so the payment must not stay marked as done: the next verify / webhook retries it
    await BillingPayment.updateOne({ _id: claimed._id }, { $set: { status: payment.status === 'failed' ? 'failed' : 'pending' } }).catch(() => {});
    throw err;
  }
}

module.exports = {
  addDays,
  addMonths,
  getSubscription,
  entitlementsFor,
  entitlements,
  assertCanAddStock,
  assertCanAddStaff,
  requireFeature,
  nextPeriod,
  settlePayment,
  PLAN_ORDER,
};
