const mongoose = require('mongoose');

// A manual change to how many units are in stock: damaged, lost, expired, stolen, found, or a recount.
// Stock that comes from purchases, sales and returns has its own records; this is for everything else.
const stockAdjustmentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, trim: true },
    variant: { type: mongoose.Schema.Types.ObjectId },
    variantLabel: { type: String, trim: true },

    type: {
      type: String,
      enum: ['damaged', 'lost', 'expired', 'stolen', 'found', 'count', 'other'],
      required: true,
    },
    // + puts units in stock, - takes them out. Never 0.
    change: { type: Number, required: true },
    before: { type: Number, required: true },
    after: { type: Number, required: true },
    note: { type: String, trim: true },

    // change x cost price at the time (negative = money lost). Administrator only.
    costValue: { type: Number, default: 0 },

    date: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true }
);

stockAdjustmentSchema.index({ business: 1, date: -1 });
stockAdjustmentSchema.index({ business: 1, product: 1, date: -1 });

module.exports = mongoose.model('StockAdjustment', stockAdjustmentSchema);
