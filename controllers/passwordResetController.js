const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const mailer = require('../utils/mailer');
const { httpError } = require('../utils/httpError');
const { logActivity } = require('../utils/audit');
const { checkPassword } = require('../utils/passwordPolicy');
const { loginGuard } = require('../utils/rateLimit');

const TOKEN_MINUTES = 60;
const RESEND_SECONDS = 60; // one reset email per account per minute, so nobody can flood a mailbox
const SAME_ANSWER = 'If that email belongs to a LogBase account, we have sent a link to reset its password.';

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

// Only a fingerprint of the token is stored, so a copy of the database cannot be used to reset passwords.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// POST /api/auth/forgot-password   body: { email }
// The answer is the same whether or not the email has an account, so it cannot be used to find out who is a customer.
async function forgotPassword(req, res, next) {
  try {
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'Enter the email you log in with');
    // not tied to any account, so it is safe to say
    if (!mailer.isConfigured()) throw httpError(503, 'Resetting a password by email is not available yet. Please try again later.');

    const user = await User.findOne({ email });
    if (user && user.isActive) {
      const now = new Date();
      const token = crypto.randomBytes(32).toString('hex');
      // atomic: only one request per minute gets through, even if two arrive at the same moment
      const claimed = await User.updateOne(
        { _id: user._id, $or: [{ resetRequestedAt: null }, { resetRequestedAt: { $lte: new Date(now.getTime() - RESEND_SECONDS * 1000) } }] },
        {
          $set: {
            resetTokenHash: hashToken(token),
            resetTokenExpires: new Date(now.getTime() + TOKEN_MINUTES * 60 * 1000),
            resetRequestedAt: now,
          },
        }
      );
      if ((claimed.matchedCount ?? claimed.n ?? 0) > 0) {
        const link = `${frontendUrl()}/reset-password?token=${token}`;
        const message = mailer.resetPasswordEmail({ name: user.name, link, minutes: TOKEN_MINUTES });
        // not waited for: sending takes time, and a quicker answer for real accounts would give them away
        mailer.sendEmail({ to: user.email, ...message }).catch((err) => console.error('Reset email failed:', err.message));
      }
    }
    res.json({ message: SAME_ANSWER });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/reset-password   body: { token, password }
// The link works once. Logins from before the reset stop working.
async function resetPassword(req, res, next) {
  try {
    const body = req.body || {};
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!/^[a-f0-9]{64}$/.test(token)) throw httpError(400, 'This reset link is not valid. Ask for a new one.');
    const now = new Date();
    const tokenHash = hashToken(token);

    // look at the account first, so a weak password is refused WITHOUT using the link up
    const candidate = await User.findOne({ resetTokenHash: tokenHash, resetTokenExpires: { $gt: now }, isActive: true });
    if (!candidate) throw httpError(400, 'This reset link has expired or was already used. Ask for a new one.');
    const weak = checkPassword(password, { label: 'new password', email: candidate.email, name: candidate.name });
    if (weak) throw httpError(400, weak);

    const passwordHash = await bcrypt.hash(password, 10);
    // one step finds the account AND uses the link up, so it cannot be used twice
    const user = await User.findOneAndUpdate(
      { resetTokenHash: tokenHash, resetTokenExpires: { $gt: now }, isActive: true },
      { $set: { passwordHash, passwordChangedAt: now }, $unset: { resetTokenHash: '', resetTokenExpires: '' } },
      { new: true }
    );
    if (!user) throw httpError(400, 'This reset link has expired or was already used. Ask for a new one.');
    loginGuard.clearEmail(user.email); // a person who was locked out by wrong guesses can log in with the new password at once

    logActivity(
      { user, businessId: user.business },
      { action: 'staff.password_reset', summary: `${user.name} reset their password with the email link.`, entityType: 'User', entityId: user._id }
    );
    if (mailer.isConfigured()) {
      mailer.sendEmail({ to: user.email, ...mailer.passwordChangedEmail({ name: user.name }) }).catch((err) => console.error('Password-changed email failed:', err.message));
    }

    res.json({ message: 'Your password was changed. You can log in now.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { forgotPassword, resetPassword, hashToken, TOKEN_MINUTES, RESEND_SECONDS };
