const mongoose = require('mongoose');

// A person who does the work and is paid for it: a tailor, cutter or embroiderer (kind 'tailor').
// They are not users of the app: they have no login. What they have earned and been paid is kept in WorkerEntry.
const workerSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    kind: { type: String, enum: ['tailor'], required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, trim: true, maxlength: 30 },
    // what they do: Tailor, Cutter, Embroiderer...
    role: { type: String, trim: true, maxlength: 40 },
    // what they usually earn for one piece. A job can override it.
    rate: { type: Number, default: 0, min: 0 },
    // someone who vouches for them (name and phone)
    guarantor: { type: String, trim: true, maxlength: 120 },
    address: { type: String, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 500 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

workerSchema.index({ business: 1, kind: 1, isActive: 1, name: 1 });

module.exports = mongoose.model('Worker', workerSchema);
