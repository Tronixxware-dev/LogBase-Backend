const mongoose = require('mongoose');
const { paymentSchema, materialSchema, historySchema, photoSchema } = require('./jobSchemas');

const STATUSES = ['received', 'cutting', 'sewing', 'fitting', 'finishing', 'ready', 'delivered'];

const measureSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    value: { type: String, required: true, trim: true, maxlength: 16 },
  },
  { _id: false }
);

// One garment on the order (an order can have several: an agbada and its trousers and a cap).
const pieceSchema = new mongoose.Schema({
  style: { type: String, required: true, trim: true, maxlength: 80 },
  quantity: { type: Number, default: 1, min: 1 },
  // the price of ONE of them
  price: { type: Number, default: 0, min: 0 },
  // who supplied the cloth: the customer brought it, or the shop sells it
  fabricFrom: { type: String, enum: ['customer', 'shop'], default: 'customer' },
  fabric: { type: String, trim: true, maxlength: 120 },
  // how it should look: neckline, sleeves, buttons, embroidery...
  details: { type: String, trim: true, maxlength: 500 },
  measurements: [measureSchema],
  // the tailor sewing it, and what they earn for it (for the whole line). Only the administrator sees the pay.
  worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker' },
  workerName: { type: String, trim: true },
  pay: { type: Number, default: 0, min: 0 },
  done: { type: Boolean, default: false },
  doneAt: { type: Date },
});

const fittingSchema = new mongoose.Schema({
  at: { type: Date, required: true },
  status: { type: String, enum: ['scheduled', 'done', 'missed'], default: 'scheduled' },
  // what to change after the fitting (take in the waist, lengthen the sleeve...)
  note: { type: String, trim: true, maxlength: 300 },
  byName: { type: String, trim: true },
});

// A tailor's order: what to sew, for whom, the measurements, the price, the deposit, the fittings and the delivery date.
const tailorOrderSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // the store that took the order (empty = the main store)
    shop: { type: mongoose.Schema.Types.ObjectId },
    // 1, 2, 3 ... per business (shown as T-0001)
    number: { type: Number, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, trim: true },
    customerPhone: { type: String, trim: true },
    // what the clothes are for: wedding, owambe, school, office...
    occasion: { type: String, trim: true, maxlength: 100 },
    unit: { type: String, enum: ['in', 'cm'], default: 'in' },
    pieces: [pieceSchema],
    discount: { type: Number, default: 0, min: 0 },
    // always the price of the pieces minus the discount
    total: { type: Number, default: 0, min: 0 },
    payments: [paymentSchema],
    // always the total of payments
    amountPaid: { type: Number, default: 0, min: 0 },
    materials: [materialSchema],
    fittings: [fittingSchema],
    photos: [photoSchema],

    status: { type: String, enum: STATUSES, default: 'received' },
    history: [historySchema],
    notes: { type: String, trim: true, maxlength: 1000 },
    receivedAt: { type: Date, default: Date.now },
    // the day the customer was promised the clothes
    dueDate: { type: Date },
    readyAt: { type: Date },
    deliveredAt: { type: Date },

    clientId: { type: String, trim: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

tailorOrderSchema.index({ business: 1, number: 1 }, { unique: true });
tailorOrderSchema.index({ business: 1, status: 1, receivedAt: -1 });
tailorOrderSchema.index({ business: 1, customer: 1 });
tailorOrderSchema.index({ business: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

const TailorOrder = mongoose.model('TailorOrder', tailorOrderSchema);
TailorOrder.STATUSES = STATUSES;
module.exports = TailorOrder;
