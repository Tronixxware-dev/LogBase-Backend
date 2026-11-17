// The e-mail invitation of a Sales Agent: "your application is accepted, set up your account here".
// Only a fingerprint (sha256) of the token is stored, like the password-reset links. A new invitation replaces the old link.
const crypto = require('crypto');
const Referrer = require('../models/Referrer');
const mailer = require('./mailer');

const INVITE_DAYS = 7;
const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function inviteLink(token) {
  return `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/join-agent/${token}`;
}

// Makes a new link for the agent (the older one stops working) and says whether the e-mail went out.
async function issueInvite(agentId, { send = true } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const agent = await Referrer.findOneAndUpdate(
    { _id: agentId, kind: 'agent' },
    { $set: { inviteHash: hashOf(token), inviteExpiresAt: new Date(now.getTime() + INVITE_DAYS * 24 * 3600 * 1000), invitedAt: now } },
    { new: true }
  );
  if (!agent) return null;
  const link = inviteLink(token);
  let sent = false;
  let reason = '';
  if (!send) reason = 'not asked';
  else if (!agent.email) reason = 'This Sales Agent has no email address.';
  else if (!mailer.isConfigured()) reason = 'Email sending is not set up on the server.';
  else {
    try {
      await mailer.sendEmail({ to: agent.email, ...mailer.agentAcceptedEmail({ name: agent.name, link }) });
      sent = true;
    } catch (err) {
      reason = 'The email could not be sent.';
      console.error('Agent invite email failed:', err.message);
    }
  }
  return { link, sent, reason, expiresAt: agent.inviteExpiresAt };
}

// The agent record a link belongs to (null when it is wrong, expired or already used)
async function agentForToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return null;
  return Referrer.findOne({ kind: 'agent', inviteHash: hashOf(token), inviteExpiresAt: { $gt: new Date() } });
}

module.exports = { issueInvite, agentForToken, inviteLink, INVITE_DAYS };
