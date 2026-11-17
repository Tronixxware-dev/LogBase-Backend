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

module.exports = { myAgent, saveLog, inviteInfo, acceptInvite };
