const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['owner', 'staff'], default: 'staff' },
    // A staff's label (e.g. "Cashier"), shown in the Staffs list. Only for display.
    jobTitle: { type: String, trim: true, maxlength: 40 },
    // What a staff may do (see utils/permissions.js). Left unset for the owner (who may do everything) and for
    // staffs created before permissions existed (they get the default set).
    permissions: { type: [String], default: undefined },
    phone: { type: String, trim: true },
    // The person's own profile photo (kept on Cloudinary; publicId is needed to delete it)
    photo: {
      url: { type: String },
      publicId: { type: String },
    },
    // The wide picture behind the top of their profile page
    cover: {
      url: { type: String },
      publicId: { type: String },
    },
    isActive: { type: Boolean, default: true },
    // Forgot password: only a fingerprint (sha256) of the emailed token is kept, never the token itself.
    resetTokenHash: { type: String },
    resetTokenExpires: { type: Date },
    resetRequestedAt: { type: Date }, // when the last reset email was sent (limits how often one can be asked for)
    // Logins created before this moment stop working (set when the password is reset by email)
    passwordChangedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);