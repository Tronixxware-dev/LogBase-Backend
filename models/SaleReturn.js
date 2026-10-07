const mongoose = require('mongoose');

// One line of a return: some units of one sale line coming back.
const returnItemSchema = new mongoose.Schema(
  {
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
    saleGroup: { type: mongoose.Schema.Types.ObjectId },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productName: { type: String, trim: true },
    variant: { type: mongoose.Schema.Types.ObjectId },
    variantLabel: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    // which IMEI / serial numbers came back (tracked products only)
    serials: [{ type: String }],
    unitPrice: { type: Number, required: true, min: 0 },
    // quantity x unitPrice: what the customer is given credit for
    value: { type: Number, required: true, min: 0 },
    // the part of `value` that only cancelled money the customer had not paid yet
    owedReduction: { type: Number, default: 0, min: 0 },
    // the part of `value` that was paid and is given back (cash, transfer or store credit)
    refund: { type: Number, default: 0, min: 0 },
    // true when the units went back on the shelf
    restocked: { type: Boolean, default: false },
    // what the units cost the business when they did NOT go back on the shelf (administrator only)
    writtenOffCost: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const saleReturnSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    items: { type: [returnItemSchema], validate: (v) => Array.isArray(v) && v.length > 0 },
    // the sale lines this return touches (kept flat so they can be searched)
    sales: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Sale', index: true }],
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    customerName: { type: String, trim: true },

    totalValue: { type: Number, required: true, min: 0 },
    owedReduction: { type: Number, default: 0, min: 0 },
    refundAmount: { type: Number, default: 0, min: 0 },
    // how the refund was given: cash and transfer are money handed back; credit stays with the customer as store credit
    refundMethod: { type: String, enum: ['none', 'cash', 'transfer', 'credit'], default: 'none' },
    // how much this return lowered the customer's balance (owedReduction, plus the refund when it was kept as store credit)
    balanceEffect: { type: Number, default: 0 },

    reason: { type: String, enum: ['defective', 'wrong_item', 'changed_mind', 'other'], default: 'other' },
    note: { type: String, trim: true },
    restock: { type: Boolean, default: true },
    writtenOffCost: { type: Number, default: 0, min: 0 },

    date: { type: Date, default: Date.now },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    processedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

saleReturnSchema.index({ business: 1, date: -1 });

module.exports = mongoose.model('SaleReturn', saleReturnSchema);
