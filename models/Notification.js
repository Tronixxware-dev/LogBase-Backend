const mongoose = require('mongoose');

// One alert for one person (the bell in the top bar). Written by utils/notifications.js.
const notificationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // lowStock, creditSale, customerPayment, returns, stockAdjustments, transfers, approvals, jobReady
    type: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, trim: true, maxlength: 300 },
    // the page it opens
    link: { type: String, trim: true, maxlength: 200 },
    readAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ business: 1, user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, readAt: 1 });
// alerts clear themselves after 60 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.model('Notification', notificationSchema);
