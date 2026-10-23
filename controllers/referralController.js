// What a referrer sees in their own LogBase account: their code, the businesses they referred and what they earned.
// A referrer is a person the LogBase super admin gave a code to and linked to this account (see adminReferralController).
// Only their own numbers are returned, and nothing about the referred businesses beyond name, sign-up date and plan.

const Referrer = require('../models/Referrer');
const { detail } = require('./adminReferralController');

// GET /api/referral/me   ->   { referrer: null }  or  { referrer, referred, commissions, payouts }
async function myReferrals(req, res, next) {
  try {
    const mine = await Referrer.findOne({ user: req.user._id }).select('_id').lean();
    if (!mine) return res.json({ referrer: null });
    const full = await detail(mine._id);
    const { name, code, ratePercent, isActive, referred: referredCount, paying, earned, owed, paid, payments, createdAt } = full.referrer;
    res.json({
      referrer: { name, code, ratePercent, isActive, referred: referredCount, paying, earned, owed, paid, payments, createdAt },
      // no emails, no admin notes
      referred: full.referred.map((r) => ({ _id: r._id, name: r.name, signedUpAt: r.signedUpAt, plan: r.plan, earned: r.earned })),
      commissions: full.commissions.map((c) => ({ _id: c._id, businessName: c.businessName, plan: c.plan, interval: c.interval, paymentAmount: c.paymentAmount, ratePercent: c.ratePercent, amount: c.amount, status: c.status, earnedAt: c.earnedAt, paidAt: c.paidAt })),
      payouts: full.payouts.map((p) => ({ _id: p._id, amount: p.amount, note: p.note, createdAt: p.createdAt })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { myReferrals };
