const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    logoUrl: { type: String, default: null },
    currency: { type: String, default: 'NGN' },
    plan: { type: String, enum: ['free', 'pro'], default: 'free' },
    isActive: { type: Boolean, default: true },
    // Set by the LogBase super admin (see controllers/adminController.js). A suspended business cannot log in or use the API.
    suspendedAt: { type: Date },
    suspendedReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Business', businessSchema);