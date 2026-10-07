const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    // What the business owes this supplier right now (goods taken on credit, minus payments made).
    // Only the owner sees it. Suppliers saved before payables existed have no balance, which means 0.
    balance: { type: Number, default: 0 },
    // What was already owed when the supplier was added to LogBase. Set once, when the supplier is created.
    openingBalance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Supplier', supplierSchema);