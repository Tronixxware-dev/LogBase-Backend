const mongoose = require('mongoose');

// A business that signed up with a referral code. A business can only be referred once (its first sign-up).
const referralSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'Referrer', required: true, index: true },
    code: { type: String, required: true },
    // Sales Agents: has this business's New Shop Bonus been settled? 'earned' = it got going in time and the bonus was credited,
    // 'missed' = the 14 days passed without it getting going. Empty = still waiting (or not paid yet).
    agentResolved: { type: String, enum: ['earned', 'missed'] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('Referral', referralSchema);
