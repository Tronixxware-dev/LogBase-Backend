const mongoose = require('mongoose');

// Money the business paid to a supplier later, to settle goods it took on credit.
const supplierPaymentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    note: { type: String, trim: true },
    date: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supplierPaymentSchema.index({ supplier: 1, date: 1 });

module.exports = mongoose.model('SupplierPayment', supplierPaymentSchema);
