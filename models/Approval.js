const mongoose = require('mongoose');

// A staff's action that is waiting for the administrator's OK (see utils/approvals.js).
// The whole request is kept here; when the administrator approves it, it is run exactly as the staff would have run it.
const approvalSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    kind: { type: String, enum: ['sale', 'return', 'stockAdjustment'], required: true },
    // processing = being carried out right now (stops two clicks from doing it twice)
    status: { type: String, enum: ['pending', 'processing', 'approved', 'declined', 'cancelled', 'failed'], default: 'pending' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: { type: String, trim: true },
    // one line a person can read, and the rules that held it back
    summary: { type: String, required: true, trim: true, maxlength: 300 },
    reasons: { type: [String], default: [] },
    // small facts for the list: { total, owed, discountPercent, value, units ... }
    facts: { type: mongoose.Schema.Types.Mixed },
    // exactly what was sent (the sale, the return or the adjustment), and the store the person was working in
    payload: { type: mongoose.Schema.Types.Mixed },
    shopId: { type: String },
    // photos already uploaded with a sale
    files: [{ _id: false, url: String, publicId: String }],
    clientId: { type: String },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedByName: { type: String, trim: true },
    decidedAt: { type: Date },
    decisionNote: { type: String, trim: true, maxlength: 300 },
    // what approving it made (a sale, a return, a stock change) or why it could not be carried out
    resultType: { type: String },
    resultId: { type: mongoose.Schema.Types.ObjectId },
    failureMessage: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

approvalSchema.index({ business: 1, status: 1, createdAt: -1 });
approvalSchema.index({ business: 1, requestedBy: 1, createdAt: -1 });
// the same offline sale sent twice must not queue two requests
approvalSchema.index({ business: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

module.exports = mongoose.model('Approval', approvalSchema);
