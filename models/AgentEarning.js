const mongoose = require('mongoose');

// One line in a Sales Agent's earnings ledger. Amounts are in kobo (like BillingPayment); a correction can be negative.
//   new_shop    the bonus for a shop that paid AND got going (see utils/agents.js, ACTIVATION)
//   renewal     the agent's % of a later payment made by one of their shops
//   weekly      the weekly activity bonus (credited by the admin after checking the week)
//   milestone   the monthly milestone bonus (35 or 50 new activated shops)
//   adjustment  a manual correction by the admin (e.g. a refunded shop's bonus taken back)
// `uniqueKey` stops the same thing ever being credited twice, even if two requests run at the same moment.
const agentEarningSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'Referrer', required: true, index: true },
    type: { type: String, enum: ['new_shop', 'renewal', 'weekly', 'milestone', 'adjustment'], required: true },
    amount: { type: Number, required: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
    businessName: { type: String, trim: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingPayment' },
    plan: { type: String },
    paymentAmount: { type: Number },
    ratePercent: { type: Number },
    // 'YYYY-MM-DD' of the Monday for a weekly bonus, 'YYYY-MM' for a milestone
    period: { type: String },
    note: { type: String, trim: true, maxlength: 200 },
    uniqueKey: { type: String, unique: true, sparse: true },
    // owed: not paid out yet.  paid: included in a payout.
    status: { type: String, enum: ['owed', 'paid'], default: 'owed', index: true },
    payout: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPayout' },
    paidAt: { type: Date },
    earnedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

agentEarningSchema.index({ agent: 1, earnedAt: -1 });
agentEarningSchema.index({ type: 1, earnedAt: -1 });

module.exports = mongoose.model('AgentEarning', agentEarningSchema);
