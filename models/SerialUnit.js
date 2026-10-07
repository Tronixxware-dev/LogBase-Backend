const mongoose = require('mongoose');

// One physical item tracked by its IMEI / serial number (a phone, a laptop, a generator...).
// The product's own quantity stays the source of truth for how many are on the shelf; this record says WHICH ones,
// where each came from, who bought it and until when its warranty runs.
const eventSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['received', 'sold', 'returned', 'written_off'], required: true },
    at: { type: Date, default: Date.now },
    // who it was sold to / returned by, or a short note
    note: { type: String, trim: true },
    // the purchase line or sale line this refers to
    ref: { type: mongoose.Schema.Types.ObjectId },
  },
  { _id: false }
);

const serialUnitSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variant: { type: mongoose.Schema.Types.ObjectId },
    variantLabel: { type: String, trim: true },
    // upper case, no spaces (see utils/serials.js). One number can exist only once per business.
    serial: { type: String, required: true, trim: true },
    status: { type: String, enum: ['in_stock', 'sold', 'written_off'], default: 'in_stock' },

    // where it came from (empty when it was first seen at the moment of a sale)
    purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
    supplierName: { type: String, trim: true },
    receivedAt: { type: Date },
    costPrice: { type: Number, min: 0 }, // only the administrator sees it

    // who has it now (only while status is "sold")
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
    saleGroup: { type: mongoose.Schema.Types.ObjectId },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, trim: true },
    soldAt: { type: Date },
    soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    warrantyMonths: { type: Number, min: 0 },
    warrantyEndsAt: { type: Date },

    events: [eventSchema],
  },
  { timestamps: true }
);

serialUnitSchema.index({ business: 1, serial: 1 }, { unique: true });
serialUnitSchema.index({ business: 1, product: 1, status: 1 });

module.exports = mongoose.model('SerialUnit', serialUnitSchema);
