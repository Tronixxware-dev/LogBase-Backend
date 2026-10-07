const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // lowercase copy of the name so "Shoes" and "shoes" are the same category
    key: { type: String, required: true },
  },
  { timestamps: true }
);

categorySchema.index({ business: 1, key: 1 }, { unique: true });

categorySchema.pre('validate', function () {
  if (this.name) this.key = this.name.trim().toLowerCase();
});

module.exports = mongoose.model('Category', categorySchema);
