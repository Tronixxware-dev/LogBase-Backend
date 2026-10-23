const mongoose = require('mongoose');

// A record that the admin paid a referrer what they were owed. Written once and never edited.
const referralPayoutSchema = new mongoose.Schema(
  {
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'Referrer', required: true, index: true },
    amount: { type: Number, required: true, min: 0 }, // kobo
    commissions: { type: Number, default: 0 }, // how many commissions it covered
    note: { type: String, trim: true, maxlength: 200 },
    paidByEmail: { type: String, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('ReferralPayout', referralPayoutSchema);
