const mongoose = require('mongoose');

const purchaseImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String },
  },
  { _id: false }
);

const purchaseSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // Purchases recorded together (several colours / items received at once) share this id.
    purchaseGroup: { type: mongoose.Schema.Types.ObjectId, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Set when the product has colour / size variants. variantLabel is a snapshot, e.g. "Red / M".
    variant: { type: mongoose.Schema.Types.ObjectId },
    variantLabel: { type: String, trim: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    supplierName: { type: String, trim: true },
    // Who recorded / received the goods (the owner or a staff member). Defaults to the logged-in user.
    purchasedBy: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    costPricePerUnit: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    batchNumber: { type: String, trim: true },
    // IMEI / serial numbers received on this line (only for tracked products, and only when they were entered)
    serials: [{ type: String }],
    date: { type: Date, default: Date.now },
    // Delivery. Only set when the business itself paid for the goods to be delivered to it
    // (when the supplier pays, nothing is recorded). With several lines in one purchase (purchaseGroup)
    // the fee is kept on the first line only, so adding up deliveryCost never counts it twice.
    deliveryPaidByUs: { type: Boolean, default: false },
    deliveryCost: { type: Number, default: 0, min: 0 },
    // Buying on credit. onCredit is set on every line of a purchase that was not paid for in full.
    // amountPaid (what was handed over on the day) and creditAmount (what was added to the supplier's balance)
    // are kept on the first line only, like the delivery fee, so adding them up never counts them twice.
    // Purchases saved before payables existed have none of these, which means they were paid in full.
    onCredit: { type: Boolean, default: false },
    amountPaid: { type: Number, min: 0 },
    creditAmount: { type: Number, min: 0 },
    // Photos added while the purchase was recorded. They cannot be changed afterwards.
    images: [purchaseImageSchema],
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

purchaseSchema.index({ business: 1, date: -1 });

module.exports = mongoose.model('Purchase', purchaseSchema);
