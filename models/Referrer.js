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
    // 'partner' (or empty): the 50% referral program. 'agent': a Sales Agent, paid by the plan in utils/agents.js
    // (a New Shop Bonus, a % of renewals, weekly and monthly bonuses) instead of a share of every payment.
    kind: { type: String, enum: ['partner', 'agent'], default: 'partner', index: true },
    // Sales Agents: the e-mail invitation ("your application is accepted"). Only a fingerprint (sha256) of the link's token is kept.
    inviteHash: { type: String, index: true },
    inviteExpiresAt: { type: Date },
    invitedAt: { type: Date },
    onboardedAt: { type: Date },
    agentRank: { type: String, enum: ['agent', 'senior', 'lead'] },
    agentNo: { type: String, trim: true, unique: true, sparse: true }, // the ID number printed on the agent's card, e.g. LB-SA-0001 (never two the same)
    agentStartedAt: { type: Date },
    agentResumedAt: { type: Date }, // set when a switched-off agent is switched back on
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Referrer', referrerSchema);
