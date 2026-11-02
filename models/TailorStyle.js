const mongoose = require('mongoose');

// One kind of garment a tailor makes (Agbada, Senator, Gown...): its usual price, what the tailor usually earns for it,
// and which measurements it needs. The price list of the shop.
const tailorStyleSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    price: { type: Number, default: 0, min: 0 },
    // what the tailor usually earns for sewing one (the default pay on an order)
    pay: { type: Number, default: 0, min: 0 },
    // the measurement boxes this garment shows on an order
    measures: [{ type: String, trim: true, maxlength: 40 }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

tailorStyleSchema.index({ business: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('TailorStyle', tailorStyleSchema);
