// Automatic renewal. Once an hour (and only on the server that runs the app) this looks for paid plans whose
// owner asked for automatic renewal and whose period ends within a day, and charges the saved card.
//
// Safety rules:
//  * The amount is always worked out here from config/plans.js, never taken from anywhere else.
//  * A business is "locked" for a few minutes while it is being charged, so two runs can never charge it twice.
//  * A charge that is still in progress is checked again (never charged a second time) until it settles.
//  * A charge that fails is tried again the next day, up to 3 times in all; then automatic renewal is switched off
//    and the owner is told. The plan simply ends on its date if nothing works: nothing is taken away early.
//  * Money only counts once Paystack confirms the same reference, amount and currency (settlePayment does that).

const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const BillingPayment = require('../models/BillingPayment');
const User = require('../models/User');
const paystack = require('./paystack');
const mailer = require('./mailer');
const { settlePayment, addDays } = require('./billing');
const { logActivity } = require('./audit');
const { PLANS, CURRENCY, priceOf } = require('../config/plans');

const RENEW_AHEAD_DAYS = 1; // charge this long before the period ends, so there is no gap
const MAX_ATTEMPTS = 3;
const RETRY_HOURS = 24;
const LOCK_MINUTES = 15;
const STUCK_HOURS = 6; // a charge still undecided after this long counts as failed

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function shortReason(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 120) : 'The card was declined';
}

// Emails never stop a renewal: if the mail service is off or fails, nothing else changes.
function tell(owner, build) {
  try {
    if (!owner || !owner.email || !mailer.isConfigured()) return Promise.resolve();
    const message = build();
    return Promise.resolve(mailer.sendEmail({ to: owner.email, ...message })).catch((err) => {
      console.error('Renewal email failed:', err.message);
    });
  } catch (err) {
    console.error('Renewal email failed:', err.message);
    return Promise.resolve();
  }
}

async function ownerOf(businessId) {
  return User.findOne({ business: businessId, role: 'owner', isActive: true });
}

// The charge did not work (declined, or Paystack refused it). Counts a failure and decides what happens next.
async function recordFailure(sub, payment, reason, now) {
  if (payment) {
    await BillingPayment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed', failureReason: reason } }).catch(() => {});
  }
  const attempts = (sub.renewalAttempts || 0) + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await Subscription.updateOne(
    { _id: sub._id },
    {
      $set: {
        renewalAttempts: attempts,
        renewalFailure: reason,
        renewalLockUntil: null,
        nextRenewalAt: giveUp ? null : new Date(now.getTime() + RETRY_HOURS * HOUR),
        ...(giveUp ? { autoRenew: false } : {}),
      },
    }
  );
  const owner = await ownerOf(sub.business);
  const plan = PLANS[sub.plan];
  if (owner) {
    logActivity(
      { user: owner, businessId: sub.business },
      {
        action: 'billing.renewal_failed',
        summary: `Automatic renewal of the ${plan.name} plan failed (${reason})${giveUp ? '; automatic renewal was switched off' : ''}`,
        meta: { attempts },
      }
    );
    tell(owner, () =>
      mailer.renewalFailedEmail({
        name: owner.name,
        planName: plan.name,
        amount: (priceOf(sub.plan, sub.interval) || 0) / 100,
        reason,
        willRetry: !giveUp,
        link: `${frontendUrl()}/dashboard/billing`,
      })
    );
  }
  return giveUp ? 'gave_up' : 'failed';
}

async function afterSuccess(sub, payment) {
  const fresh = await Subscription.findOne({ business: sub.business });
  const owner = await ownerOf(sub.business);
  const plan = PLANS[payment.plan];
  if (owner) {
    logActivity(
      { user: owner, businessId: sub.business },
      {
        action: 'billing.renewal',
        summary: `The ${plan.name} plan (${payment.interval}) was renewed automatically for ₦${(payment.amount / 100).toLocaleString('en-NG')}`,
        entityType: 'BillingPayment',
        entityId: payment._id,
        meta: { plan: payment.plan, interval: payment.interval },
      }
    );
    tell(owner, () =>
      mailer.renewalSucceededEmail({
        name: owner.name,
        planName: plan.name,
        amount: payment.amount / 100,
        until: (fresh && fresh.currentPeriodEnd) || payment.periodEnd || new Date(),
        cardLast4: sub.card && sub.card.last4,
      })
    );
  }
}

// Renews one business if it is due. Returns what happened: 'renewed', 'failed', 'gave_up', 'pending', 'skipped'.
async function renewOne(subscriptionId, now = new Date()) {
  // 1. take the lock; if someone else holds it, or the business is no longer eligible, do nothing
  const claim = await Subscription.updateOne(
    {
      _id: subscriptionId,
      autoRenew: true,
      status: 'active',
      $or: [{ renewalLockUntil: null }, { renewalLockUntil: { $lte: now } }],
    },
    { $set: { renewalLockUntil: new Date(now.getTime() + LOCK_MINUTES * MINUTE) } }
  );
  if (!claim || !claim.modifiedCount) return 'skipped';

  try {
    const sub = await Subscription.findOne({ _id: subscriptionId }).select('+card.authorizationCode');
    if (!sub) return 'skipped';

    // 2. is it really due?
    const ahead = addDays(now, RENEW_AHEAD_DAYS);
    if (!sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > ahead) {
      await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
      return 'skipped';
    }
    if (sub.nextRenewalAt && new Date(sub.nextRenewalAt) > now) {
      await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
      return 'skipped';
    }

    // 3. a charge started earlier that is still undecided: look at it, never charge again on top of it
    const open = await BillingPayment.findOne({ business: sub.business, renewal: true, status: 'pending' });
    if (open) {
      const result = await settlePayment(open.reference, now);
      if (result.outcome === 'success') {
        await afterSuccess(sub, result.payment);
        await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
        return 'renewed';
      }
      if (result.outcome === 'failed') return recordFailure(sub, null, 'The card was declined', now);
      const age = now.getTime() - new Date(open.createdAt || now).getTime();
      if (age < STUCK_HOURS * HOUR) {
        await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
        return 'pending';
      }
      return recordFailure(sub, open, 'The bank did not confirm the payment', now); // (if the money turns up later, the webhook still gives the plan time)
    }

    // 4. the saved card
    const code = sub.card && sub.card.authorizationCode;
    const amount = priceOf(sub.plan, sub.interval);
    if (!code || !amount) {
      await Subscription.updateOne({ _id: sub._id }, { $set: { autoRenew: false, renewalLockUntil: null, renewalFailure: 'No saved card' } });
      return 'skipped';
    }
    const owner = await ownerOf(sub.business);
    const email = sub.card.email || (owner && owner.email);
    if (!email) return recordFailure(sub, null, 'No email address for the card', now);

    // 5. charge it
    const reference = `logbase_renew_${crypto.randomBytes(12).toString('hex')}`;
    const payment = await BillingPayment.create({
      business: sub.business,
      reference,
      plan: sub.plan,
      interval: sub.interval,
      amount,
      currency: CURRENCY,
      autoRenew: true,
      renewal: true,
    });

    let tx;
    try {
      tx = await paystack.chargeAuthorization({
        authorizationCode: code,
        email,
        amount,
        reference,
        currency: CURRENCY,
        metadata: { businessId: String(sub.business), plan: sub.plan, interval: sub.interval, renewal: true },
      });
    } catch (err) {
      if (err.statusCode === 502 || err.statusCode === 503) {
        // Paystack could not be reached: nothing was charged, so this is not the card's fault. Try again at the next run.
        await BillingPayment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed', failureReason: 'Paystack could not be reached' } }).catch(() => {});
        await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
        return 'skipped';
      }
      return recordFailure(sub, payment, shortReason(err.message), now);
    }

    if (tx && tx.status === 'success') {
      const result = await settlePayment(reference, now);
      if (result.outcome === 'success') {
        await afterSuccess(sub, result.payment);
        await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
        return 'renewed';
      }
      return recordFailure(sub, payment, 'The payment could not be confirmed', now);
    }
    if (tx && tx.status === 'failed') return recordFailure(sub, payment, shortReason(tx.gateway_response), now);

    // still in progress (some banks take a moment): the webhook or the next run settles it
    await Subscription.updateOne({ _id: sub._id }, { $set: { renewalLockUntil: null } });
    return 'pending';
  } catch (err) {
    await Subscription.updateOne({ _id: subscriptionId }, { $set: { renewalLockUntil: null } }).catch(() => {});
    throw err;
  }
}

// One pass over everything that is due. Never throws: one business's trouble must not stop the others.
async function runRenewals(now = new Date()) {
  const summary = { checked: 0, renewed: 0, failed: 0, gave_up: 0, pending: 0, skipped: 0, errors: 0 };
  const due = await Subscription.find({
    status: 'active',
    autoRenew: true,
    currentPeriodEnd: { $lte: addDays(now, RENEW_AHEAD_DAYS) },
  });
  for (const sub of due) {
    summary.checked += 1;
    try {
      const outcome = await renewOne(sub._id, now);
      summary[outcome] = (summary[outcome] || 0) + 1;
    } catch (err) {
      summary.errors += 1;
      console.error('Renewal error:', err.message);
    }
  }
  return summary;
}

let timer = null;
let running = false;

// Starts the hourly job. Set AUTO_RENEWAL_JOB=off in .env to switch it off (for example on a second server).
function startRenewalScheduler() {
  if (timer || String(process.env.AUTO_RENEWAL_JOB || '').toLowerCase() === 'off') return null;
  const tick = async () => {
    if (running || !paystack.isConfigured()) return;
    running = true;
    try {
      const s = await runRenewals();
      if (s.checked > 0) console.log('Auto-renewal run:', JSON.stringify(s));
    } catch (err) {
      console.error('Auto-renewal run failed:', err.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, HOUR);
  if (timer.unref) timer.unref();
  const first = setTimeout(tick, MINUTE);
  if (first.unref) first.unref();
  return timer;
}

function stopRenewalScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { renewOne, runRenewals, startRenewalScheduler, stopRenewalScheduler, MAX_ATTEMPTS, RENEW_AHEAD_DAYS };
