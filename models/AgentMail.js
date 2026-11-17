const mongoose = require('mongoose');

// One e-mail a Sales Agent sent to a business they registered (customer service). Kept so the Programme Desk can see
// what was sent in LogBase's name, and so the daily limit can be counted.
const agentMailSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'Referrer', required: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
    businessName: { type: String, trim: true },
    to: { type: String, trim: true, lowercase: true },
    subject: { type: String, trim: true, maxlength: 200 },
    message: { type: String, maxlength: 5000 },
    status: { type: String, enum: ['sent', 'failed'], required: true },
    error: { type: String, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

agentMailSchema.index({ agent: 1, createdAt: -1 });

module.exports = mongoose.model('AgentMail', agentMailSchema);
