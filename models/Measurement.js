const mongoose = require('mongoose');

// A customer's measurements, kept so they are not measured again for every order. A customer can have several sets
// (their own, their husband's, their child's), each with a label.
const measurementSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    unit: { type: String, enum: ['in', 'cm'], default: 'in' },
    // [{ name: 'Chest', value: '38' }] (a value is text so "16 1/2" can be written)
    values: [
      new mongoose.Schema(
        {
          name: { type: String, required: true, trim: true, maxlength: 40 },
          value: { type: String, required: true, trim: true, maxlength: 16 },
        },
        { _id: false }
      ),
    ],
    notes: { type: String, trim: true, maxlength: 300 },
    measuredAt: { type: Date, default: Date.now },
    recordedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

measurementSchema.index({ business: 1, customer: 1, label: 1 }, { unique: true });

module.exports = mongoose.model('Measurement', measurementSchema);
