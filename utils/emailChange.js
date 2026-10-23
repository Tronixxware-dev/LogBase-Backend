// Changing the email a person logs in with. Used by the person themselves (confirmed through a link sent to the NEW
// address) and by the LogBase super admin (who vouches for the change, e.g. when the old mailbox is lost).
//
// The login email is also what makes someone a super admin (SUPER_ADMIN_EMAILS), so those addresses are never moved.

const User = require('../models/User');
const Business = require('../models/Business');
const Referrer = require('../models/Referrer');
const { httpError } = require('./httpError');
const { isSuperAdminEmail } = require('./superAdmin');

// A clean address, or a clear 400.
function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a valid email address');
  return email;
}

// Throws unless `email` may become this person's login email.
async function assertCanUseEmail(user, email) {
  if (isSuperAdminEmail(user.email)) throw httpError(400, 'A LogBase super admin account keeps its email: it is listed in SUPER_ADMIN_EMAILS on the server.');
  if (isSuperAdminEmail(email)) throw httpError(400, 'That email cannot be used for this account.');
  if (email === user.email) throw httpError(400, 'That is already the email of this account.');
  if (await User.exists({ email, _id: { $ne: user._id } })) throw httpError(409, 'Another LogBase account already uses that email.');
  // the business email must stay unique as well (it only moves with the owner's email, below)
  if (user.role === 'owner' && (await Business.exists({ email, _id: { $ne: user.business } }))) throw httpError(409, 'Another LogBase business already uses that email.');
}

// Makes `email` the login email. Every login from before this moment stops working, so the person logs in again with the
// new address. When the owner's business used the old address as ITS email too, that moves along with it.
// Returns the old email.
async function applyEmailChange(user, email) {
  const oldEmail = user.email;
  user.email = email;
  user.passwordChangedAt = new Date();
  user.pendingEmail = undefined;
  user.pendingEmailHash = undefined;
  user.pendingEmailExpires = undefined;
  try {
    await user.save();
  } catch (err) {
    if (err && err.code === 11000) throw httpError(409, 'Another LogBase account already uses that email.');
    throw err;
  }
  if (user.role === 'owner') {
    await Business.updateOne({ _id: user.business, email: oldEmail }, { $set: { email } }).catch((err) => console.error('Business email not moved:', err.message));
  }
  // a referral code linked to this account keeps matching the person's address (it stops them using their own code)
  await Referrer.updateMany({ user: user._id, email: oldEmail }, { $set: { email } }).catch(() => {});
  return oldEmail;
}

module.exports = { cleanEmail, assertCanUseEmail, applyEmailChange };
