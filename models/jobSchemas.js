const mongoose = require('mongoose');

// Small pieces shared by the tailor orders (the repair jobs have their own copies, which are left as they are).

// Money taken on an order: the deposit when it is taken, then any later payments.
const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true, min: 0.01 },
  method: { type: String, enum: ['cash', 'transfer', 'card', 'other'], default: 'cash' },
  kind: { type: String, enum: ['deposit', 'payment'], default: 'payment' },
  note: { type: String, trim: true, maxlength: 120 },
  // the id the app sent with this payment (so the same payment is never taken twice)
  key: { type: String },
  at: { type: Date, default: Date.now },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recordedByName: { type: String, trim: true },
});

// A material (fabric, thread, zip, buttons) used on an order. When it came from stock, `product` is set and the stock was reduced.
// `cost` is what it cost the business per unit (only the administrator sees it).
const materialSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  quantity: { type: Number, required: true, min: 0.01 },
  cost: { type: Number, default: 0, min: 0 },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  variant: { type: mongoose.Schema.Types.ObjectId },
  // the store the material came out of (empty = the main store); it goes back there if it is removed from the order
  shop: { type: mongoose.Schema.Types.ObjectId },
  addedAt: { type: Date, default: Date.now },
  addedByName: { type: String, trim: true },
});

const historySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    byName: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false }
);

// A picture kept on Cloudinary (a style the customer wants, a proof of delivery)
const photoSchema = new mongoose.Schema({
  url: { type: String, required: true },
  publicId: { type: String, required: true },
  at: { type: Date, default: Date.now },
});

module.exports = { paymentSchema, materialSchema, historySchema, photoSchema };
