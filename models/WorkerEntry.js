const mongoose = require('mongoose');

// One line in a worker's account. What they have earned (a piece sewn) adds to it, what the business pays
// them (payout) or takes off (deduction) lowers it. The balance is earnings + bonuses - payouts - deductions.
// This only keeps the record: no money is sent from here.
const workerEntrySchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true },
    kind: { type: String, enum: ['earning', 'bonus', 'deduction', 'payout'], required: true },
    amount: { type: Number, required: true, min: 0.01 },
    description: { type: String, trim: true, maxlength: 160 },
    method: { type: String, enum: ['cash', 'transfer', 'other'] },
    // where an earning came from, so it can be taken back if the work is undone
    sourceType: { type: String, enum: ['order'] },
    sourceId: { type: mongoose.Schema.Types.ObjectId },
    sourceCode: { type: String, trim: true, maxlength: 30 },
    // `order:<id>:<piece id>`: an earning is recorded once per piece
    sourceKey: { type: String },
    // the id the app sent with a payout (so pressing the button twice never pays twice)
    key: { type: String },
    at: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

workerEntrySchema.index({ business: 1, worker: 1, at: -1 });
workerEntrySchema.index({ business: 1, sourceKey: 1 }, { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } });
workerEntrySchema.index({ business: 1, worker: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });

module.exports = mongoose.model('WorkerEntry', workerEntrySchema);
