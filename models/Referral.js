const mongoose = require('mongoose');

// A business that signed up with a referral code. A business can only be referred once (its first sign-up).
const referralSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'Referrer', required: true, index: true },
    code: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('Referral', referralSchema);
