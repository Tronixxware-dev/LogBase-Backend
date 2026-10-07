const crypto = require('crypto');
const BillingPayment = require('../models/BillingPayment');
const Subscription = require('../models/Subscription');
const Product = require('../models/Product');
const User = require('../models/User');
const paystack = require('../utils/paystack');
const { httpError } = require('../utils/httpError');
const { logActivity } = require('../utils/audit');
const { getSubscription, entitlementsFor, entitlements, settlePayment, PLAN_ORDER } = require('../utils/billing');
const { PLANS, PAID_PLANS, INTERVALS, TRIAL_DAYS, CURRENCY, priceOf } = require('../config/plans');

function naira(kobo) {
  return Math.round(kobo) / 100;
}

function money(kobo) {
  return `₦${naira(kobo).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// The plans as the Billing page shows them (prices in naira).
function publicPlans() {
  return PLAN_ORDER.map((key) => {
    const p = PLANS[key];
    return { key, name: p.name, tagline: p.tagline, monthly: naira(p.monthly), yearly: naira(p.yearly), limits: p.limits, features: p.features };
  });
}

function paymentView(p) {
  return {
    _id: p._id,
    reference: p.reference,
    plan: p.plan,
    interval: p.interval,
    amount: naira(p.amount),
    status: p.status,
    paidAt: p.paidAt || null,
    periodEnd: p.periodEnd || null,
    renewal: Boolean(p.renewal),
    failureReason: p.status === 'failed' ? p.failureReason || null : null,
    createdAt: p.createdAt,
  };
}

// What the Billing page shows about automatic renewal. The card token itself is never included.
function autoRenewView(sub) {
  const card = sub.card && sub.card.last4 ? { brand: sub.card.brand || null, last4: sub.card.last4, expMonth: sub.card.expMonth || null, expYear: sub.card.expYear || null, bank: sub.card.bank || null } : null;
  const active = sub.status === 'active';
  return {
    enabled: Boolean(sub.autoRenew && card && active),
    card,
    renewsOn: sub.autoRenew && active ? sub.currentPeriodEnd || null : null,
    amount: active ? naira(priceOf(sub.plan, sub.interval) || 0) : 0,
    failedAttempts: sub.renewalAttempts || 0,
    lastFailure: sub.renewalFailure || null,
  };
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

// GET /api/billing  (administrator only)
// Where the business stands: plan, trial / paid-until date, what it is using, the plans on offer, recent payments.
async function getBilling(req, res, next) {
  try {
    const sub = await getSubscription(req.businessId);
    const [stocks, staff, payments] = await Promise.all([
      Product.countDocuments({ business: req.businessId, isActive: true }),
      User.countDocuments({ business: req.businessId, role: 'staff', isActive: true }),
      BillingPayment.find({ business: req.businessId }).sort({ createdAt: -1 }).limit(10),
    ]);
    res.json({
      configured: paystack.isConfigured(),
      subscription: entitlementsFor(sub),
      autoRenew: autoRenewView(sub),
      usage: { stocks, staff },
      plans: publicPlans(),
      trialDays: TRIAL_DAYS,
      payments: payments.map(paymentView),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/billing/checkout   body: { plan: 'starter' | 'business', interval: 'monthly' | 'yearly', autoRenew?: boolean }
// Works out the price on the server (the browser's idea of the price is never used), records the attempt and
// returns the Paystack page the customer must be sent to.
async function checkout(req, res, next) {
  try {
    const plan = req.body && req.body.plan;
    const interval = req.body && req.body.interval;
    if (!PAID_PLANS.includes(plan)) throw httpError(400, 'Choose the Starter or Business plan');
    if (!INTERVALS.includes(interval)) throw httpError(400, 'Choose monthly or yearly');
    if (!paystack.isConfigured()) throw httpError(503, 'Online payments are not set up yet. Please try again later.');

    const amount = priceOf(plan, interval);

    // a lower plan cannot be bought while a higher one the business already paid for is still running
    const ent = await entitlements(req.businessId);
    if (ent.state === 'active' && PLAN_ORDER.indexOf(plan) < PLAN_ORDER.indexOf(ent.plan)) {
      throw httpError(400, `You still have ${ent.daysLeft} day${ent.daysLeft === 1 ? '' : 's'} left on the ${ent.planName} plan. You can switch to a lower plan after it ends.`);
    }

    const reference = `logbase_${crypto.randomBytes(12).toString('hex')}`;
    const payment = await BillingPayment.create({
      business: req.businessId,
      reference,
      plan,
      interval,
      amount,
      currency: CURRENCY,
      createdBy: req.user._id,
      autoRenew: req.body.autoRenew === true, // only a real "yes" counts
    });

    try {
      const init = await paystack.initializeTransaction({
        email: req.user.email,
        amount,
        reference,
        currency: CURRENCY,
        callbackUrl: `${frontendUrl()}/dashboard/billing`,
        metadata: { businessId: String(req.businessId), plan, interval, autoRenew: req.body.autoRenew === true },
      });
      res.status(201).json({ authorizationUrl: init.authorization_url, reference });
    } catch (err) {
      await BillingPayment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed' } }).catch(() => {});
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

function describe(payment) {
  return `${PLANS[payment.plan].name} plan (${payment.interval}) for ${money(payment.amount)}`;
}

// POST /api/billing/verify   body: { reference }
// Called when the customer comes back from Paystack. Asks Paystack what happened and, if it was paid, gives the plan time.
async function verify(req, res, next) {
  try {
    const reference = req.body && typeof req.body.reference === 'string' ? req.body.reference.trim() : '';
    if (!reference) throw httpError(400, 'No payment reference was given');

    // only this business's own payments
    const own = await BillingPayment.findOne({ reference, business: req.businessId });
    if (!own) throw httpError(404, 'Payment not found');

    const result = await settlePayment(reference);
    if (result.applied) {
      logActivity(req, {
        action: 'billing.payment',
        summary: `Paid for the ${describe(result.payment)}`,
        entityType: 'BillingPayment',
        entityId: result.payment._id,
        meta: { plan: result.payment.plan, interval: result.payment.interval },
      });
    }
    res.json({
      outcome: result.outcome,
      subscription: entitlementsFor(await getSubscription(req.businessId)),
      autoRenew: result.autoRenew || null, // 'on' | 'off' | 'unsupported' | null
      payment: paymentView(result.payment),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/billing/webhook   (called by Paystack, not by a person)
// The safety net for when the customer pays but never comes back to the page (closed the tab, lost network).
// Anything without a valid Paystack signature is refused.
async function webhook(req, res, next) {
  try {
    if (!paystack.isValidSignature(req.rawBody, req.headers['x-paystack-signature'])) {
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const event = req.body || {};
    const reference = event.data && event.data.reference;
    if (event.event === 'charge.success' && typeof reference === 'string') {
      try {
        const result = await settlePayment(reference);
        if (result.applied) {
          const owner = result.payment.createdBy
            ? await User.findById(result.payment.createdBy)
            : await User.findOne({ business: result.payment.business, role: 'owner', isActive: true });
          if (owner) {
            logActivity(
              { user: owner, businessId: result.payment.business },
              {
                action: result.payment.renewal ? 'billing.renewal' : 'billing.payment',
                summary: result.payment.renewal ? `The ${describe(result.payment)} was renewed automatically` : `Paid for the ${describe(result.payment)}`,
                entityType: 'BillingPayment',
                entityId: result.payment._id,
                meta: { plan: result.payment.plan, interval: result.payment.interval },
              }
            );
          }
        }
      } catch (err) {
        // a reference that is not ours is nothing to retry; any other problem makes Paystack try again later
        if (err.statusCode !== 404) return next(err);
      }
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

// PUT /api/billing/auto-renew   body: { enabled: boolean }   (administrator only)
// Turning it off always works. Turning it on needs a plan that has been paid for and a saved card
// (the card is saved when a plan is paid for with "renew automatically" ticked).
async function setAutoRenew(req, res, next) {
  try {
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== 'boolean') throw httpError(400, 'Say whether automatic renewal should be on or off');

    const sub = await getSubscription(req.businessId);
    if (enabled) {
      const withToken = await Subscription.findOne({ business: req.businessId }).select('+card.authorizationCode');
      if (!withToken || !withToken.card || !withToken.card.authorizationCode) {
        throw httpError(400, 'There is no saved card yet. Pay for a plan with a card and tick "Renew automatically".');
      }
      if (sub.status !== 'active') throw httpError(400, 'Buy a plan first. Automatic renewal keeps a paid plan going.');
    }

    const updated = await Subscription.findOneAndUpdate(
      { business: req.businessId },
      { $set: { autoRenew: enabled, renewalAttempts: 0, renewalFailure: '', nextRenewalAt: null, renewalLockUntil: null } },
      { new: true }
    );
    logActivity(req, {
      action: 'billing.auto_renew',
      summary: enabled ? 'Turned automatic renewal on' : 'Turned automatic renewal off',
    });
    res.json({ autoRenew: autoRenewView(updated), subscription: entitlementsFor(updated) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/billing/card   (administrator only) forgets the saved card and switches automatic renewal off.
async function removeCard(req, res, next) {
  try {
    await getSubscription(req.businessId);
    const updated = await Subscription.findOneAndUpdate(
      { business: req.businessId },
      {
        $set: { autoRenew: false, renewalAttempts: 0, renewalFailure: '', nextRenewalAt: null, renewalLockUntil: null },
        $unset: { card: 1 },
      },
      { new: true }
    );
    logActivity(req, { action: 'billing.card_removed', summary: 'Removed the saved card and turned automatic renewal off' });
    res.json({ autoRenew: autoRenewView(updated) });
  } catch (err) {
    next(err);
  }
}

module.exports = { getBilling, checkout, verify, webhook, publicPlans, setAutoRenew, removeCard };
