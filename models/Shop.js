const mongoose = require('mongoose');

// A place that holds stock: the main store every business has, and any other stores or branches the owner adds.
// The main store is created the first time it is needed (see utils/shopStock.js), so older businesses need no migration.
const shopSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    address: { type: String, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 30 },
    // true for the main store only (the other stores leave this out, so a sparse unique index allows one main store per business)
    isMain: { type: Boolean },
    // a store that is closed stays on old sales and transfers but cannot be chosen any more
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

shopSchema.index({ business: 1, isMain: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Shop', shopSchema);
