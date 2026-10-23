const mongoose = require('mongoose');

// Someone the LogBase super admin gave a referral code to. They earn a share of every plan payment made by the
// businesses that sign up with their code. They do not need a LogBase login: the admin tracks what they earned and
// marks it paid when the money has been sent to them.
const referrerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    // the code a new business types when it signs up (capital letters and digits, e.g. "TRX7K2QM")
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    // the share of each payment they earn. It is copied onto each commission when it is earned, so changing it
    // later never changes what was already earned.
    ratePercent: { type: Number, default: 50, min: 1, max: 100 },
    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Referrer', referrerSchema);
