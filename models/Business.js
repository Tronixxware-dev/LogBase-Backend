const mongoose = require('mongoose');
const { BUSINESS_TYPE_KEYS, DEFAULT_BUSINESS_TYPE } = require('../utils/businessTypes');

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    logoUrl: { type: String, default: null },
    logoPublicId: { type: String }, // needed to delete the logo from Cloudinary again
    currency: { type: String, default: 'NGN' },
    // Chosen at signup. Decides the menus and pages the business gets (phone shop, general shop, laundromat, repair workshop).
    businessType: { type: String, enum: BUSINESS_TYPE_KEYS, default: DEFAULT_BUSINESS_TYPE },
    // Laundromats: set once the standard list of clothing items has been added (so deleting them all later does not bring them back)
    laundryItemsSeeded: { type: Boolean, default: false },
    // The last repair job / laundry order number given out. Only ever goes up, so a number is never used twice, even after a job is deleted.
    repairCounter: { type: Number, default: 0 },
    laundryCounter: { type: Number, default: 0 },
    transferCounter: { type: Number, default: 0 },
    // Identity shown on receipts, slips and tags (Settings > Organization)
    website: { type: String, trim: true, maxlength: 120 },
    taxId: { type: String, trim: true, maxlength: 40 },
    receipt: {
      showLogo: { type: Boolean, default: true },
      showAddress: { type: Boolean, default: true },
      showPhone: { type: Boolean, default: true },
      showSeller: { type: Boolean, default: true },
      footer: { type: String, trim: true, maxlength: 200 },
      // the closing line (empty = the app's own wording, "We appreciate your patronage")
      closing: { type: String, trim: true, maxlength: 80 },
    },
    // How the business likes things set up (Settings > Preferences). See utils/settings.js for the defaults and limits.
    preferences: {
      defaultPaymentMethod: { type: String, enum: ['cash', 'transfer', 'card', 'other'], default: 'cash' },
      defaultReorderLevel: { type: Number, default: 0, min: 0 },
      expressPercent: { type: Number, default: 50, min: 0, max: 300 },
    },
    // Rules that make a staff's action wait for the administrator's OK (Settings > Approval policies). The administrator is never held up.
    approvalPolicies: {
      returns: { enabled: { type: Boolean, default: false }, minAmount: { type: Number, default: 0, min: 0 } },
      stockAdjustments: { enabled: { type: Boolean, default: false }, minUnits: { type: Number, default: 0, min: 0 } },
      discounts: { enabled: { type: Boolean, default: false }, maxPercent: { type: Number, default: 0, min: 0, max: 100 } },
      creditSales: { enabled: { type: Boolean, default: false }, minAmount: { type: Number, default: 0, min: 0 } },
    },
    plan: { type: String, enum: ['free', 'pro'], default: 'free' },
    isActive: { type: Boolean, default: true },
    // Set by the LogBase super admin (see controllers/adminController.js). A suspended business cannot log in or use the API.
    suspendedAt: { type: Date },
    suspendedReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Business', businessSchema);
