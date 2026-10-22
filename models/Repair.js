const mongoose = require('mongoose');

// Money taken on a job: the deposit when the device is brought in, then any later payments.
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

// A spare part used on the job. When it came from stock, `product` is set and the stock was reduced.
// `cost` is what the part cost the business per unit (only the administrator sees it).
const partSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  quantity: { type: Number, required: true, min: 1 },
  cost: { type: Number, default: 0, min: 0 },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  variant: { type: mongoose.Schema.Types.ObjectId },
  // the store the part came out of (empty = the main store); it goes back there if the part is removed from the job
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

// A device brought in for repair: what is wrong, what was quoted, what has been paid, where the job is.
const repairSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // the store that took the device in (empty = the main store)
    shop: { type: mongoose.Schema.Types.ObjectId },
    // 1, 2, 3 ... per business (shown as R-0001)
    number: { type: Number, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    // copied from the customer so the job still reads correctly if the customer is changed later
    customerName: { type: String, trim: true },
    customerPhone: { type: String, trim: true },

    device: { type: String, required: true, trim: true, maxlength: 100 },
    imei: { type: String, trim: true, maxlength: 40 },
    // what was left with the device: charger, case, SIM...
    accessories: { type: String, trim: true, maxlength: 200 },
    fault: { type: String, required: true, trim: true, maxlength: 500 },

    // the price the customer pays for the whole job (labour and parts). 0 = not quoted yet.
    quote: { type: Number, default: 0, min: 0 },
    payments: [paymentSchema],
    // always the total of payments
    amountPaid: { type: Number, default: 0, min: 0 },
    parts: [partSchema],

    status: { type: String, enum: ['received', 'in_repair', 'ready', 'collected'], default: 'received' },
    history: [historySchema],
    technician: { type: String, trim: true, maxlength: 80 },
    notes: { type: String, trim: true, maxlength: 1000 },
    receivedAt: { type: Date, default: Date.now },
    promisedDate: { type: Date },
    readyAt: { type: Date },
    collectedAt: { type: Date },

    // an id the app makes up for each job it sends, so the same job sent twice is saved once
    clientId: { type: String, trim: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

repairSchema.index({ business: 1, number: 1 }, { unique: true });
repairSchema.index({ business: 1, status: 1, receivedAt: -1 });
repairSchema.index({ business: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

module.exports = mongoose.model('Repair', repairSchema);
