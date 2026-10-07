const mongoose = require('mongoose');

// A role the owner makes up (e.g. "Cashier", "Night shift"): a name plus the permissions ticked for it.
// It is a ready-made set of ticks. When a staff is given a role, its permissions are copied onto the staff,
// so changing or deleting a role later does not change the staffs who already have it.
const roleSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    // lowercase copy of the name so "Cashier" and "cashier" are the same role
    key: { type: String, required: true },
    permissions: { type: [String], default: [] },
  },
  { timestamps: true }
);

roleSchema.index({ business: 1, key: 1 }, { unique: true });

roleSchema.pre('validate', function () {
  if (this.name) this.key = this.name.trim().toLowerCase();
});

module.exports = mongoose.model('Role', roleSchema);
