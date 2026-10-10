const mongoose = require('mongoose');

// What the LogBase super admin did in the admin panel (suspending a business, changing a plan, sending emails...).
// Kept apart from each business's own activity log, so business owners never see it. Never edited or deleted by the app.
const adminLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    adminEmail: { type: String, trim: true },
    action: { type: String, required: true, trim: true }, // e.g. "business.suspend", "plan.grant", "email.send"
    summary: { type: String, required: true, trim: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
    businessName: { type: String, trim: true },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

adminLogSchema.index({ createdAt: -1 });
adminLogSchema.index({ business: 1, createdAt: -1 });

module.exports = mongoose.model('AdminLog', adminLogSchema);
