// Referral codes and the commission a referrer earns.
//
// The LogBase super admin makes a code for someone (a Referrer). A new business that types the code when it signs up is
// remembered as that referrer's Referral. Every time that business pays for a plan (a first payment, a plan change, a
// renewal, an automatic charge) the referrer earns their share (50% unless the admin set another rate) of what was paid.
// Plan time given by the admin for free is not a payment, so it earns nothing.

const Referrer = require('../models/Referrer');
const Referral = require('../models/Referral');
const ReferralCommission = require('../models/ReferralCommission');
const BillingPayment = require('../models/BillingPayment');
const Business = require('../models/Business');
const crypto = require('crypto');

const DEFAULT_RATE = 50;
// no 0/O or 1/I/L, so a code read out loud or from a screenshot is not mistaken
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normalizeCode(value) {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 20) : '';
}

function randomCode(length = 7) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// A code that no referrer has yet.
async function freshCode() {
  for (let i = 0; i < 20; i += 1) {
    const code = randomCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await Referrer.exists({ code }))) return code;
  }
  throw new Error('Could not make a new referral code');
}

// The active referrer with this code, or null.
async function referrerForCode(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  return Referrer.findOne({ code, isActive: true });
}

// Remembers that a business signed up with a referrer's code. Never throws: the sign-up has already worked.
async function attachReferral(businessId, referrer) {
  try {
    await Referral.create({ business: businessId, referrer: referrer._id, code: referrer.code });
  } catch (err) {
    if (!err || err.code !== 11000) console.error('Referral could not be saved:', err && err.message);
  }
}

// The commission for one paid plan payment. Safe to call more than once for the same payment (the unique index on
// `payment` stops a second one). Returns the commission, or null when the business was not referred.
async function recordCommission(payment) {
  if (!payment || payment.status !== 'success') return null;
  const referral = await Referral.findOne({ business: payment.business }).lean();
  if (!referral) return null;
  const referrer = await Referrer.findById(referral.referrer).lean();
  if (!referrer) return null;
  const business = await Business.findById(payment.business).select('name').lean();
  const rate = Number(referrer.ratePercent) > 0 ? Number(referrer.ratePercent) : DEFAULT_RATE;
  try {
    return await ReferralCommission.create({
      referrer: referrer._id,
      business: payment.business,
      businessName: business ? business.name : undefined,
      payment: payment._id,
      plan: payment.plan,
      interval: payment.interval,
      paymentAmount: payment.amount,
      ratePercent: rate,
      amount: Math.round((payment.amount * rate) / 100),
      earnedAt: payment.paidAt || new Date(),
    });
  } catch (err) {
    if (err && err.code === 11000) return null; // already recorded
    throw err;
  }
}

// Catches up on any paid payment of a referrer's businesses that has no commission yet (e.g. the server stopped right
// after a payment was confirmed). Run when the admin opens a referrer.
async function syncCommissions(referrerId) {
  const referrals = await Referral.find({ referrer: referrerId }).select('business createdAt').lean();
  if (referrals.length === 0) return 0;
  const since = new Map(referrals.map((r) => [String(r.business), r.createdAt]));
  const payments = await BillingPayment.find({ business: { $in: referrals.map((r) => r.business) }, status: 'success' }).lean();
  if (payments.length === 0) return 0;
  const done = new Set((await ReferralCommission.find({ payment: { $in: payments.map((p) => p._id) } }).select('payment').lean()).map((c) => String(c.payment)));
  let added = 0;
  for (const p of payments) {
    if (done.has(String(p._id))) continue;
    const from = since.get(String(p.business));
    if (from && new Date(p.paidAt || p.createdAt) < new Date(from)) continue; // paid before the code was used
    // eslint-disable-next-line no-await-in-loop
    if (await recordCommission(p)) added += 1;
  }
  return added;
}

module.exports = { DEFAULT_RATE, normalizeCode, freshCode, referrerForCode, attachReferral, recordCommission, syncCommissions };
