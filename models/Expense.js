const mongoose = require('mongoose');

// Money the business spent that is not stock: rent, salaries, transport, power, and so on.
// (Stock bought and delivery fees already have their own records, so they are not entered here.)
// Administrator only. It is taken off the profit on the Overview to give the net profit.
const expenseSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    category: {
      type: String,
      enum: ['rent', 'salaries', 'transport', 'power', 'internet', 'marketing', 'packaging', 'repairs', 'taxes', 'other'],
      required: true,
    },
    amount: { type: Number, required: true, min: 0.01 },
    description: { type: String, trim: true, maxlength: 200 },
    paymentMethod: { type: String, enum: ['cash', 'transfer', 'card', 'other'], default: 'cash' },
    // the day the money was spent (not always the day it was typed in)
    date: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true }
);

expenseSchema.index({ business: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
