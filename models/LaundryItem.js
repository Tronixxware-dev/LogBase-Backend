const mongoose = require('mongoose');

// One kind of clothing a laundromat takes in (Native, Jean, Polo, Duvet...) and what it usually costs to wash.
// The owner keeps this list. A laundry order copies the name and price at the time, so changing the list never
// changes an old order.
const laundryItemSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // the name in lower case, so "Polo" and "polo" are the same item
    key: { type: String, required: true },
    // the usual price for one piece (0 = not set yet)
    price: { type: Number, default: 0, min: 0 },
    // the usual price for one piece for the other services (0 = not set yet). The plain "Wash" price is `price` above.
    prices: {
      wash_iron: { type: Number, default: 0, min: 0 },
      iron: { type: Number, default: 0, min: 0 },
      dry_clean: { type: Number, default: 0, min: 0 },
    },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

laundryItemSchema.index({ business: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('LaundryItem', laundryItemSchema);
