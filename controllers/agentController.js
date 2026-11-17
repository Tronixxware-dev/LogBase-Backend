// What a Sales Agent sees in their own LogBase account (see utils/agents.js for the pay plan).
// Only their own numbers come back. The admin creates the agent and links it to this login (see adminAgentController).

const Referrer = require('../models/Referrer');
const AgentLog = require('../models/AgentLog');
const { httpError } = require('../utils/httpError');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { agentSummary, leaderboard, loggableDay } = require('../utils/agents');
const { agentForToken } = require('../utils/agentInvites');
const { checkPassword } = require('../utils/passwordPolicy');
const { signToken, sanitizeUser } = require('./authController');
const Referral = require('../models/Referral');
const AgentMail = require('../models/AgentMail');
const mailer = require('../utils/mailer');

async function agentOf(user) {
  return Referrer.findOne({ user: user._id, kind: 'agent' }).lean();
}

function count(value, label) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 500) throw httpError(400, `${label} must be a whole number from 0 to 500`);
  return n;
}

// GET /api/agent/me   ->   { agent: null }  or  { ...summary, leaderboard }
async function myAgent(req, res, next) {
  try {
    const agent = await agentOf(req.user);
    if (!agent) return res.json({ agent: null });
    const [summary, board] = await Promise.all([agentSummary(agent), leaderboard(10).catch(() => [])]);
    res.json({ ...summary, leaderboard: board.map((b) => ({ name: b.name, shops: b.shops, rank: b.rank, you: b.id === String(agent._id) })) });
  } catch (err) {
    next(err);
  }
}

// PUT /api/agent/log   body: { day?, visits, demos, notes? }   (today, or one of the last 6 days)
async function saveLog(req, res, next) {
  try {
    const agent = await agentOf(req.user);
    if (!agent) throw httpError(403, 'Not authorized');
    if (!agent.isActive) throw httpError(403, 'Your Sales Agent account is switched off. Contact the Programme Desk.');
    const day = loggableDay(req.body && req.body.day);
    if (!day) throw httpError(400, 'You can only write up today or the last 6 days');
    const visits = count(req.body.visits, 'Visits');
    const demos = count(req.body.demos, 'Demos');
    if (demos > visits) throw httpError(400, 'Demos cannot be more than visits');
    const notes = typeof req.body.notes === 'string' ? req.body.notes.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    await AgentLog.updateOne({ agent: agent._id, day }, { $set: { visits, demos, notes } }, { upsert: true });
    res.json({ ok: true, day });
  } catch (err) {
    next(err);
  }
}

const GONE = 'This link has expired or was already used. Ask the LogBase team to send you a new one.';

// GET /api/agent/invite/:token   (no login: the link in the e-mail is the proof)
async function inviteInfo(req, res, next) {
  try {
    const agent = await agentForToken(req.params.token);
    if (!agent) throw httpError(404, GONE);
    res.json({ name: agent.name, email: agent.email || '', phone: agent.phone || '' });
  } catch (err) {
    next(err);
  }
}

// POST /api/agent/invite/:token   body: { password, phone? }
// The accepted agent chooses a password. That makes their agents-only login (no business, no orders: only the Sales Agent pages)
// and signs them in. If the address already has a LogBase account, that account is linked instead and they sign in as usual.
async function acceptInvite(req, res, next) {
  try {
    const agent = await agentForToken(req.params.token);
    if (!agent) throw httpError(404, GONE);
    if (!agent.email) throw httpError(400, 'This Sales Agent has no email address. Ask the LogBase team to add one.');

    const existing = await User.findOne({ email: agent.email.toLowerCase() }).select('_id');
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!existing) {
      const weak = checkPassword(password, { email: agent.email, name: agent.name });
      if (weak) throw httpError(400, weak);
    }

    // the link works once: take it first, so two taps at the same moment cannot make two accounts
    const claimed = await Referrer.findOneAndUpdate(
      { _id: agent._id, inviteHash: agent.inviteHash },
      { $unset: { inviteHash: '', inviteExpiresAt: '' }, $set: { onboardedAt: new Date() } }
    );
    if (!claimed) throw httpError(404, GONE);

    try {
      if (existing) {
        await Referrer.updateOne({ _id: agent._id }, { $set: { user: existing._id } });
        return res.json({ existing: true, message: 'You already have a LogBase account with this email. Log in with it and open "Sales agent" in the menu.' });
      }
      const phone = typeof req.body.phone === 'string' ? req.body.phone.replace(/\s+/g, ' ').trim().slice(0, 30) : '';
      const user = await User.create({
        name: agent.name,
        email: agent.email.toLowerCase(),
        passwordHash: await bcrypt.hash(password, 10),
        role: 'agent',
        phone: phone || agent.phone || undefined,
      });
      await Referrer.updateOne({ _id: agent._id }, { $set: { user: user._id, ...(phone && !agent.phone ? { phone } : {}) } });
      const out = sanitizeUser(user, null);
      out.isAgent = true;
      out.isReferrer = false;
      return res.json({ token: signToken(user), user: out });
    } catch (err) {
      // nothing was made: give the link back so the agent can try again
      await Referrer.updateOne({ _id: agent._id }, { $set: { inviteHash: agent.inviteHash, inviteExpiresAt: agent.inviteExpiresAt }, $unset: { onboardedAt: '' } }).catch(() => {});
      throw err;
    }
  } catch (err) {
    next(err);
  }
}


// ---------------------------------------------------------------------------------------------------------------------
// Customer service: an agent writes to the businesses they registered.
// The message goes to each business owner's own email, from LogBase's address, with the agent as reply-to. The agent never
// sees the owner's email address. Only the agent's own shops can be written to, with a daily limit, and every message is kept.
// ---------------------------------------------------------------------------------------------------------------------
const MAIL_PER_DAY = 30;
const MAIL_MAX_SHOPS = 20;

async function sentToday(agentId) {
  return AgentMail.countDocuments({ agent: agentId, status: 'sent', createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } });
}

// GET /api/agent/mail   ->   { limit: { perDay, used, left }, items: [...] }
async function mailHistory(req, res, next) {
  try {
    const agent = await agentOf(req.user);
    if (!agent) throw httpError(403, 'Not authorized');
    const [items, used] = await Promise.all([AgentMail.find({ agent: agent._id }).sort({ createdAt: -1 }).limit(60).lean(), sentToday(agent._id)]);
    res.json({
      limit: { perDay: MAIL_PER_DAY, used, left: Math.max(0, MAIL_PER_DAY - used) },
      configured: mailer.isConfigured(),
      items: items.map((m) => ({ _id: m._id, businessName: m.businessName || '', subject: m.subject, message: m.message, status: m.status, error: m.error || '', createdAt: m.createdAt })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/agent/mail   body: { shopIds: [businessId], subject, message }
// {shop} {owner} {agent} {code} {link} in the subject or message are filled in for each business.
async function mailShops(req, res, next) {
  try {
    const agent = await agentOf(req.user);
    if (!agent) throw httpError(403, 'Not authorized');
    if (!agent.isActive) throw httpError(403, 'Your Sales Agent account is switched off. Contact the Programme Desk.');
    if (!mailer.isConfigured()) throw httpError(503, 'Email sending is not set up yet. Contact the Programme Desk.');

    const ids = Array.isArray(req.body.shopIds) ? [...new Set(req.body.shopIds.map(String))] : [];
    if (ids.length === 0) throw httpError(400, 'Choose at least one business');
    if (ids.length > MAIL_MAX_SHOPS) throw httpError(400, `You can write to at most ${MAIL_MAX_SHOPS} businesses at a time`);
    if (!ids.every((id) => /^[a-f0-9]{24}$/i.test(id))) throw httpError(400, 'Choose businesses from your list');
    const subject = typeof req.body.subject === 'string' ? req.body.subject.replace(/\s+/g, ' ').trim() : '';
    const message = typeof req.body.message === 'string' ? req.body.message.replace(/\r/g, '').trim() : '';
    if (subject.length < 3) throw httpError(400, 'Write a subject');
    if (subject.length > 120) throw httpError(400, 'The subject can be at most 120 characters');
    if (message.length < 10) throw httpError(400, 'Write your message');
    if (message.length > 3000) throw httpError(400, 'The message can be at most 3000 characters');

    const used = await sentToday(agent._id);
    if (used + ids.length > MAIL_PER_DAY) {
      throw httpError(429, `You can send ${MAIL_PER_DAY} emails a day. You have ${Math.max(0, MAIL_PER_DAY - used)} left today.`);
    }

    // only businesses that really signed up with this agent's code
    const referrals = await Referral.find({ referrer: agent._id, business: { $in: ids } }).populate('business', 'name').lean();
    if (referrals.length !== ids.length) throw httpError(403, 'You can only write to businesses you registered');
    const owners = await User.find({ business: { $in: ids }, role: 'owner', isActive: true }).select('business name email').lean();
    const ownerOf = new Map(owners.map((o) => [String(o.business), o]));

    const link = `${(process.env.FRONTEND_URL || 'https://mylogbase.com').replace(/\/+$/, '')}/signup?ref=${encodeURIComponent(agent.code)}`;
    const fill = (text, shop, owner) =>
      text
        .replace(/\{shop\}/gi, shop)
        .replace(/\{owner\}/gi, (owner.name || '').split(/\s+/)[0] || 'there')
        .replace(/\{agent\}/gi, agent.name)
        .replace(/\{code\}/gi, agent.code)
        .replace(/\{link\}/gi, link);

    const results = [];
    for (const r of referrals) {
      const shop = r.business && r.business.name ? r.business.name : 'your business';
      const owner = ownerOf.get(String(r.business && r.business._id));
      if (!owner || !owner.email) {
        results.push({ businessId: String(r.business && r.business._id), name: shop, ok: false, reason: 'No email address on file' });
        continue;
      }
      const mail = mailer.agentMessageEmail({
        ownerName: (owner.name || '').split(/\s+/)[0],
        agentName: agent.name,
        agentPhone: agent.phone || '',
        subject: fill(subject, shop, owner),
        message: fill(message, shop, owner),
      });
      let ok = true;
      let reason = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        await mailer.sendEmail({ to: owner.email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: req.user.email });
      } catch (err) {
        ok = false;
        reason = err.message || 'Could not send';
      }
      // eslint-disable-next-line no-await-in-loop
      await AgentMail.create({ agent: agent._id, business: r.business._id, businessName: shop, to: owner.email, subject: mail.subject, message: fill(message, shop, owner), status: ok ? 'sent' : 'failed', error: reason.slice(0, 300) }).catch(() => {});
      results.push({ businessId: String(r.business._id), name: shop, ok, reason });
    }

    const sent = results.filter((x) => x.ok).length;
    res.json({ sent, failed: results.length - sent, results, limit: { perDay: MAIL_PER_DAY, used: used + sent, left: Math.max(0, MAIL_PER_DAY - used - sent) } });
  } catch (err) {
    next(err);
  }
}

module.exports = { myAgent, saveLog, inviteInfo, acceptInvite, mailHistory, mailShops };
