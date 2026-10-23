const mongoose = require('mongoose');

// What a referrer earned from ONE plan payment of a business they referred. Amounts are in kobo (like BillingPayment).
// A payment can only ever earn one commission (the unique index on `payment`), so a payment seen twice never pays twice.
const referralCommissionSchema = new mongoose.Schema(
  {
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'Referrer', required: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    businessName: { type: String, trim: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingPayment', required: true, unique: true },
    plan: { type: String },
    interval: { type: String },
    paymentAmount: { type: Number, required: true, min: 0 },
    ratePercent: { type: Number, required: true },
    amount: { type: Number, required: true, min: 0 },
    // owed: not paid out yet.  paid: included in a payout.
    status: { type: String, enum: ['owed', 'paid'], default: 'owed', index: true },
    payout: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPayout' },
    paidAt: { type: Date },
    earnedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

referralCommissionSchema.index({ referrer: 1, earnedAt: -1 });

module.exports = mongoose.model('ReferralCommission', referralCommissionSchema);
