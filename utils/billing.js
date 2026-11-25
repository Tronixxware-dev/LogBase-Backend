// What each business may do, and how payments turn into plan time. The rules live here so the controllers,
// the limit checks and the tests all use the same code.

const mongoose = require('mongoose');
const Subscription = require('../models/Subscription');
const BillingPayment = require('../models/BillingPayment');
const Product = require('../models/Product');
const User = require('../models/User');
const Business = require('../models/Business');
const LaundryOrder = require('../models/LaundryOrder');
const TailorOrder = require('../models/TailorOrder');
const paystack = require('./paystack');
const { recordCommission } = require('./referrals');
const { httpError } = require('./httpError');
const { PLANS, PLAN_ORDER, PAID_PLANS, PREVIEW_UNITS, PREVIEW_ORDERS, TRIAL_PLAN, TRIAL_DAYS, NO_TRIAL_FROM, LAUNDRY_TRIAL_ORDERS, FREE_MONTHLY_ORDERS } = require('../config/plans');

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

// There is no free trial any more: a business created on or after NO_TRIAL_FROM starts on the Free plan.
// (An older business with no subscription record yet still gets the trial it was promised.)
function startsOnFree(business) {
  return Boolean(business && business.createdAt) && new Date(business.createdAt).getTime() >= NO_TRIAL_FROM.getTime();
}

// The business's subscription. A business that has none yet is created now: on the Free plan if it is new, or with the
// trial it was promised if it signed up before trials were removed.
// (The Free plan is stored the same way the administrator's "Move to Free plan" stores it: a trial that has already ended.)
async function getSubscription(businessId, now = new Date()) {
  const found = await Subscription.findOne({ business: businessId });
  if (found) return found;
  const business = await Business.findById(businessId).select('createdAt').lean();
  const free = startsOnFree(business);
  try {
    return await Subscription.findOneAndUpdate(
      { business: businessId },
      {
        $setOnInsert: {
          business: businessId,
          status: 'trialing',
          plan: free ? 'free' : TRIAL_PLAN,
          interval: 'monthly',
          trialEndsAt: free ? new Date(business.createdAt) : addDays(now, TRIAL_DAYS),
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err && err.code === 11000) return Subscription.findOne({ business: businessId }); // created a moment ago by another request
    throw err;
  }
}

// The kinds of business whose free trial is also counted in orders (they hold no stock to count): a laundromat counts laundry
// orders and a tailor counts tailor orders. Each keeps a counter on the Business.
const ORDER_COUNTER_FIELDS = { laundromat: 'laundryCounter', tailor: 'tailorCounter' };
// what the trial counts, in the words the app uses ("You have taken 20 of 50 laundry orders")
const ORDER_NOUNS = { laundromat: 'laundry orders', tailor: 'tailoring orders' };
const ORDER_COUNTER_SELECT = ['businessType', ...Object.values(ORDER_COUNTER_FIELDS)].join(' ');

// The orders each of those kinds counts, to work out its free orders in a month
const ORDER_MODELS = { laundromat: LaundryOrder, tailor: TailorOrder };

// The first moment of the current calendar month in Nigeria (West Africa Time, UTC+1 all year).
function monthStart(now = new Date()) {
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  return new Date(Date.UTC(wat.getUTCFullYear(), wat.getUTCMonth(), 1) - 60 * 60 * 1000);
}

// How many orders a laundromat or tailor has taken so far this month (0 for any other business).
async function ordersThisMonth(business, now = new Date()) {
  const Model = business && ORDER_MODELS[business.businessType];
  if (!Model) return 0;
  return Model.countDocuments({ business: business._id, createdAt: { $gte: monthStart(now) } });
}

// Returns { orders, orderLimit, monthOrders } for a laundromat or tailor, and undefined for every other business.
// orders / orderLimit are for a trial it already had (a counter that only ever goes up, so deleting an order never gives an order back).
// monthOrders (when given) is how many orders it took this month, which is what the Free plan limits (FREE_MONTHLY_ORDERS).
// `business` needs businessType and its counter.
function orderUsage(business, sub, monthOrders) {
  const field = business && ORDER_COUNTER_FIELDS[business.businessType];
  if (!field) return undefined;
  const limit = sub && Number(sub.trialOrderLimit) > 0 ? Number(sub.trialOrderLimit) : LAUNDRY_TRIAL_ORDERS;
  return {
    orders: Number(business[field]) || 0,
    orderLimit: limit,
    monthOrders: Number.isFinite(monthOrders) ? monthOrders : undefined,
    noun: ORDER_NOUNS[business.businessType],
  };
}

// What the business gets right now:
//   state 'active'      paid, period not over
//   state 'trialing'    free trial not over (Business features)
//   state 'expired'     paid period is over -> Free
//   state 'trial_ended' nothing is paid and no trial is running -> the Free plan (every new business is here; it is also where a
//                       trial that ran out lands; trialEndedBy says whether the days or the orders ran out)
// `usage` (from orderUsage) is only given for a laundromat or tailor business; with it a trial also ends at orderLimit orders,
// and the Free plan allows FREE_MONTHLY_ORDERS orders a month (usage.monthOrders says how many it has taken).
function entitlementsFor(sub, now = new Date(), usage) {
  const t = now.getTime();
  let plan = 'free';
  let state = 'trial_ended';
  let trialEndedBy = null;

  const trialDaysLeft = sub.status === 'trialing' && sub.trialEndsAt && new Date(sub.trialEndsAt).getTime() > t;
  const trialOrdersUsedUp = Boolean(usage) && usage.orders >= usage.orderLimit;

  if (sub.status === 'active' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() > t) {
    plan = sub.plan;
    state = 'active';
  } else if (trialDaysLeft && !trialOrdersUsedUp) {
    plan = TRIAL_PLAN;
    state = 'trialing';
  } else if (sub.status === 'active') {
    state = 'expired';
  } else if (trialDaysLeft && trialOrdersUsedUp) {
    trialEndedBy = 'orders';
  } else {
    trialEndedBy = 'days';
  }

  const def = PLANS[plan];
  // "Try it first": picked Starter or Business when signing up and has never paid. Until then only a few units (or orders) fit.
  const preview = plan === 'free' && state === 'trial_ended' && !sub.lastPaymentAt && PAID_PLANS.includes(sub.chosenPlan);
  const limits = preview ? { ...def.limits, stocks: PREVIEW_UNITS } : def.limits;
  const end = state === 'active' ? sub.currentPeriodEnd : state === 'trialing' ? sub.trialEndsAt : null;
  // a laundromat or tailor on the Free plan (or whose paid plan ran out) may take a limited number of orders each month
  const freeTier = state !== 'active' && state !== 'trialing';
  const monthOrders = usage && Number.isFinite(usage.monthOrders) ? usage.monthOrders : null;
  return {
    plan,
    planName: def.name,
    state,
    limits,
    features: def.features,
    // set only during the preview: the plan the business picked and how much it may try before paying
    preview: preview
      ? { plan: sub.chosenPlan, planName: PLANS[sub.chosenPlan].name, interval: sub.chosenInterval || 'monthly', units: PREVIEW_UNITS, orders: PREVIEW_ORDERS }
      : null,
    interval: sub.interval,
    trialEndsAt: sub.trialEndsAt || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    endsAt: end,
    daysLeft: end ? Math.max(0, Math.ceil((new Date(end).getTime() - t) / DAY)) : 0,
    // what the business last paid for, even when that has run out (shown as "was on Starter")
    lastPaidPlan: sub.status === 'active' ? sub.plan : null,
    // laundromats and tailors only: how many orders the trial allows and how many have been taken (null for every other business)
    trialEndedBy,
    trialOrders: usage && sub.status === 'trialing' && !preview ? { used: usage.orders, limit: usage.orderLimit } : null,
    // what the orders are called for this business ("laundry orders", "tailoring orders"); null for every other business
    orderNoun: usage ? usage.noun || 'orders' : null,
    // laundromats and tailors only: on the Free plan, how many orders were taken this month and how many the month allows
    freeOrders: usage && freeTier ? (preview ? { used: usage.orders, limit: PREVIEW_ORDERS } : { used: monthOrders === null ? 0 : monthOrders, limit: FREE_MONTHLY_ORDERS }) : null,
    // laundromats and tailors only: true when new orders are refused (the month's free orders are used up on the Free plan)
    ordersBlocked: Boolean(usage) && freeTier && (preview ? usage.orders >= PREVIEW_ORDERS : monthOrders !== null && monthOrders >= FREE_MONTHLY_ORDERS),
  };
}

// The same as entitlementsFor, but looks up whether the business counts its trial in orders and counts them.
async function describeSubscription(sub, now = new Date()) {
  let usage;
  const paidAndRunning = sub.status === 'active' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() > now.getTime();
  if (!paidAndRunning) {
    const business = await Business.findById(sub.business).select(ORDER_COUNTER_SELECT).lean();
    usage = orderUsage(business, sub, await ordersThisMonth(business, now));
  }
  return entitlementsFor(sub, now, usage);
}

async function entitlements(businessId, now = new Date()) {
  return describeSubscription(await getSubscription(businessId, now), now);
}

// ---- limits -------------------------------------------------------------------------------------------------
// Limits only stop NEW things being added. Whatever a business already has is never taken away or hidden.

// How many units the business holds right now: every unit of every active product, in every colour / size and every store.
// (A product's own quantity is already the business-wide total, and for a product with colours / sizes the sum of them.)
async function unitsInStock(businessId) {
  const rows = await Product.aggregate([
    { $match: { business: new mongoose.Types.ObjectId(String(businessId)), isActive: true } },
    { $group: { _id: null, units: { $sum: '$quantity' } } },
  ]);
  return Math.round((rows.length > 0 ? Number(rows[0].units) || 0 : 0) * 100) / 100;
}

const unitsText = (n) => Number(Math.round(n * 100) / 100).toLocaleString('en-US');

// Called before anything that PUTS MORE UNITS ON THE SHELF (a new product with opening stock, a file import, a purchase,
// an upward stock change, an archived product coming back, a colour / size given more stock). `adding` is how many units
// it would add; it must not take the business past what its plan holds. Selling, returns, transfers between stores and
// anything that lowers or keeps the stock are never stopped.
async function assertRoomForUnits(businessId, adding) {
  const extra = Number(adding);
  if (!(extra > 0)) return;
  const ent = await entitlements(businessId);
  const limit = ent.limits.stocks;
  if (limit == null) return;
  const used = await unitsInStock(businessId);
  if (used + extra <= limit) return;
  if (ent.preview) {
    // the free test is used up: the plan they picked has to be paid for
    throw httpError(402, `You have used your ${unitsText(limit)}-unit test. Pay for the ${ent.preview.planName} plan you chose on mylogbase.com to add more stock. Everything you added stays here and selling still works.`);
  }
  const holds = `Your ${ent.planName} plan holds up to ${unitsText(limit)} units in stock`;
  const tail = 'Upgrade your plan on the Billing page to add more stock.';
  if (used >= limit) {
    throw httpError(402, `${holds} and you have ${unitsText(used)}. ${tail} Selling stock makes room again.`);
  }
  throw httpError(402, `${holds}. You have ${unitsText(used)}, so you can add ${unitsText(limit - used)} more, not ${unitsText(extra)}. ${tail}`);
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

// Called before a NEW laundry order or tailor order is taken. Such a business takes orders without limit while a paid plan runs
// (or a trial it already had). On the Free plan, or after a paid plan has ended, it may take FREE_MONTHLY_ORDERS orders in each
// calendar month; after that it must upgrade (or wait for next month). Orders already taken are never touched, and other kinds
// of business are never stopped by this.
async function assertCanAddOrder(businessId) {
  const business = await Business.findById(businessId).select(ORDER_COUNTER_SELECT).lean();
  if (!business || !ORDER_COUNTER_FIELDS[business.businessType]) return;
  const sub = await getSubscription(businessId);
  const now = new Date();
  const ent = entitlementsFor(sub, now, orderUsage(business, sub));
  if (ent.state === 'active' || ent.state === 'trialing') return;
  if (ent.preview) {
    if (ent.freeOrders.used < PREVIEW_ORDERS) return;
    throw httpError(402, `You have used your ${PREVIEW_ORDERS}-order test. Pay for the ${ent.preview.planName} plan you chose on mylogbase.com to take more orders. Your existing orders stay here and you can keep working on them.`);
  }
  const used = await ordersThisMonth(business, now);
  if (used < FREE_MONTHLY_ORDERS) return;
  const keep = 'Your existing orders stay here and you can keep working on them.';
  const taken = `you have taken ${used} of the ${FREE_MONTHLY_ORDERS} orders it allows each month`;
  if (ent.state === 'expired') {
    throw httpError(402, `Your ${PLANS[sub.plan] ? PLANS[sub.plan].name : 'paid'} plan has ended, and the Free plan is limited: ${taken}. Renew or choose a plan on the Billing page to take more orders. ${keep}`);
  }
  throw httpError(402, `On the Free plan ${taken}. Choose a plan on the Billing page to take more orders now, or wait for next month. ${keep}`);
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
    // the referrer of this business (if any) earns their share; this can never undo the payment either
    await recordCommission(claimed).catch((err) => console.error('Referral commission failed:', err.message));
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
  describeSubscription,
  startsOnFree,
  ordersThisMonth,
  orderUsage,
  assertCanAddOrder,
  entitlements,
  assertRoomForUnits,
  unitsInStock,
  assertCanAddStaff,
  requireFeature,
  nextPeriod,
  settlePayment,
  PLAN_ORDER,
};
