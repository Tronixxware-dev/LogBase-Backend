const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, trim: true },
  variant: { type: mongoose.Schema.Types.ObjectId },
  variantLabel: { type: String, trim: true },
  quantity: { type: Number, required: true, min: 1 },
  // the IMEI / serial numbers moved (tracked products only)
  serials: [{ type: String }],
});

// Stock sent from one store to another. It leaves the sending store the moment the transfer is made and joins the
// receiving store when someone there accepts it. A declined or cancelled transfer goes back to the sender.
const transferSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    number: { type: Number, required: true },
    fromShop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    fromName: { type: String, trim: true },
    toShop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    toName: { type: String, trim: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled'], default: 'pending' },
    lines: [lineSchema],
    note: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    respondedByName: { type: String, trim: true },
    respondedAt: { type: Date },
    // why it was declined or cancelled
    reason: { type: String, trim: true, maxlength: 300 },
    // the same transfer sent twice (a double click, a lost answer) is recorded once
    clientId: { type: String },
  },
  { timestamps: true }
);

transferSchema.index({ business: 1, number: 1 }, { unique: true });
transferSchema.index({ business: 1, status: 1, createdAt: -1 });
transferSchema.index({ business: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

module.exports = mongoose.model('Transfer', transferSchema);
