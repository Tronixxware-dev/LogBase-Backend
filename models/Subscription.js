const mongoose = require('mongoose');

// One per business: which plan it is on and until when. What a business may do right now is worked out from
// these dates (utils/billing.js), so nothing has to run at midnight to "expire" anything.
const subscriptionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
    // 'trialing': on the free trial (until trialEndsAt). 'active': has paid (until currentPeriodEnd).
    status: { type: String, enum: ['trialing', 'active'], default: 'trialing' },
    plan: { type: String, enum: ['free', 'starter', 'business'], default: 'business' },
    interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    trialEndsAt: { type: Date },
    currentPeriodEnd: { type: Date },
    lastPaymentAt: { type: Date },

    // Automatic renewal. The business ticks "renew automatically" when it pays with a card; Paystack then gives us a
    // token for that card (never the card number). The hourly job in utils/renewals.js uses it to pay for the next
    // period shortly before the current one ends. The token can charge the card, so it is never sent to the browser
    // (select: false) and is only read by the renewal job.
    autoRenew: { type: Boolean, default: false },
    card: {
      authorizationCode: { type: String, select: false },
      email: { type: String }, // Paystack wants the same email the card was saved with
      brand: { type: String },
      last4: { type: String },
      expMonth: { type: String },
      expYear: { type: String },
      bank: { type: String },
      savedAt: { type: Date },
    },
    // renewal bookkeeping: how many charges in a row failed, why, when to try again, and a short lock so two
    // runs of the job never charge the same business at the same time
    renewalAttempts: { type: Number, default: 0 },
    renewalFailure: { type: String },
    nextRenewalAt: { type: Date },
    renewalLockUntil: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Subscription', subscriptionSchema);
