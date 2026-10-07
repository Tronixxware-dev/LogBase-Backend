const mongoose = require('mongoose');

// One line of the activity log: who did what, and when. Written by utils/audit.js; only the administrator reads it.
// Entries are never edited or deleted by the app.
const auditLogSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // the name is copied here so the entry still reads correctly if the person is renamed or removed
    userName: { type: String, trim: true },
    userRole: { type: String, trim: true },
    // e.g. "sale.create", "sale.return", "stock.adjust", "product.delete"
    action: { type: String, required: true, trim: true },
    // a short sentence a person can read: "Recorded a sale of ₦12,000 to Ada"
    summary: { type: String, required: true, trim: true },
    entityType: { type: String, trim: true },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    // small extra facts (amounts, quantities). Never passwords, tokens or other secrets.
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ business: 1, createdAt: -1 });
auditLogSchema.index({ business: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ business: 1, user: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
