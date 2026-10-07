const mongoose = require('mongoose');

const saleImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String },
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Set when the product has colour / size variants. variantLabel is a snapshot, e.g. "Red / M".
    variant: { type: mongoose.Schema.Types.ObjectId },
    variantLabel: { type: String, trim: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    // Sales recorded together (one customer buying several colours / items at once) share this id.
    saleGroup: { type: mongoose.Schema.Types.ObjectId, index: true },
    // Who bought it. Filled from the customer record when one is chosen, or typed for walk-in customers.
    customerName: { type: String, trim: true },
    // Who sold it (the owner or a staff member). Defaults to the logged-in user.
    sellerName: { type: String, trim: true },
    // quantity, totalAmount and amountPaid are what is left after returns. A fully returned line has quantity 0.
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, required: true, default: 0 },
    paymentStatus: { type: String, enum: ['paid', 'partial', 'credit', 'returned'], default: 'paid' },
    paymentMethod: { type: String, enum: ['cash', 'transfer', 'card', 'other'], default: 'cash' },
    // Returns. quantity + returnedQuantity is what was originally sold; totalAmount + returnedAmount what it was worth;
    // amountPaid + refundedAmount what the customer originally paid on the day.
    returnedQuantity: { type: Number, default: 0, min: 0 },
    returnedAmount: { type: Number, default: 0, min: 0 },
    refundedAmount: { type: Number, default: 0, min: 0 },
    date: { type: Date, default: Date.now },
    // IMEI / serial numbers of the units on this line (only for products that are tracked). Always as many as `quantity`:
    // a unit that comes back moves from `serials` to `returnedSerials`.
    serials: [{ type: String }],
    returnedSerials: [{ type: String }],
    // Warranty given on this line: how many months, and the day it ends (empty when there is none).
    warrantyMonths: { type: Number, default: 0, min: 0 },
    warrantyEndsAt: { type: Date },
    // Delivery. Only set when the business itself paid for delivering the goods (the customer pays nothing extra).
    // With several lines in one sale (saleGroup) the fee is kept on the first line only, so adding up
    // deliveryCost over all sales never counts it twice.
    deliveryPaidByUs: { type: Boolean, default: false },
    deliveryCost: { type: Number, default: 0, min: 0 },
    // Photos the seller attached to this sale
    images: [saleImageSchema],
    // An id the app makes up for each sale it sends (kept on the first line of a sale only). If the same sale is sent
    // twice (the answer got lost, or a sale recorded while offline is sent again) it is recorded once.
    clientId: { type: String, trim: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

saleSchema.index({ business: 1, date: -1 });
saleSchema.index({ business: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

module.exports = mongoose.model('Sale', saleSchema);
