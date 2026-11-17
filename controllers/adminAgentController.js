// Sales Agents (LogBase super admin only; see routes/adminRoutes.js and utils/agents.js for the pay plan).
// The admin creates an agent (a Referrer with kind 'agent', so it has a referral code), links it to the person's LogBase login,
// checks each week's activity before the weekly bonus is credited, and records a payout once the money has been sent.
//
// Money: stored in kobo (like BillingPayment); this file sends naira to the browser.

const mongoose = require('mongoose');
const Referrer = require('../models/Referrer');
const Referral = require('../models/Referral');
const AgentEarning = require('../models/AgentEarning');
const ReferralPayout = require('../models/ReferralPayout');
const User = require('../models/User');
const AdminLog = require('../models/AdminLog');
const { httpError } = require('../utils/httpError');
const { normalizeCode, freshCode, autoLinkByEmail } = require('../utils/referrals');
const { issueInvite } = require('../utils/agentInvites');
const { RANKS, RANK_KEYS, WEEKLY, syncAgent, agentSummary, weekReport, creditWeek, HOLD_DAYS, payableOn, isOnHold, weekIsOver, mondayOf, dayOf, naira } = require('../utils/agents');

const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

async function logAdmin(req, { action, summary, meta }) {
  try {
    await AdminLog.create({ admin: req.user._id, adminEmail: req.user.email, action, summary: String(summary).slice(0, 300), meta });
  } catch (err) {
    console.error('Admin log failed:', err.message);
  }
}

function checkId(id) {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Sales Agent not found');
}

async function findAgent(id) {
  checkId(id);
  const agent = await Referrer.findOne({ _id: id, kind: 'agent' });
  if (!agent) throw httpError(404, 'Sales Agent not found');
  return agent;
}

function readEmail(value) {
  const email = text(value, 120).toLowerCase();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'Enter a valid email address, or leave it empty');
  return email;
}

function readRank(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!RANK_KEYS.includes(value)) throw httpError(400, 'Choose Sales Agent, Senior Sales Agent or Team Lead');
  return value;
}

// the next ID number: LB-SA-0001, LB-SA-0002, ...
async function nextAgentNo() {
  const last = await Referrer.findOne({ kind: 'agent', agentNo: { $exists: true } }).sort({ agentNo: -1 }).select('agentNo').lean();
  const match = last ? String(last.agentNo).match(/(\d+)$/) : null;
  const n = match ? Number(match[1]) : 0;
  return `LB-SA-${String(n + 1).padStart(4, '0')}`;
}

async function readLinkedUser(value, exceptId) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!mongoose.isValidObjectId(value)) throw httpError(400, 'That LogBase account was not found');
  const user = await User.findById(value).select('name email').lean();
  if (!user) throw httpError(400, 'That LogBase account was not found');
  const taken = await Referrer.findOne({ user: user._id, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('name code').lean();
  if (taken) throw httpError(409, `That account is already linked to ${taken.name} (code ${taken.code}).`);
  return user;
}

// totals for a set of agents: { [id]: { referred, activated, earned, owed, paid } } (naira)
async function totalsFor(ids) {
  const out = new Map(ids.map((id) => [String(id), { referred: 0, activated: 0, earned: 0, owed: 0, paid: 0 }]));
  if (ids.length === 0) return out;
  const [referrals, earnings] = await Promise.all([
    Referral.find({ referrer: { $in: ids } }).select('referrer agentResolved').lean(),
    AgentEarning.find({ agent: { $in: ids } }).select('agent amount status').lean(),
  ]);
  referrals.forEach((r) => {
    const t = out.get(String(r.referrer));
    t.referred += 1;
    if (r.agentResolved === 'earned') t.activated += 1;
  });
  earnings.forEach((e) => {
    const t = out.get(String(e.agent));
    t.earned += e.amount;
    if (e.status === 'owed') t.owed += e.amount;
    else t.paid += e.amount;
  });
  out.forEach((t) => {
    t.earned = naira(t.earned);
    t.owed = naira(t.owed);
    t.paid = naira(t.paid);
  });
  return out;
}

function present(a, t) {
  const rank = RANKS[a.agentRank] || RANKS.agent;
  return {
    _id: a._id,
    name: a.name,
    phone: a.phone || '',
    email: a.email || '',
    code: a.code,
    agentNo: a.agentNo || '',
    rank: rank.key,
    rankName: rank.name,
    rate: rank.rate,
    isActive: a.isActive,
    linked: Boolean(a.user),
    // active: has an account · invited: the e-mail link is waiting · expired: the link ran out (send a new one) · none: no invitation yet
    inviteStatus: a.user ? 'active' : a.inviteHash && a.inviteExpiresAt && new Date(a.inviteExpiresAt) > new Date() ? 'invited' : a.invitedAt ? 'expired' : 'none',
    invitedAt: a.invitedAt || null,
    notes: a.notes || '',
    startedAt: a.agentStartedAt || a.createdAt,
    ...t,
  };
}

// GET /api/admin/agents?search=
async function listAgents(req, res, next) {
  try {
    const filter = { kind: 'agent' };
    const search = text(req.query.search, 60);
    if (search) {
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ name: rx }, { code: rx }, { phone: rx }, { email: rx }, { agentNo: rx }];
    }
    const rows = await Referrer.find(filter).sort({ createdAt: -1 }).lean();
    // keep every agent's ledger up to date so "owed now" is right (small numbers of agents, so this is cheap)
    for (let i = 0; i < rows.length; i += 5) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(rows.slice(i, i + 5).map((row) => syncAgent(row).catch((err) => console.error('Agent sync failed:', err.message))));
    }
    const totals = await totalsFor(rows.map((r) => r._id));
    const items = rows.map((r) => present(r, totals.get(String(r._id))));
    const summary = items.reduce(
      (s, i) => ({ agents: s.agents + (i.isActive ? 1 : 0), referred: s.referred + i.referred, activated: s.activated + i.activated, owed: s.owed + i.owed, paid: s.paid + i.paid }),
      { agents: 0, referred: 0, activated: 0, owed: 0, paid: 0 }
    );
    summary.owed = Math.round(summary.owed * 100) / 100;
    summary.paid = Math.round(summary.paid * 100) / 100;
    res.json({ items, summary });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/agents   body: { name, phone?, email?, code?, rank?, notes?, userId? }
async function createAgent(req, res, next) {
  try {
    const name = text(req.body.name, 80);
    if (!name) throw httpError(400, "Enter the Sales Agent's name");
    const email = readEmail(req.body.email);
    const rank = readRank(req.body.rank) || 'agent';
    let code = normalizeCode(req.body.code);
    if (req.body.code && String(req.body.code).trim() && code.length < 4) throw httpError(400, 'A code needs at least 4 letters or numbers');
    if (code) {
      if (await Referrer.exists({ code })) throw httpError(409, 'That code is already used. Choose another, or leave it empty to get one made for you.');
    } else {
      code = await freshCode();
    }
    const linked = await readLinkedUser(req.body.userId);
    // the acceptance e-mail with the sign-up link goes to this address, so it is needed (unless an existing account is linked)
    if (!linked && !email) throw httpError(400, "Enter the Sales Agent's email address: the acceptance email with the sign-up link is sent to it");
    let agent;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        agent = await Referrer.create({
          kind: 'agent',
          agentRank: rank,
          // eslint-disable-next-line no-await-in-loop
          agentNo: await nextAgentNo(),
          agentStartedAt: new Date(),
          user: linked ? linked._id : undefined,
          name,
          phone: text(req.body.phone, 30) || undefined,
          email: email || undefined,
          code,
          ratePercent: RANKS[rank].rate,
          notes: text(req.body.notes, 300) || undefined,
          createdBy: req.user._id,
        });
        break;
      } catch (err) {
        // the ID number was taken a moment ago by another new agent: take the next one
        if (err && err.code === 11000 && err.keyPattern && err.keyPattern.agentNo && attempt < 3) continue;
        throw err;
      }
    }
    if (!linked && email) await autoLinkByEmail(agent.toObject()).catch((e) => console.error('AUTOLINK', e.message));
    let made = (await Referrer.findById(agent._id).lean()) || agent.toObject();
    // not linked to an account yet: send the "application accepted" e-mail with the link where they set up their own agents-only login
    const invite = made.user ? null : await issueInvite(made._id).catch((e) => {
      console.error('AGENT INVITE', e.message);
      return null;
    });
    if (invite) made = (await Referrer.findById(agent._id).lean()) || made;
    await logAdmin(req, { action: 'agent.create', summary: `Added Sales Agent ${name} (${made.agentNo}, code ${code})${invite && invite.sent ? ' and sent the acceptance email' : ''}`, meta: { code, agentNo: made.agentNo } });
    res.status(201).json({ agent: present(made, { referred: 0, activated: 0, earned: 0, owed: 0, paid: 0 }), invite: invite ? { sent: invite.sent, reason: invite.reason, link: invite.link } : null });
  } catch (err) {
    if (err && err.code === 11000) return next(httpError(409, 'That code is already used. Try again.'));
    next(err);
  }
}

// POST /api/admin/agents/:id/invite   Sends the acceptance e-mail again (a new link; the old one stops working)
async function inviteAgent(req, res, next) {
  try {
    const agent = await findAgent(req.params.id);
    if (agent.user) throw httpError(400, 'This Sales Agent already has an account');
    if (!agent.email) throw httpError(400, 'Add an email address for this Sales Agent first');
    const invite = await issueInvite(agent._id);
    await logAdmin(req, { action: 'agent.invite', summary: `${invite && invite.sent ? 'Sent' : 'Made'} a new sign-up link for Sales Agent ${agent.name} (${agent.agentNo})`, meta: { code: agent.code } });
    res.json({ invite: invite ? { sent: invite.sent, reason: invite.reason, link: invite.link } : null, ...(await detail(agent)) });
  } catch (err) {
    next(err);
  }
}

async function detail(agent) {
  const summary = await agentSummary(agent.toObject ? agent.toObject() : agent);
  const fresh = await Referrer.findById(agent._id).lean();
  let account = null;
  if (fresh.user) {
    const u = await User.findById(fresh.user).select('name email').lean();
    if (u) account = { _id: u._id, name: u.name, email: u.email };
  }
  const totals = await totalsFor([fresh._id]);
  return { ...summary, profile: { ...present(fresh, totals.get(String(fresh._id))), account } };
}

// GET /api/admin/agents/:id
async function getAgent(req, res, next) {
  try {
    res.json(await detail(await findAgent(req.params.id)));
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/agents/:id   body: any of { name, phone, email, rank, isActive, notes, userId }
async function updateAgent(req, res, next) {
  try {
    const agent = await findAgent(req.params.id);
    const b = req.body || {};
    const set = {};
    if (b.name !== undefined) {
      set.name = text(b.name, 80);
      if (!set.name) throw httpError(400, "Enter the Sales Agent's name");
    }
    if (b.phone !== undefined) set.phone = text(b.phone, 30);
    if (b.email !== undefined) set.email = readEmail(b.email);
    if (b.notes !== undefined) set.notes = text(b.notes, 300);
    const rank = readRank(b.rank);
    if (rank) {
      set.agentRank = rank;
      set.ratePercent = RANKS[rank].rate; // applies to payments from now on; what was already earned keeps its own rate
    }
    if (b.isActive !== undefined) {
      set.isActive = Boolean(b.isActive);
      if (!set.isActive && agent.isActive) await syncAgent(agent.toObject()).catch(() => {}); // settle everything earned up to now
      if (set.isActive && !agent.isActive) set.agentResumedAt = new Date(); // nothing is earned for the time they were off
    }
    if (b.userId !== undefined) {
      const linked = await readLinkedUser(b.userId, agent._id);
      set.user = linked ? linked._id : null;
      set.noAutoLink = !linked;
    }
    const updated = await Referrer.findByIdAndUpdate(agent._id, { $set: set }, { new: true });
    if (b.email !== undefined && b.userId === undefined && !updated.user && updated.email) await autoLinkByEmail(updated.toObject()).catch((e) => console.error('AUTOLINK', e.message));
    const summary =
      rank && Object.keys(b).length === 1
        ? `Made ${updated.name} (${updated.agentNo}) a ${RANKS[rank].name}`
        : b.isActive !== undefined
        ? `${updated.isActive ? 'Switched on' : 'Switched off'} Sales Agent ${updated.name} (${updated.agentNo})`
        : `Changed the details of Sales Agent ${updated.name} (${updated.agentNo})`;
    await logAdmin(req, { action: 'agent.update', summary, meta: { code: updated.code, ...set } });
    res.json(await detail(updated));
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/agents/:id/payout   body: { note? }   Records that everything the agent is owed has been paid.
async function payAgent(req, res, next) {
  try {
    const agent = await findAgent(req.params.id);
    await syncAgent(agent.toObject()).catch(() => {});
    const allOwed = await AgentEarning.find({ agent: agent._id, status: 'owed' }).select('_id amount type earnedAt').lean();
    // New Shop Bonuses younger than HOLD_DAYS stay on hold (they are paid in a later payout)
    const now = new Date();
    const owed = allOwed.filter((e) => !isOnHold(e, now));
    const held = allOwed.filter((e) => isOnHold(e, now));
    const total = owed.reduce((s, e) => s + e.amount, 0);
    if (owed.length === 0 || total <= 0) {
      if (held.length > 0) {
        const first = held.map((e) => payableOn(e)).sort((a, b) => a - b)[0];
        throw httpError(400, `Nothing can be paid yet: ${held.length} New Shop Bonus${held.length === 1 ? ' is' : 'es are'} held for ${HOLD_DAYS} days. The first is payable on ${first.toISOString().slice(0, 10)}.`);
      }
      throw httpError(400, 'Nothing is owed to this Sales Agent right now');
    }

    const payout = await ReferralPayout.create({
      referrer: agent._id,
      amount: total,
      commissions: owed.length,
      note: text(req.body && req.body.note, 200) || undefined,
      paidByEmail: req.user.email,
    });
    // only the lines still owed are marked, so two clicks at once never mark one twice
    const result = await AgentEarning.updateMany({ _id: { $in: owed.map((e) => e._id) }, status: 'owed' }, { $set: { status: 'paid', payout: payout._id, paidAt: new Date() } });
    const done = result.modifiedCount ?? result.nModified ?? owed.length;
    if (done !== owed.length) {
      const marked = await AgentEarning.find({ payout: payout._id }).select('amount').lean();
      payout.amount = marked.reduce((s, e) => s + e.amount, 0);
      payout.commissions = marked.length;
      await payout.save();
    }
    await logAdmin(req, { action: 'agent.payout', summary: `Paid Sales Agent ${agent.name} (${agent.agentNo}) ${naira(payout.amount).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })}`, meta: { code: agent.code, amount: naira(payout.amount) } });
    res.json(await detail(agent));
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/agents/:id/adjust   body: { amount (naira, negative takes money back), note }
// For things the plan does not work out by itself, e.g. a shop that was refunded within 30 days (take its bonus back).
async function adjustAgent(req, res, next) {
  try {
    const agent = await findAgent(req.params.id);
    const amount = Number(req.body && req.body.amount);
    const note = text(req.body && req.body.note, 200);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) throw httpError(400, 'Enter an amount in naira (use a minus sign to take money back)');
    if (!note) throw httpError(400, 'Write a short reason');
    await AgentEarning.create({ agent: agent._id, type: 'adjustment', amount: Math.round(amount * 100), note, earnedAt: new Date() });
    await logAdmin(req, { action: 'agent.adjust', summary: `Adjusted Sales Agent ${agent.name} (${agent.agentNo}) by ${amount} naira: ${note}`, meta: { code: agent.code, amount } });
    res.json(await detail(agent));
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/agents/weekly?week=YYYY-MM-DD   (any day of the week; default: the last finished week)
function readWeek(value) {
  const today = dayOf(new Date());
  const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : dayOf(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  const monday = mondayOf(day > today ? today : day);
  return monday;
}

async function weekly(req, res, next) {
  try {
    const monday = readWeek(req.query.week);
    const rows = await weekReport(monday);
    res.json({
      monday,
      over: weekIsOver(monday),
      targets: { visits: WEEKLY.visits, demos: WEEKLY.demos, registrations: WEEKLY.registrations },
      bonus: naira(WEEKLY.bonus),
      items: rows.map((r) => ({ _id: r.agent._id, name: r.agent.name, agentNo: r.agent.agentNo || '', code: r.agent.code, visits: r.visits, demos: r.demos, registrations: r.registrations, signups: r.signups, days: r.days, qualifies: r.qualifies, credited: r.credited })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/agents/weekly   body: { week, agents?: [agentId] }   Credits the weekly bonus to the agents who reached all three targets
// (only the ones listed in `agents`, when it is sent: the admin ticks each agent after checking their week).
async function creditWeekly(req, res, next) {
  try {
    const monday = readWeek(req.body && req.body.week);
    if (!weekIsOver(monday)) throw httpError(400, 'That week is not over yet. Credit it after Sunday.');
    const picked = req.body && Array.isArray(req.body.agents) ? req.body.agents.map(String).slice(0, 500) : undefined;
    const credited = await creditWeek(monday, picked);
    await logAdmin(req, { action: 'agent.weekly', summary: `Credited the weekly bonus for the week of ${monday} to ${credited} Sales Agent${credited === 1 ? '' : 's'}`, meta: { week: monday, credited } });
    res.json({ monday, credited });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAgents, createAgent, getAgent, updateAgent, payAgent, adjustAgent, inviteAgent, weekly, creditWeekly };
