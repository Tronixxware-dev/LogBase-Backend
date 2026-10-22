const mongoose = require('mongoose');

// How many units of a product (or one colour / size of it) a store other than the main store holds.
// The product's own quantity stays the business-wide total, so everything that already works with it keeps working.
// The main store holds whatever is left: total minus all the rows here. A row whose `shop` is the id of a pending
// transfer is stock on its way (taken from the sender, not yet in the receiving store).
const shopStockSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variant: { type: mongoose.Schema.Types.ObjectId, default: null },
    shop: { type: mongoose.Schema.Types.ObjectId, required: true },
    quantity: { type: Number, default: 0 },
  },
  { timestamps: true }
);

shopStockSchema.index({ business: 1, product: 1, variant: 1, shop: 1 }, { unique: true });
shopStockSchema.index({ business: 1, shop: 1 });

module.exports = mongoose.model('ShopStock', shopStockSchema);
