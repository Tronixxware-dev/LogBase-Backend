const mongoose = require('mongoose');

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

// One row of the register: the same columns as the paper log book.
const lineSchema = new mongoose.Schema({
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'LaundryItem' },
  // the clothing type, copied so the order still reads correctly if the item list changes
  itemName: { type: String, required: true, trim: true, maxlength: 60 },
  quantity: { type: Number, required: true, min: 1 },
  // Description / colour
  colour: { type: String, trim: true, maxlength: 80 },
  // Stain / special care
  stain: { type: String, trim: true, maxlength: 120 },
  // what is done to the piece: wash, wash & iron, iron only, dry clean
  service: { type: String, enum: ['wash', 'wash_iron', 'iron', 'dry_clean'], default: 'wash' },
  // price of one piece
  price: { type: Number, default: 0, min: 0 },
  dateIn: { type: Date },
  dateOut: { type: Date },
  remarks: { type: String, trim: true, maxlength: 120 },
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

// A customer's clothes brought in to be washed: the register rows, the totals, pick-up or delivery, and the money.
const laundryOrderSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // the store this belongs to (empty = the main store)
    shop: { type: mongoose.Schema.Types.ObjectId },
    // 1, 2, 3 ... per business (shown as L-0001)
    number: { type: Number, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, trim: true },
    customerPhone: { type: String, trim: true },

    lines: [lineSchema],
    // worked out by the server from the lines
    totalItems: { type: Number, default: 0, min: 0 },
    subtotal: { type: Number, default: 0, min: 0 },
    // same-day / express: a percentage added on top of the subtotal
    express: { type: Boolean, default: false },
    expressPercent: { type: Number, default: 0, min: 0 },
    expressFee: { type: Number, default: 0, min: 0 },
    // a discount, as an amount or as a percentage of (subtotal + express); `discount` is always the amount taken off
    discountType: { type: String, enum: ['amount', 'percent'] },
    discountValue: { type: Number, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    deliveryFee: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },

    payments: [paymentSchema],
    // always the total of payments
    amountPaid: { type: Number, default: 0, min: 0 },

    // does the customer come to pick the clothes up, or do we deliver them?
    handover: { type: String, enum: ['pickup', 'delivery'], default: 'pickup' },
    deliveryAddress: { type: String, trim: true, maxlength: 200 },
    // who takes it to the customer (a delivery order that is out for delivery)
    riderName: { type: String, trim: true, maxlength: 60 },
    riderPhone: { type: String, trim: true, maxlength: 30 },

    // received -> processing -> ready -> (delivery orders only) out_for_delivery -> collected (= handed over / delivered)
    status: { type: String, enum: ['received', 'processing', 'ready', 'out_for_delivery', 'collected'], default: 'received' },
    history: [historySchema],
    notes: { type: String, trim: true, maxlength: 1000 },
    dateIn: { type: Date, default: Date.now },
    // the day the clothes are promised back
    deliveryDate: { type: Date },
    readyAt: { type: Date },
    outAt: { type: Date },
    collectedAt: { type: Date },

    clientId: { type: String, trim: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

laundryOrderSchema.index({ business: 1, number: 1 }, { unique: true });
laundryOrderSchema.index({ business: 1, status: 1, dateIn: -1 });
laundryOrderSchema.index({ business: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

module.exports = mongoose.model('LaundryOrder', laundryOrderSchema);
