// Sales Agents: field people who register businesses on LogBase and are paid for the ones that really start using it.
// This file holds the pay plan (the same one as in the Sales Agent Programme Handbook) and everything worked out from it.
//
// A Sales Agent is a Referrer with kind 'agent' (so signing up with their code, the sign-up link and the login link all work
// exactly like a referral code). The old referral partners (50% of every payment) are not touched by anything here.
//
// What an agent earns (all amounts in kobo, like BillingPayment):
//   New Shop Bonus     once per shop, when it has paid AND got going: at least ACTIVATION.products products and
//                      ACTIVATION.sales sales within ACTIVATION.days days of its first payment.
//   Renewal Commission the agent's rank % of each LATER payment of that shop, for 12 months after its first payment.
//                      (The first payment earns the New Shop Bonus instead of a percentage.) Only while the agent is active.
//   Weekly Bonus       when the week's visits, demos and registrations all reach the targets. A registration counts only when the
//                      business has at least one product. The admin checks the week and ticks each agent before crediting.
//   Monthly Milestone  35 or 50 new activated shops in a month (the higher one only, they do not add up).
//
// Everything is worked out from real records (payments, products, sales, sign-ups) and written down once
// (AgentEarning.uniqueKey), so opening a page twice never pays twice. Nothing has to run at midnight: syncAgent() catches up
// whenever the agent or the admin opens their page.

const Referrer = require('../models/Referrer');
const Referral = require('../models/Referral');
const BillingPayment = require('../models/BillingPayment');
const Subscription = require('../models/Subscription');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const AgentEarning = require('../models/AgentEarning');
const AgentLog = require('../models/AgentLog');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WAT = HOUR; // Lagos time is UTC+1 all year

// rate = the agent's % of each renewal payment
const RANKS = {
  agent: { key: 'agent', name: 'Sales Agent', rate: 10 },
  senior: { key: 'senior', name: 'Senior Sales Agent', rate: 20 },
  lead: { key: 'lead', name: 'Team Lead', rate: 30 },
};
const RANK_KEYS = Object.keys(RANKS);

// New Shop Bonus by the plan of the shop's FIRST payment (kobo)
const NEW_SHOP_BONUS = { starter: 100000, business: 200000 };
// A shop counts as "activated" when it has this much within `days` days of its first payment
const ACTIVATION = { products: 5, sales: 2, days: 14 };
// Renewals earn for this many months after the first payment (plus a few days' grace for a payment made a little late)
const RENEWAL_MONTHS = 12;
const RENEWAL_GRACE_DAYS = 7;
const WEEKLY = { bonus: 300000, visits: 40, demos: 15, registrations: 8 };
// highest first: only the highest one reached is paid
const MILESTONES = [
  { shops: 50, amount: 4000000 },
  { shops: 35, amount: 2000000 },
];
// Senior Sales Agent: this many months in a row with at least this many new activated shops
const SENIOR_RULE = { months: 3, shops: 25 };

// A New Shop Bonus is paid out only once it is this many days old (a shop that is refunded in that time loses its bonus,
// and the admin can take it back with an adjustment before any money has been sent).
const HOLD_DAYS = 30;

/* ---------------------------------- time ---------------------------------- */

const paidOn = (payment) => new Date(payment.paidAt || payment.createdAt);

// 'YYYY-MM-DD' of a moment, in Lagos time
function dayOf(date) {
  return new Date(new Date(date).getTime() + WAT).toISOString().slice(0, 10);
}
const monthOf = (date) => dayOf(date).slice(0, 7);

// the Monday ('YYYY-MM-DD') of the week that contains the given day
function mondayOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

// the moments a Mon-Sun week starts and ends (Lagos time)
function weekRange(monday) {
  const start = new Date(new Date(`${monday}T00:00:00Z`).getTime() - WAT);
  return { start, end: new Date(start.getTime() + 7 * DAY), lastDay: new Date(new Date(`${monday}T00:00:00Z`).getTime() + 6 * DAY).toISOString().slice(0, 10) };
}

function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1) - WAT), end: new Date(Date.UTC(y, m, 1) - WAT) };
}

function addMonthsKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const naira = (kobo) => Math.round(Number(kobo) || 0) / 100;

const rankOf = (agent) => RANKS[agent.agentRank] || RANKS.agent;

/* ----------------------------- new shop bonus ----------------------------- */

// How far a shop is towards "activated", counting only what happened up to the deadline (14 days after its first payment).
async function activationOf(businessId, firstPaidAt) {
  const deadline = new Date(new Date(firstPaidAt).getTime() + ACTIVATION.days * DAY);
  const [products, sales] = await Promise.all([
    Product.find({ business: businessId, isActive: { $ne: false }, createdAt: { $lte: deadline } }).sort({ createdAt: 1 }).limit(ACTIVATION.products).select('createdAt').lean(),
    Sale.find({ business: businessId, date: { $lte: deadline } }).sort({ date: 1 }).limit(ACTIVATION.sales).select('date').lean(),
  ]);
  const met = products.length >= ACTIVATION.products && sales.length >= ACTIVATION.sales;
  const moments = [new Date(firstPaidAt)];
  if (met) {
    moments.push(new Date(products[ACTIVATION.products - 1].createdAt), new Date(sales[ACTIVATION.sales - 1].date));
  }
  return {
    products: products.length,
    sales: sales.length,
    met,
    deadline,
    activatedAt: met ? new Date(Math.max(...moments.map((m) => m.getTime()))) : null,
  };
}

async function safeCreate(doc) {
  try {
    return await AgentEarning.create(doc);
  } catch (err) {
    if (err && err.code === 11000) return null; // already credited
    throw err;
  }
}

async function resolveNewShop(agent, referral, firstPayment) {
  const first = paidOn(firstPayment);
  const act = await activationOf(referral.business, first);
  if (act.met) {
    const amount = NEW_SHOP_BONUS[firstPayment.plan] || NEW_SHOP_BONUS.starter;
    await safeCreate({
      agent: agent._id,
      type: 'new_shop',
      amount,
      business: referral.business,
      businessName: referral.businessName,
      payment: firstPayment._id,
      plan: firstPayment.plan,
      paymentAmount: firstPayment.amount,
      uniqueKey: `new_shop:${referral.business}`,
      earnedAt: act.activatedAt,
    });
    await Referral.updateOne({ _id: referral._id }, { $set: { agentResolved: 'earned' } });
  } else if (Date.now() > act.deadline.getTime()) {
    await Referral.updateOne({ _id: referral._id }, { $set: { agentResolved: 'missed' } });
  }
}

/* ------------------------------- renewals --------------------------------- */

function renewalWindowEnd(firstPayment) {
  const end = new Date(paidOn(firstPayment));
  end.setUTCMonth(end.getUTCMonth() + RENEWAL_MONTHS);
  return new Date(end.getTime() + RENEWAL_GRACE_DAYS * DAY);
}

// Called by recordCommission (utils/referrals.js) each time a referred business pays; syncAgent also catches up.
async function recordAgentPayment(payment, agent) {
  if (!payment || payment.status !== 'success' || !agent || !agent.isActive) return null;
  await syncAgent(agent);
  return null;
}

/* ------------------------------- milestones ------------------------------- */

// new activated shops per month: { 'YYYY-MM': count }
async function monthlyCounts(agentId) {
  const rows = await AgentEarning.find({ agent: agentId, type: 'new_shop' }).select('earnedAt').lean();
  const counts = {};
  rows.forEach((r) => {
    const key = monthOf(r.earnedAt);
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

async function creditMilestones(agent) {
  const counts = await monthlyCounts(agent._id);
  const thisMonth = monthOf(new Date());
  for (const [key, count] of Object.entries(counts)) {
    if (key >= thisMonth) continue; // only a finished month
    const hit = MILESTONES.find((m) => count >= m.shops);
    if (!hit) continue;
    // eslint-disable-next-line no-await-in-loop
    await safeCreate({
      agent: agent._id,
      type: 'milestone',
      amount: hit.amount,
      period: key,
      note: `${count} new activated shops in ${key}`,
      uniqueKey: `milestone:${agent._id}:${key}`,
      earnedAt: monthRange(addMonthsKey(key, 1)).start,
    });
  }
}

/* --------------------------------- sync ----------------------------------- */

// Catches the agent's ledger up with what really happened. Safe to call as often as you like.
async function syncAgent(agentOrId) {
  const agent = agentOrId && agentOrId._id ? agentOrId : await Referrer.findById(agentOrId).lean();
  if (!agent || agent.kind !== 'agent' || !agent.isActive) return;
  const referrals = await Referral.find({ referrer: agent._id }).lean();
  if (referrals.length === 0) return;

  const businessIds = referrals.map((r) => r.business);
  const [payments, have, businesses] = await Promise.all([
    BillingPayment.find({ business: { $in: businessIds }, status: 'success' }).sort({ paidAt: 1, createdAt: 1 }).lean(),
    AgentEarning.find({ agent: agent._id, type: 'renewal' }).select('uniqueKey').lean(),
    require('../models/Business').find({ _id: { $in: businessIds } }).select('name').lean(),
  ]);
  const nameOf = new Map(businesses.map((b) => [String(b._id), b.name]));
  const done = new Set(have.map((e) => e.uniqueKey));
  const byBusiness = new Map();
  payments.forEach((p) => {
    const key = String(p.business);
    if (!byBusiness.has(key)) byBusiness.set(key, []);
    byBusiness.get(key).push(p);
  });

  const rank = rankOf(agent);
  for (const referral of referrals) {
    const list = byBusiness.get(String(referral.business)) || [];
    if (list.length === 0) continue;
    const first = list[0];
    const named = { ...referral, businessName: nameOf.get(String(referral.business)) };

    const windowEnd = renewalWindowEnd(first);
    for (const p of list.slice(1)) {
      if (paidOn(p) > windowEnd || done.has(`renewal:${p._id}`)) continue;
      // payments made while the agent was switched off earn nothing (agentResumedAt = when they were switched back on)
      if (agent.agentResumedAt && paidOn(p) < new Date(agent.agentResumedAt)) continue;
      // eslint-disable-next-line no-await-in-loop
      await safeCreate({
        agent: agent._id,
        type: 'renewal',
        amount: Math.round((p.amount * rank.rate) / 100),
        business: referral.business,
        businessName: named.businessName,
        payment: p._id,
        plan: p.plan,
        paymentAmount: p.amount,
        ratePercent: rank.rate,
        uniqueKey: `renewal:${p._id}`,
        earnedAt: paidOn(p),
      });
    }

    // eslint-disable-next-line no-await-in-loop
    if (!referral.agentResolved) await resolveNewShop(agent, named, first);
  }
  await creditMilestones(agent);
}

/* --------------------------------- weekly --------------------------------- */

// How each active agent did in one week (Mon-Sun), and whether the weekly bonus is already credited.
async function weekReport(monday, onlyAgentId) {
  const { start, end, lastDay } = weekRange(monday);
  const agentFilter = { kind: 'agent', isActive: true, ...(onlyAgentId ? { _id: onlyAgentId } : {}) };
  const agents = await Referrer.find(agentFilter).sort({ name: 1 }).lean();
  if (agents.length === 0) return [];
  const ids = agents.map((a) => a._id);
  const [logs, signups, credited] = await Promise.all([
    AgentLog.find({ agent: { $in: ids }, day: { $gte: monday, $lte: lastDay } }).lean(),
    Referral.find({ referrer: { $in: ids }, createdAt: { $gte: start, $lt: end } }).select('referrer business').lean(),
    AgentEarning.find({ type: 'weekly', period: monday, agent: { $in: ids } }).select('agent').lean(),
  ]);
  // A registration only counts when the business really started: it has at least one product.
  // (A name typed in just to reach the target is a sign-up, not a registration.)
  const started = new Set(
    (signups.length ? await Product.distinct('business', { business: { $in: signups.map((r) => r.business) }, isActive: { $ne: false } }) : []).map(String)
  );
  const regOf = new Map();
  const signupOf = new Map();
  signups.forEach((r) => {
    const key = String(r.referrer);
    signupOf.set(key, (signupOf.get(key) || 0) + 1);
    if (started.has(String(r.business))) regOf.set(key, (regOf.get(key) || 0) + 1);
  });
  const paid = new Set(credited.map((c) => String(c.agent)));
  return agents.map((a) => {
    const mine = logs.filter((l) => String(l.agent) === String(a._id));
    const visits = mine.reduce((s, l) => s + l.visits, 0);
    const demos = mine.reduce((s, l) => s + l.demos, 0);
    const registrations = regOf.get(String(a._id)) || 0;
    return {
      agent: a,
      visits,
      demos,
      registrations,
      signups: signupOf.get(String(a._id)) || 0,
      days: mine.length,
      qualifies: visits >= WEEKLY.visits && demos >= WEEKLY.demos && registrations >= WEEKLY.registrations,
      credited: paid.has(String(a._id)),
    };
  });
}

// A week can only be credited once it is over.
const weekIsOver = (monday) => weekRange(monday).end.getTime() <= Date.now();

// `onlyAgentIds`: when given, only these agents are credited (the admin ticks each one after checking their week).
async function creditWeek(monday, onlyAgentIds) {
  const rows = await weekReport(monday);
  const allowed = Array.isArray(onlyAgentIds) ? new Set(onlyAgentIds.map(String)) : null;
  let credited = 0;
  for (const row of rows) {
    if (!row.qualifies || row.credited) continue;
    if (allowed && !allowed.has(String(row.agent._id))) continue;
    // eslint-disable-next-line no-await-in-loop
    const made = await safeCreate({
      agent: row.agent._id,
      type: 'weekly',
      amount: WEEKLY.bonus,
      period: monday,
      note: `Week of ${monday}: ${row.visits} visits, ${row.demos} demos, ${row.registrations} registrations`,
      uniqueKey: `weekly:${row.agent._id}:${monday}`,
      earnedAt: new Date(),
    });
    if (made) credited += 1;
  }
  return credited;
}

/* -------------------------------- summary --------------------------------- */

// The day an earning can be paid out: a New Shop Bonus waits HOLD_DAYS after it was earned, everything else is payable at once.
function payableOn(earning) {
  if (earning.type !== 'new_shop') return null;
  return new Date(new Date(earning.earnedAt).getTime() + HOLD_DAYS * DAY);
}

const isOnHold = (earning, now = new Date()) => {
  const when = payableOn(earning);
  return Boolean(when && when.getTime() > now.getTime());
};

async function ledgerTotals(agentId) {
  const rows = await AgentEarning.find({ agent: agentId }).select('type amount status earnedAt').lean();
  const now = new Date();
  const t = { earned: 0, owed: 0, paid: 0, held: 0, nextHold: null, byType: { new_shop: 0, renewal: 0, weekly: 0, milestone: 0, adjustment: 0 } };
  rows.forEach((r) => {
    t.earned += r.amount;
    if (r.status === 'owed') {
      t.owed += r.amount;
      if (isOnHold(r, now)) {
        t.held += r.amount;
        const when = payableOn(r);
        if (!t.nextHold || when < t.nextHold) t.nextHold = when;
      }
    } else t.paid += r.amount;
    t.byType[r.type] += r.amount;
  });
  Object.keys(t.byType).forEach((k) => {
    t.byType[k] = naira(t.byType[k]);
  });
  return {
    earned: naira(t.earned),
    owed: naira(t.owed),
    paid: naira(t.paid),
    // owed, but a New Shop Bonus that is not 30 days old yet: counted in `owed`, not in `payable`
    held: naira(t.held),
    payable: naira(t.owed - t.held),
    nextPayableOn: t.nextHold,
    byType: t.byType,
  };
}

// Everything the agent's dashboard (and the admin's page for that agent) shows.
async function agentSummary(agent, { sync = true } = {}) {
  if (sync) await syncAgent(agent).catch((err) => console.error('Agent sync failed:', err.message));
  const now = new Date();
  const today = dayOf(now);
  const monday = mondayOf(today);
  const thisMonth = monthOf(now);
  const lastMonday = new Date(new Date(`${monday}T00:00:00Z`).getTime() - 7 * DAY).toISOString().slice(0, 10);

  const referrals = await Referral.find({ referrer: agent._id }).sort({ createdAt: -1 }).populate('business', 'name phone').lean();
  const businessIds = referrals.filter((r) => r.business).map((r) => r.business._id);
  const [subs, payments, earnings, logs, thisWeek, lastWeek, counts, totals, payouts] = await Promise.all([
    Subscription.find({ business: { $in: businessIds } }).lean(),
    BillingPayment.find({ business: { $in: businessIds }, status: 'success' }).sort({ paidAt: 1, createdAt: 1 }).lean(),
    AgentEarning.find({ agent: agent._id }).sort({ earnedAt: -1 }).limit(300).lean(),
    AgentLog.find({ agent: agent._id }).sort({ day: -1 }).limit(14).lean(),
    weekReport(monday, agent._id),
    weekReport(lastMonday, agent._id),
    monthlyCounts(agent._id),
    ledgerTotals(agent._id),
    require('../models/ReferralPayout').find({ referrer: agent._id }).sort({ createdAt: -1 }).limit(60).lean(),
  ]);

  const subOf = new Map(subs.map((s) => [String(s.business), s]));
  const firstOf = new Map();
  payments.forEach((p) => {
    if (!firstOf.has(String(p.business))) firstOf.set(String(p.business), p);
  });
  const earnedBy = new Map();
  earnings.forEach((e) => {
    if (e.business) earnedBy.set(String(e.business), (earnedBy.get(String(e.business)) || 0) + e.amount);
  });

  const shops = [];
  for (const r of referrals) {
    if (!r.business) continue;
    const first = firstOf.get(String(r.business._id));
    const sub = subOf.get(String(r.business._id));
    const paying = Boolean(sub && sub.status === 'active' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > now);
    let state = 'not_paid';
    let progress = null;
    // a shop that has not paid: is it still on a free trial it was given before trials were removed, and how long is left?
    // (for the agent's follow-up list; a new business is on the Free plan, stored as sub.plan 'free', and has no trial)
    let trial = null;
    if (!first && sub && sub.status === 'trialing' && sub.trialEndsAt && sub.plan !== 'free') {
      const left = Math.ceil((new Date(sub.trialEndsAt).getTime() - now.getTime()) / DAY);
      trial = { endsAt: sub.trialEndsAt, daysLeft: left, ended: left <= 0 };
    }
    if (first) {
      if (r.agentResolved === 'earned') state = 'activated';
      else if (r.agentResolved === 'missed') state = 'missed';
      else {
        state = 'activating';
        // eslint-disable-next-line no-await-in-loop
        const act = await activationOf(r.business._id, paidOn(first));
        progress = { products: act.products, sales: act.sales, daysLeft: Math.max(0, Math.ceil((act.deadline.getTime() - now.getTime()) / DAY)) };
      }
    }
    shops.push({
      _id: r.business._id,
      name: r.business.name,
      signedUpAt: r.createdAt,
      state,
      progress,
      paying,
      plan: first ? first.plan : null,
      phone: r.business.phone || '',
      trial,
      // the New Shop Bonus this shop will earn if it gets going in time
      pending: state === 'activating' ? naira(NEW_SHOP_BONUS[first.plan] || NEW_SHOP_BONUS.starter) : 0,
      earned: naira(earnedBy.get(String(r.business._id)) || 0),
    });
  }

  // the month so far, and the months before it
  const monthCount = counts[thisMonth] || 0;
  let streak = 0;
  for (let key = addMonthsKey(thisMonth, -1); (counts[key] || 0) >= SENIOR_RULE.shops; key = addMonthsKey(key, -1)) streak += 1;
  const next = MILESTONES.slice().reverse().find((m) => monthCount < m.shops);

  const mine = thisWeek[0] || { visits: 0, demos: 0, registrations: 0, qualifies: false, credited: false };
  const before = lastWeek[0];

  return {
    agent: {
      _id: agent._id,
      name: agent.name,
      code: agent.code,
      agentNo: agent.agentNo || '',
      rank: rankOf(agent).key,
      rankName: rankOf(agent).name,
      rate: rankOf(agent).rate,
      isActive: agent.isActive,
      startedAt: agent.agentStartedAt || agent.createdAt,
    },
    totals: { ...totals, pending: shops.reduce((sum, s) => sum + s.pending, 0), pendingShops: shops.filter((s) => s.pending > 0).length, shops: shops.length, activated: shops.filter((s) => s.state === 'activated').length, payingNow: shops.filter((s) => s.paying).length },
    week: {
      monday,
      visits: mine.visits,
      demos: mine.demos,
      registrations: mine.registrations,
      targets: { visits: WEEKLY.visits, demos: WEEKLY.demos, registrations: WEEKLY.registrations },
      bonus: naira(WEEKLY.bonus),
      qualifies: mine.qualifies,
      credited: mine.credited,
      last: before ? { monday: lastMonday, qualifies: before.qualifies, credited: before.credited, visits: before.visits, demos: before.demos, registrations: before.registrations } : null,
    },
    month: {
      key: thisMonth,
      activated: monthCount,
      milestones: MILESTONES.slice().reverse().map((m) => ({ shops: m.shops, amount: naira(m.amount), reached: monthCount >= m.shops })),
      next: next ? { shops: next.shops, amount: naira(next.amount), toGo: next.shops - monthCount } : null,
    },
    rankProgress: {
      rank: rankOf(agent).key,
      streak,
      neededMonths: SENIOR_RULE.months,
      shopsPerMonth: SENIOR_RULE.shops,
    },
    shops,
    // who to call when something is unclear (set PROGRAMME_DESK_PHONE on the server; shown on the agent's page when it is set)
    rules: { products: ACTIVATION.products, sales: ACTIVATION.sales, days: ACTIVATION.days, holdDays: HOLD_DAYS },
    desk: { phone: (process.env.PROGRAMME_DESK_PHONE || '').trim(), email: 'support@mylogbase.com' },
    earnings: earnings.map((e) => ({
      _id: e._id,
      type: e.type,
      amount: naira(e.amount),
      businessName: e.businessName || '',
      plan: e.plan || '',
      paymentAmount: e.paymentAmount ? naira(e.paymentAmount) : null,
      ratePercent: e.ratePercent || null,
      period: e.period || '',
      note: e.note || '',
      status: e.status,
      earnedAt: e.earnedAt,
      paidAt: e.paidAt,
      // a New Shop Bonus that has not been paid yet: the day it can be (null for everything else)
      payableOn: e.status === 'owed' ? payableOn(e) : null,
      onHold: e.status === 'owed' && isOnHold(e, now),
    })),
    payouts: payouts.map((p) => ({ _id: p._id, amount: naira(p.amount), note: p.note || '', paidByEmail: p.paidByEmail, createdAt: p.createdAt })),
    logs: logs.map((l) => ({ day: l.day, visits: l.visits, demos: l.demos, notes: l.notes || '' })),
    today,
  };
}

// This month's top agents by new activated shops (first name and last initial only).
async function leaderboard(limit = 10) {
  const { start, end } = monthRange(monthOf(new Date()));
  const rows = await AgentEarning.aggregate([
    { $match: { type: 'new_shop', earnedAt: { $gte: start, $lt: end } } },
    { $group: { _id: '$agent', shops: { $sum: 1 } } },
    { $sort: { shops: -1 } },
    { $limit: limit },
  ]);
  const agents = await Referrer.find({ _id: { $in: rows.map((r) => r._id) }, kind: 'agent', isActive: true }).select('name agentRank').lean();
  const byId = new Map(agents.map((a) => [String(a._id), a]));
  return rows
    .filter((r) => byId.has(String(r._id)))
    .map((r) => {
      const a = byId.get(String(r._id));
      const parts = String(a.name || '').trim().split(/\s+/);
      const short = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
      return { id: String(r._id), name: short, shops: r.shops, rank: (RANKS[a.agentRank] || RANKS.agent).name };
    });
}

// A day the agent may write up: today or one of the 6 days before it (never the future).
function loggableDay(value) {
  const today = dayOf(new Date());
  const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today;
  const age = (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${day}T00:00:00Z`).getTime()) / DAY;
  if (!Number.isFinite(age) || age < 0 || age > 6) return null;
  return day;
}

module.exports = {
  RANKS,
  RANK_KEYS,
  NEW_SHOP_BONUS,
  ACTIVATION,
  WEEKLY,
  HOLD_DAYS,
  payableOn,
  isOnHold,
  MILESTONES,
  SENIOR_RULE,
  dayOf,
  mondayOf,
  weekRange,
  weekIsOver,
  naira,
  rankOf,
  syncAgent,
  recordAgentPayment,
  weekReport,
  creditWeek,
  agentSummary,
  leaderboard,
  loggableDay,
};
