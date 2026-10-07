const mongoose = require('mongoose');
const { totalQuantity } = require('../utils/variants');

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String },
    isCover: { type: Boolean, default: false },
  },
  { _id: false }
);

const packSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    unitsPerPack: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true },
  },
  { _id: false }
);

// One colour / size option of a product, with its own stock count.
// costPrice / sellingPrice are optional: when missing, the product's own prices apply.
const variantSchema = new mongoose.Schema({
  color: { type: String, trim: true, default: '' },
  size: { type: String, trim: true, default: '' },
  sku: { type: String, trim: true, default: '' },
  quantity: { type: Number, default: 0, min: 0 },
  costPrice: { type: Number, min: 0 },
  sellingPrice: { type: Number, min: 0 },
});

const productSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true },
    barcode: { type: String, trim: true },
    category: { type: String, trim: true },
    brand: { type: String, trim: true },
    description: { type: String, trim: true },
    images: [imageSchema],
    // Only the owner sees or sets this. A product added by a staff starts at 0 until the owner fills it in.
    costPrice: { type: Number, default: 0, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    // For products with variants this is always the sum of the variants' quantities.
    quantity: { type: Number, required: true, default: 0, min: 0 },
    variants: [variantSchema],
    baseUnit: { type: String, default: 'piece' },
    packs: [packSchema],
    reorderThreshold: { type: Number, default: 0 },
    // Phones, laptops and the like: every unit is recorded by its IMEI / serial number, which a sale then has to name.
    tracksSerials: { type: Boolean, default: false },
    // The warranty a sale of this product gets unless the seller changes it (0 = none).
    warrantyMonths: { type: Number, default: 0, min: 0, max: 120 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.pre('validate', function () {
  if (this.variants && this.variants.length > 0) {
    this.quantity = totalQuantity(this.variants);
  }
});

productSchema.index({ business: 1, sku: 1 });
productSchema.index({ business: 1, category: 1 });
productSchema.index({ business: 1, name: 'text', description: 'text' });

module.exports = mongoose.model('Product', productSchema);
