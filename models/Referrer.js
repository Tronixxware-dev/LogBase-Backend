const mongoose = require('mongoose');

// Someone the LogBase super admin gave a referral code to. They earn a share of every plan payment made by the
// businesses that sign up with their code. The admin tracks what they earned and marks it paid when the money has been sent to them.
// A referrer who has a LogBase account can be linked to it (`user`) and then sees their own code, referrals and earnings there.
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
    // the LogBase account this referrer signs in with to see their own numbers (the admin links it; optional)
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // set when the admin unlinks the login on purpose: it is then never linked again on its own (by email)
    noAutoLink: { type: Boolean, default: false },
    notes: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Referrer', referrerSchema);
