// A person changes their own login email: they give their password, and a link goes to the NEW address.
// The email only changes when that link is opened, so a typo or someone else's address can never lock the person out.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const mailer = require('../utils/mailer');
const { httpError } = require('../utils/httpError');
const { logActivity } = require('../utils/audit');
const { changePasswordGuard, lockedMessage } = require('../utils/rateLimit');
const { hashToken } = require('./passwordResetController');
const { cleanEmail, assertCanUseEmail, applyEmailChange } = require('../utils/emailChange');

const TOKEN_MINUTES = 60;
const RESEND_SECONDS = 60;

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

// POST /api/auth/me/email   body: { newEmail, password }   (the owner; a staff's email is changed by LogBase support)
async function requestEmailChange(req, res, next) {
  try {
    if (req.user.role !== 'owner') throw httpError(403, 'Only the administrator can change the login email. Ask the administrator of your business.');
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!password) throw httpError(400, 'Enter your current password');
    const newEmail = cleanEmail(req.body.newEmail);
    if (!mailer.isConfigured()) throw httpError(503, 'Changing the email by link is not available yet. Please try again later.');

    // few tries at the password: a borrowed session must not be able to guess it (the same limit as changing the password)
    const waitMs = changePasswordGuard.check(req.user._id);
    if (waitMs > 0) {
      res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
      return res.status(429).json({ message: lockedMessage(waitMs) });
    }
    if (!(await bcrypt.compare(password, req.user.passwordHash))) {
      changePasswordGuard.fail(req.user._id);
      throw httpError(400, 'Your password is not correct');
    }
    changePasswordGuard.success(req.user._id);

    await assertCanUseEmail(req.user, newEmail);

    const now = new Date();
    const token = crypto.randomBytes(32).toString('hex');
    // atomic: one request per minute gets through
    const claimed = await User.updateOne(
      { _id: req.user._id, $or: [{ pendingEmailRequestedAt: null }, { pendingEmailRequestedAt: { $lte: new Date(now.getTime() - RESEND_SECONDS * 1000) } }] },
      { $set: { pendingEmail: newEmail, pendingEmailHash: hashToken(token), pendingEmailExpires: new Date(now.getTime() + TOKEN_MINUTES * 60 * 1000), pendingEmailRequestedAt: now } }
    );
    if ((claimed.matchedCount ?? claimed.n ?? 0) === 0) throw httpError(429, 'A link was sent a moment ago. Wait a minute before asking again.');

    const link = `${frontendUrl()}/confirm-email?token=${token}`;
    try {
      await mailer.sendEmail({ to: newEmail, ...mailer.confirmEmailEmail({ name: req.user.name, newEmail, link, minutes: TOKEN_MINUTES }) });
    } catch (err) {
      // the link could not be sent: forget it, so the person can try again at once
      await User.updateOne({ _id: req.user._id }, { $unset: { pendingEmail: '', pendingEmailHash: '', pendingEmailExpires: '', pendingEmailRequestedAt: '' } });
      console.error('Confirm-email send failed:', err.message);
      throw httpError(502, 'The confirmation email could not be sent. Check the address and try again.');
    }
    // the old address is told too (not waited for)
    mailer.sendEmail({ to: req.user.email, ...mailer.emailChangeRequestedEmail({ name: req.user.name, newEmail }) }).catch((err) => console.error('Change notice failed:', err.message));

    res.json({ message: `We sent a confirmation link to ${newEmail}. Open it to finish. Until then you keep logging in with ${req.user.email}.`, pendingEmail: newEmail });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/confirm-email   body: { token }   (no login: the link is the proof; it works once)
async function confirmEmailChange(req, res, next) {
  try {
    const token = typeof (req.body || {}).token === 'string' ? req.body.token.trim() : '';
    if (!/^[a-f0-9]{64}$/.test(token)) throw httpError(400, 'This link is not valid. Ask for a new one from your profile.');
    const now = new Date();
    const user = await User.findOne({ pendingEmailHash: hashToken(token), pendingEmailExpires: { $gt: now }, isActive: true });
    if (!user || !user.pendingEmail) throw httpError(400, 'This link has expired or was already used. Ask for a new one from your profile.');

    const newEmail = user.pendingEmail;
    await assertCanUseEmail(user, newEmail); // someone may have taken it in the meantime
    const oldEmail = await applyEmailChange(user, newEmail);

    logActivity({ user, businessId: user.business }, { action: 'staff.email_changed', summary: `${user.name} changed their login email to ${newEmail}.`, entityType: 'User', entityId: user._id });
    if (mailer.isConfigured()) {
      const message = mailer.emailChangedEmail({ name: user.name, oldEmail, newEmail });
      mailer.sendEmail({ to: oldEmail, ...message }).catch((err) => console.error('Email-changed notice failed:', err.message));
    }
    res.json({ message: `Your login email is now ${newEmail}. Log in with it.`, email: newEmail });
  } catch (err) {
    next(err);
  }
}

module.exports = { requestEmailChange, confirmEmailChange };
