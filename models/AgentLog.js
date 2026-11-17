const mongoose = require('mongoose');

// What a Sales Agent says they did on one day (shops visited, demos given). One row per agent per day.
// It is the agent's own report, so the weekly bonus is only credited after the admin has looked at the week
// (registrations are not typed in: they are counted from the businesses that really signed up with the agent's code).
const agentLogSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'Referrer', required: true },
    day: { type: String, required: true }, // 'YYYY-MM-DD' (Lagos time)
    visits: { type: Number, default: 0, min: 0, max: 500 },
    demos: { type: Number, default: 0, min: 0, max: 500 },
    notes: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

agentLogSchema.index({ agent: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('AgentLog', agentLogSchema);
