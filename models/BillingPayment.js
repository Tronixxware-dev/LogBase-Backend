const mongoose = require('mongoose');

// One attempt to pay for a plan through Paystack. It is created by OUR server before the customer is sent to
// Paystack, with the amount WE calculated from config/plans.js. A payment only counts once Paystack confirms
// the same reference, the same amount and the same currency.
const billingPaymentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    reference: { type: String, required: true, unique: true },
    plan: { type: String, enum: ['starter', 'business'], required: true },
    interval: { type: String, enum: ['monthly', 'yearly'], required: true },
    amount: { type: Number, required: true, min: 1 }, // kobo
    currency: { type: String, default: 'NGN' },
    // pending: waiting for payment. success: paid and applied. failed: Paystack said it failed.
    // flagged: Paystack's amount or currency did not match ours (never applied; needs a look).
    status: { type: String, enum: ['pending', 'success', 'failed', 'flagged'], default: 'pending' },
    paidAt: { type: Date },
    gatewayId: { type: Number },
    channel: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // autoRenew: the person asked for automatic renewal when they paid (so the card is saved once it is confirmed)
    // renewal:   this was an automatic charge made by the renewal job, not a payment the person made on Paystack
    autoRenew: { type: Boolean, default: false },
    renewal: { type: Boolean, default: false },
    failureReason: { type: String },
    // the period this payment bought (filled in when it is applied)
    periodStart: { type: Date },
    periodEnd: { type: Date },
  },
  { timestamps: true }
);

billingPaymentSchema.index({ business: 1, createdAt: -1 });

module.exports = mongoose.model('BillingPayment', billingPaymentSchema);
