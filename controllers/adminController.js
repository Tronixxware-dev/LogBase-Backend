// The LogBase super-admin panel: one place that looks over EVERY business on the platform.
// Every route here is behind requireAuth + requireSuperAdmin (see routes/adminRoutes.js), and every change made here
// is written to the admin log (models/AdminLog.js).
//
// Money: sales, products and expenses are stored in naira. Billing payments are stored in kobo (what Paystack uses),
// and this file turns them into naira before sending them to the browser.

const crypto = require('crypto');
const mongoose = require('mongoose');
const Business = require('../models/Business');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const BillingPayment = require('../models/BillingPayment');
const AuditLog = require('../models/AuditLog');
const AdminLog = require('../models/AdminLog');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Expense = require('../models/Expense');
const Purchase = require('../models/Purchase');
const mailer = require('../utils/mailer');
const { httpError } = require('../utils/httpError');
const { hashToken, TOKEN_MINUTES } = require('./passwordResetController');
const { isSuperAdminEmail } = require('../utils/superAdmin');
const { addDays, entitlementsFor, getSubscription } = require('../utils/billing');
const { PLANS, PAID_PLANS, INTERVALS, TRIAL_PLAN, TRIAL_DAYS, priceOf } = require('../config/plans');

const DAY = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 20;
const TIME_ZONE = 'Africa/Lagos';

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function naira(kobo) {
  return Math.round(Number(kobo) || 0) / 100;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function pageOf(req, size = PAGE_SIZE) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  return { page, size, skip: (page - 1) * size };
}

function checkId(id, what = 'id') {
  if (!mongoose.isValidObjectId(id)) throw httpError(400, `That ${what} is not valid`);
}

// Writes one line in the admin log. Never stops the action it describes.
async function logAdmin(req, { action, summary, business, meta }) {
  try {
    await AdminLog.create({
      admin: req.user._id,
      adminEmail: req.user.email,
      action,
      summary: String(summary).slice(0, 300),
      business: business ? business._id : undefined,
      businessName: business ? business.name : undefined,
      meta,
    });
  } catch (err) {
    console.error('Admin log failed:', err.message);
  }
}

// A business that has no subscription record yet is on its free trial that started the day it signed up
// (the record itself is only created the first time that business opens the app).
function subscriptionOf(business, sub) {
  if (sub) return sub;
  return {
    status: 'trialing',
    plan: TRIAL_PLAN,
    interval: 'monthly',
    trialEndsAt: addDays(business.createdAt, TRIAL_DAYS),
    currentPeriodEnd: null,
    autoRenew: false,
    synthetic: true,
  };
}

// Everything the list and the overview need to know about each business's plan, worked out the same way the app does it.
async function loadBusinessStates() {
  const [businesses, subs] = await Promise.all([
    Business.find().select('name email phone isActive createdAt suspendedAt suspendedReason').lean(),
    Subscription.find().lean(),
  ]);
  const subByBusiness = new Map(subs.map((s) => [String(s.business), s]));
  const now = new Date();
  return businesses.map((b) => {
    const sub = subscriptionOf(b, subByBusiness.get(String(b._id)));
    const ent = entitlementsFor(sub, now);
    return { business: b, sub, ent };
  });
}

// What a plan brings in per month, in naira (a yearly plan counts as one twelfth of its price)
function monthlyValue(sub) {
  const price = priceOf(sub.plan, sub.interval);
  if (!price) return 0;
  return naira(sub.interval === 'yearly' ? price / 12 : price);
}

function planView(state) {
  const { business, sub, ent } = state;
  return {
    state: business.isActive === false ? 'suspended' : ent.state, // active | trialing | trial_ended | expired | suspended
    planState: ent.state,
    plan: ent.plan,
    planName: ent.planName,
    interval: sub.interval,
    endsAt: ent.endsAt,
    daysLeft: ent.daysLeft,
    autoRenew: Boolean(sub.autoRenew),
    lastPaidPlan: ent.lastPaidPlan,
  };
}

function dayKeys(count, now = new Date()) {
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * DAY);
    keys.push(d.toLocaleDateString('en-CA', { timeZone: TIME_ZONE })); // YYYY-MM-DD
  }
  return keys;
}

function monthKeys(count, now = new Date()) {
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/* ------------------------------------------------------------------ */
/* GET /api/admin/overview                                            */
/* ------------------------------------------------------------------ */

async function overview(req, res, next) {
  try {
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * DAY);
    const since7 = new Date(now.getTime() - 7 * DAY);
    const monthsBack = monthKeys(6, now);
    const firstMonth = new Date(`${monthsBack[0]}-01T00:00:00.000Z`);

    const [states, userCount, productCount, saleCount, signupRows, revenueRows, revenueAll, flaggedCount, sales30, salesDaily, topRows, activeIds] =
      await Promise.all([
        loadBusinessStates(),
        User.countDocuments(),
        Product.countDocuments(),
        Sale.countDocuments(),
        Business.find({ createdAt: { $gte: new Date(now.getTime() - 31 * DAY) } }).select('createdAt').lean(),
        BillingPayment.find({ status: 'success', paidAt: { $gte: firstMonth } }).select('amount paidAt').lean(),
        BillingPayment.aggregate([{ $match: { status: 'success' } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
        BillingPayment.countDocuments({ status: 'flagged' }),
        Sale.aggregate([{ $match: { date: { $gte: since30 } } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalAmount' } } }]),
        Sale.aggregate([
          { $match: { date: { $gte: new Date(now.getTime() - 31 * DAY) } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: TIME_ZONE } }, count: { $sum: 1 }, total: { $sum: '$totalAmount' } } },
        ]).catch((err) => {
          // only the little daily chart depends on this; the rest of the overview still loads
          console.error('Admin overview: daily sales chart failed:', err.message);
          return [];
        }),
        Sale.aggregate([
          { $match: { date: { $gte: since30 } } },
          { $group: { _id: '$business', count: { $sum: 1 }, total: { $sum: '$totalAmount' } } },
          { $sort: { total: -1 } },
          { $limit: 5 },
        ]),
        AuditLog.distinct('business', { createdAt: { $gte: since7 } }),
      ]);

    // businesses by plan state, and what the paying ones bring in each month
    const counts = { total: states.length, suspended: 0, active: 0, trialing: 0, trial_ended: 0, expired: 0 };
    const byPlan = { starter: 0, business: 0 };
    let mrr = 0;
    const trialsEnding = [];
    states.forEach((st) => {
      if (st.business.isActive === false) counts.suspended += 1;
      counts[st.ent.state] += 1;
      if (st.ent.state === 'active') {
        byPlan[st.ent.plan] = (byPlan[st.ent.plan] || 0) + 1;
        mrr += monthlyValue(st.sub);
      }
      if (st.ent.state === 'trialing' && st.ent.daysLeft <= 3 && st.business.isActive !== false) trialsEnding.push(st);
    });

    // (counted here rather than in the database: there are only a few hundred rows, and the day is read in Nigerian time)
    const dayOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
    const signupMap = new Map();
    signupRows.forEach((b) => signupMap.set(dayOf(b.createdAt), (signupMap.get(dayOf(b.createdAt)) || 0) + 1));
    const signups = dayKeys(30, now).map((day) => ({ day, count: signupMap.get(day) || 0 }));
    const salesMap = new Map(salesDaily.map((r) => [r._id, r]));
    const salesByDay = dayKeys(30, now).map((day) => ({ day, count: (salesMap.get(day) || {}).count || 0, total: (salesMap.get(day) || {}).total || 0 }));
    const revMap = new Map();
    revenueRows.forEach((p) => {
      const d = new Date(p.paidAt);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const cur = revMap.get(key) || { amount: 0, count: 0 };
      revMap.set(key, { amount: cur.amount + p.amount, count: cur.count + 1 });
    });
    const revenueByMonth = monthsBack.map((month) => ({ month, amount: naira((revMap.get(month) || {}).amount), count: (revMap.get(month) || {}).count || 0 }));

    // names for the tables
    const nameOf = new Map(states.map((st) => [String(st.business._id), st.business.name]));
    const topBusinesses = topRows.map((r) => ({ _id: r._id, name: nameOf.get(String(r._id)) || 'Unknown', sales: r.count, total: r.total }));

    const failedRenewals = states
      .filter((st) => st.sub.autoRenew && st.sub.renewalAttempts > 0)
      .map((st) => ({
        _id: st.business._id,
        name: st.business.name,
        attempts: st.sub.renewalAttempts,
        reason: st.sub.renewalFailure || '',
        nextRenewalAt: st.sub.nextRenewalAt || null,
      }));

    const recent = [...states]
      .sort((a, b) => new Date(b.business.createdAt) - new Date(a.business.createdAt))
      .slice(0, 8)
      .map((st) => ({ _id: st.business._id, name: st.business.name, email: st.business.email, createdAt: st.business.createdAt, ...planView(st) }));

    const owners = await User.find({ business: { $in: recent.map((r) => r._id) }, role: 'owner' }).select('name business').lean();
    const ownerOf = new Map(owners.map((o) => [String(o.business), o.name]));
    recent.forEach((r) => {
      r.ownerName = ownerOf.get(String(r._id)) || '';
    });

    res.json({
      totals: {
        businesses: counts.total,
        users: userCount,
        products: productCount,
        sales: saleCount,
        activeThisWeek: activeIds.length,
        newThisMonth: signups.reduce((s, d) => s + d.count, 0),
      },
      states: counts,
      byPlan,
      mrr: Math.round(mrr),
      revenue: {
        total: naira((revenueAll[0] || {}).amount),
        payments: (revenueAll[0] || {}).count || 0,
        thisMonth: (revenueByMonth[revenueByMonth.length - 1] || {}).amount || 0,
        byMonth: revenueByMonth,
      },
      sales30: { count: (sales30[0] || {}).count || 0, total: (sales30[0] || {}).total || 0 },
      salesByDay,
      signups,
      topBusinesses,
      trialsEnding: trialsEnding
        .sort((a, b) => a.ent.daysLeft - b.ent.daysLeft)
        .slice(0, 10)
        .map((st) => ({ _id: st.business._id, name: st.business.name, daysLeft: st.ent.daysLeft, endsAt: st.ent.endsAt })),
      failedRenewals,
      flaggedPayments: flaggedCount,
      recentSignups: recent,
      generatedAt: now,
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* GET /api/admin/businesses                                          */
/* ------------------------------------------------------------------ */

const STATE_FILTERS = ['active', 'trialing', 'trial_ended', 'expired', 'suspended'];

async function listBusinesses(req, res, next) {
  try {
    const search = cleanText(req.query.search, 80);
    const stateFilter = STATE_FILTERS.includes(req.query.state) ? req.query.state : '';
    const sort = req.query.sort === 'name' ? 'name' : req.query.sort === 'oldest' ? 'oldest' : 'newest';

    let states = await loadBusinessStates();

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const ownerMatches = await User.find({ $or: [{ email: rx }, { name: rx }] }).select('business').lean();
      const ids = new Set(ownerMatches.map((u) => String(u.business)));
      states = states.filter((st) => rx.test(st.business.name) || rx.test(st.business.email) || rx.test(st.business.phone || '') || ids.has(String(st.business._id)));
    }
    if (stateFilter) {
      states = states.filter((st) => (stateFilter === 'suspended' ? st.business.isActive === false : st.business.isActive !== false && st.ent.state === stateFilter));
    }

    states.sort((a, b) => {
      if (sort === 'name') return a.business.name.localeCompare(b.business.name);
      const diff = new Date(a.business.createdAt) - new Date(b.business.createdAt);
      return sort === 'oldest' ? diff : -diff;
    });

    const { page, size, skip } = pageOf(req);
    const total = states.length;
    const slice = states.slice(skip, skip + size);
    const ids = slice.map((st) => st.business._id);

    const [owners, userStats, productStats, saleStats, activity] = await Promise.all([
      User.find({ business: { $in: ids }, role: 'owner' }).select('name email business').lean(),
      User.aggregate([{ $match: { business: { $in: ids } } }, { $group: { _id: '$business', count: { $sum: 1 } } }]),
      Product.aggregate([{ $match: { business: { $in: ids } } }, { $group: { _id: '$business', count: { $sum: 1 } } }]),
      Sale.aggregate([{ $match: { business: { $in: ids } } }, { $group: { _id: '$business', count: { $sum: 1 }, total: { $sum: '$totalAmount' }, last: { $max: '$date' } } }]),
      AuditLog.aggregate([{ $match: { business: { $in: ids } } }, { $group: { _id: '$business', last: { $max: '$createdAt' } } }]),
    ]);
    const by = (rows) => new Map(rows.map((r) => [String(r._id), r]));
    const userMap = by(userStats);
    const productMap = by(productStats);
    const saleMap = by(saleStats);
    const activityMap = by(activity);
    const ownerMap = new Map();
    owners.forEach((o) => {
      if (!ownerMap.has(String(o.business))) ownerMap.set(String(o.business), o);
    });

    const items = slice.map((st) => {
      const id = String(st.business._id);
      const owner = ownerMap.get(id);
      const sale = saleMap.get(id);
      const lastTimes = [sale && sale.last, (activityMap.get(id) || {}).last].filter(Boolean).map((d) => new Date(d).getTime());
      return {
        _id: st.business._id,
        name: st.business.name,
        email: st.business.email,
        phone: st.business.phone || '',
        createdAt: st.business.createdAt,
        ownerName: owner ? owner.name : '',
        ownerEmail: owner ? owner.email : '',
        ...planView(st),
        users: (userMap.get(id) || {}).count || 0,
        products: (productMap.get(id) || {}).count || 0,
        sales: sale ? sale.count : 0,
        salesTotal: sale ? sale.total : 0,
        lastActive: lastTimes.length ? new Date(Math.max(...lastTimes)) : null,
      };
    });

    res.json({ items, total, page, pages: Math.max(Math.ceil(total / size), 1), size });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* GET /api/admin/businesses/:id  (and the same view after every change) */
/* ------------------------------------------------------------------ */

function paymentRow(p) {
  return {
    _id: p._id,
    reference: p.reference,
    plan: p.plan,
    planName: PLANS[p.plan] ? PLANS[p.plan].name : p.plan,
    interval: p.interval,
    amount: naira(p.amount),
    status: p.status,
    renewal: Boolean(p.renewal),
    channel: p.channel || '',
    failureReason: p.failureReason || '',
    paidAt: p.paidAt || null,
    createdAt: p.createdAt,
  };
}

async function businessDetail(id) {
  checkId(id, 'business id');
  const business = await Business.findById(id).lean();
  if (!business) throw httpError(404, 'Business not found');

  const subDoc = await Subscription.findOne({ business: business._id }).lean();
  const sub = subscriptionOf(business, subDoc);
  const ent = entitlementsFor(sub, new Date());

  const [users, payments, saleAgg, productCount, customerCount, expenseAgg, purchaseAgg, recentActivity, adminNotes] = await Promise.all([
    User.find({ business: business._id }).select('name email role jobTitle phone isActive createdAt').sort({ role: -1, createdAt: 1 }).lean(),
    BillingPayment.find({ business: business._id }).sort({ createdAt: -1 }).limit(20).lean(),
    Sale.aggregate([{ $match: { business: business._id } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalAmount' }, last: { $max: '$date' } } }]),
    Product.countDocuments({ business: business._id }),
    Customer.countDocuments({ business: business._id }),
    Expense.aggregate([{ $match: { business: business._id } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }]),
    Purchase.aggregate([{ $match: { business: business._id } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalCost' } } }]),
    AuditLog.find({ business: business._id }).sort({ createdAt: -1 }).limit(15).lean(),
    AdminLog.find({ business: business._id }).sort({ createdAt: -1 }).limit(15).lean(),
  ]);

  const state = { business, sub, ent };
  return {
    business: {
      _id: business._id,
      name: business.name,
      email: business.email,
      phone: business.phone || '',
      address: business.address || '',
      createdAt: business.createdAt,
      isActive: business.isActive !== false,
      suspendedAt: business.suspendedAt || null,
      suspendedReason: business.suspendedReason || '',
    },
    plan: {
      ...planView(state),
      status: sub.status,
      trialEndsAt: sub.trialEndsAt || null,
      currentPeriodEnd: sub.currentPeriodEnd || null,
      lastPaymentAt: sub.lastPaymentAt || null,
      card: sub.card && sub.card.last4 ? { brand: sub.card.brand || '', last4: sub.card.last4, expMonth: sub.card.expMonth || '', expYear: sub.card.expYear || '' } : null,
      renewalAttempts: sub.renewalAttempts || 0,
      renewalFailure: sub.renewalFailure || '',
      monthlyValue: ent.state === 'active' ? monthlyValue(sub) : 0,
    },
    users: users.map((u) => ({ ...u, isSuperAdmin: isSuperAdminEmail(u.email) })),
    stats: {
      sales: (saleAgg[0] || {}).count || 0,
      salesTotal: (saleAgg[0] || {}).total || 0,
      lastSale: (saleAgg[0] || {}).last || null,
      products: productCount,
      customers: customerCount,
      expenses: (expenseAgg[0] || {}).count || 0,
      expensesTotal: (expenseAgg[0] || {}).total || 0,
      purchases: (purchaseAgg[0] || {}).count || 0,
      purchasesTotal: (purchaseAgg[0] || {}).total || 0,
    },
    payments: payments.map(paymentRow),
    recentActivity: recentActivity.map((a) => ({ _id: a._id, userName: a.userName, userRole: a.userRole, action: a.action, summary: a.summary, createdAt: a.createdAt })),
    adminNotes: adminNotes.map((a) => ({ _id: a._id, adminEmail: a.adminEmail, action: a.action, summary: a.summary, createdAt: a.createdAt })),
  };
}

async function getBusiness(req, res, next) {
  try {
    res.json(await businessDetail(req.params.id));
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Read-only look at a business's records (support)                    */
/* ------------------------------------------------------------------ */

// GET /api/admin/businesses/:id/data/:kind?page=1      kind: sales | products | customers | expenses | purchases
async function businessData(req, res, next) {
  try {
    checkId(req.params.id, 'business id');
    const business = await Business.findById(req.params.id).select('_id').lean();
    if (!business) throw httpError(404, 'Business not found');
    const { page, size, skip } = pageOf(req, 25);
    const filter = { business: business._id };

    const kinds = {
      sales: { Model: Sale, sort: { date: -1 }, populate: { path: 'product', select: 'name' } },
      products: { Model: Product, sort: { createdAt: -1 } },
      customers: { Model: Customer, sort: { createdAt: -1 } },
      expenses: { Model: Expense, sort: { date: -1 } },
      purchases: { Model: Purchase, sort: { date: -1 }, populate: { path: 'product', select: 'name' } },
    };
    const kind = kinds[req.params.kind];
    if (!kind) throw httpError(400, 'Unknown kind of records');

    let query = kind.Model.find(filter).sort(kind.sort).skip(skip).limit(size);
    if (kind.populate) query = query.populate(kind.populate);
    const [rows, total] = await Promise.all([query.lean(), kind.Model.countDocuments(filter)]);

    const shape = {
      sales: (r) => ({ _id: r._id, date: r.date, item: (r.product && r.product.name) || '—', variant: r.variantLabel || '', quantity: r.quantity, total: r.totalAmount, paid: r.amountPaid, status: r.paymentStatus, method: r.paymentMethod, customer: r.customerName || '', seller: r.sellerName || '' }),
      products: (r) => ({ _id: r._id, name: r.name, sku: r.sku || '', category: r.category || '', quantity: r.quantity, costPrice: r.costPrice, sellingPrice: r.sellingPrice, isActive: r.isActive !== false }),
      customers: (r) => ({ _id: r._id, name: r.name, phone: r.phone || '', email: r.email || '', balance: r.balance, createdAt: r.createdAt }),
      expenses: (r) => ({ _id: r._id, date: r.date, category: r.category, amount: r.amount, description: r.description || '', by: r.createdByName || '' }),
      purchases: (r) => ({ _id: r._id, date: r.date, item: (r.product && r.product.name) || '—', quantity: r.quantity, totalCost: r.totalCost, supplier: r.supplierName || '' }),
    }[req.params.kind];

    res.json({ items: rows.map(shape), total, page, pages: Math.max(Math.ceil(total / size), 1) });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Changes to a business                                              */
/* ------------------------------------------------------------------ */

async function ownsSuperAdmin(businessId) {
  const users = await User.find({ business: businessId }).select('email').lean();
  return users.some((u) => isSuperAdminEmail(u.email));
}

// POST /api/admin/businesses/:id/suspend   body: { suspended: true|false, reason }
async function setSuspended(req, res, next) {
  try {
    checkId(req.params.id, 'business id');
    const business = await Business.findById(req.params.id);
    if (!business) throw httpError(404, 'Business not found');
    if (typeof req.body.suspended !== 'boolean') throw httpError(400, 'Say whether to suspend or reactivate the business');

    if (req.body.suspended) {
      if (await ownsSuperAdmin(business._id)) throw httpError(400, 'This business belongs to a LogBase super admin and cannot be suspended.');
      business.isActive = false;
      business.suspendedAt = new Date();
      business.suspendedReason = cleanText(req.body.reason, 300);
    } else {
      business.isActive = true;
      business.suspendedAt = undefined;
      business.suspendedReason = undefined;
    }
    await business.save();
    await logAdmin(req, {
      action: req.body.suspended ? 'business.suspend' : 'business.reactivate',
      summary: req.body.suspended ? `Suspended ${business.name}${business.suspendedReason ? `: ${business.suspendedReason}` : ''}` : `Reactivated ${business.name}`,
      business,
    });
    res.json({ message: req.body.suspended ? 'Business suspended' : 'Business reactivated', detail: await businessDetail(business._id) });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/businesses/:id/extend-trial   body: { days }
// Gives the business (more) free trial: from today if its trial is over, from the end of the trial if it is still running.
async function extendTrial(req, res, next) {
  try {
    checkId(req.params.id, 'business id');
    const business = await Business.findById(req.params.id);
    if (!business) throw httpError(404, 'Business not found');
    const days = parseInt(req.body.days, 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw httpError(400, 'Days must be a whole number from 1 to 365');

    const sub = await getSubscription(business._id);
    const now = new Date();
    const ent = entitlementsFor(sub, now);
    if (ent.state === 'active') throw httpError(400, 'This business has a paid plan running. Use "Give a plan" to add time to it instead.');

    const start = ent.state === 'trialing' && sub.trialEndsAt ? new Date(sub.trialEndsAt) : now;
    const end = addDays(start, days);
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: 'trialing', plan: TRIAL_PLAN, trialEndsAt: end } });
    await logAdmin(req, { action: 'trial.extend', summary: `Gave ${business.name} ${days} more trial day${days === 1 ? '' : 's'} (until ${end.toISOString().slice(0, 10)})`, business, meta: { days } });
    res.json({ message: `Trial extended by ${days} day${days === 1 ? '' : 's'}`, detail: await businessDetail(business._id) });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/businesses/:id/grant-plan   body: { plan: 'starter'|'business', interval: 'monthly'|'yearly', days, note }
// A free gift of plan time (no payment is recorded and it is not counted as revenue).
async function grantPlan(req, res, next) {
  try {
    checkId(req.params.id, 'business id');
    const business = await Business.findById(req.params.id);
    if (!business) throw httpError(404, 'Business not found');
    const { plan, interval } = req.body;
    if (!PAID_PLANS.includes(plan)) throw httpError(400, 'Choose Starter or Business');
    if (!INTERVALS.includes(interval)) throw httpError(400, 'Choose monthly or yearly');
    const days = parseInt(req.body.days, 10);
    if (!Number.isInteger(days) || days < 1 || days > 730) throw httpError(400, 'Days must be a whole number from 1 to 730');

    const sub = await getSubscription(business._id);
    const now = new Date();
    const running = sub.status === 'active' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() > now.getTime();
    const start = running && sub.plan === plan ? new Date(sub.currentPeriodEnd) : now;
    const end = addDays(start, days);
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: 'active', plan, interval, currentPeriodEnd: end } });
    const note = cleanText(req.body.note, 200);
    await logAdmin(req, {
      action: 'plan.grant',
      summary: `Gave ${business.name} ${days} day${days === 1 ? '' : 's'} of ${PLANS[plan].name} (${interval}), until ${end.toISOString().slice(0, 10)}${note ? `. Note: ${note}` : ''}`,
      business,
      meta: { plan, interval, days, note },
    });
    res.json({ message: `${PLANS[plan].name} plan given until ${end.toISOString().slice(0, 10)}`, detail: await businessDetail(business._id) });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/businesses/:id/end-plan
// Moves the business to the Free plan right now (ends the trial or the paid period, and switches automatic renewal off).
async function endPlan(req, res, next) {
  try {
    checkId(req.params.id, 'business id');
    const business = await Business.findById(req.params.id);
    if (!business) throw httpError(404, 'Business not found');
    if (await ownsSuperAdmin(business._id)) throw httpError(400, 'This business belongs to a LogBase super admin.');
    const sub = await getSubscription(business._id);
    const past = new Date(Date.now() - 1000);
    const set = { autoRenew: false, renewalAttempts: 0, nextRenewalAt: null, renewalLockUntil: null };
    if (sub.status === 'trialing') set.trialEndsAt = past;
    else set.currentPeriodEnd = past;
    await Subscription.updateOne({ _id: sub._id }, { $set: set });
    await logAdmin(req, { action: 'plan.end', summary: `Moved ${business.name} to the Free plan`, business });
    res.json({ message: 'Business moved to the Free plan', detail: await businessDetail(business._id) });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Changes to a person                                                */
/* ------------------------------------------------------------------ */

// POST /api/admin/users/:id/send-reset   emails the person a password reset link (the same one "Forgot password" sends)
async function sendReset(req, res, next) {
  try {
    checkId(req.params.id, 'user id');
    if (!mailer.isConfigured()) throw httpError(503, 'Email sending is not set up on the server.');
    const user = await User.findById(req.params.id);
    if (!user) throw httpError(404, 'User not found');
    if (!user.isActive) throw httpError(400, 'This account is switched off.');

    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    await User.updateOne(
      { _id: user._id },
      { $set: { resetTokenHash: hashToken(token), resetTokenExpires: new Date(now.getTime() + TOKEN_MINUTES * 60 * 1000), resetRequestedAt: now } }
    );
    const link = `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/reset-password?token=${token}`;
    await mailer.sendEmail({ to: user.email, ...mailer.resetPasswordEmail({ name: user.name, link, minutes: TOKEN_MINUTES }) });

    const business = await Business.findById(user.business).select('name').lean();
    await logAdmin(req, { action: 'user.send_reset', summary: `Sent a password reset link to ${user.name} (${user.email})`, business });
    res.json({ message: `A reset link was emailed to ${user.email}` });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/users/:id   body: { isActive }   switches a person's login on or off
async function setUserActive(req, res, next) {
  try {
    checkId(req.params.id, 'user id');
    const user = await User.findById(req.params.id);
    if (!user) throw httpError(404, 'User not found');
    if (typeof req.body.isActive !== 'boolean') throw httpError(400, 'Say whether the account should be on or off');
    if (isSuperAdminEmail(user.email)) throw httpError(400, 'A LogBase super admin account cannot be switched off here.');
    user.isActive = req.body.isActive;
    await user.save();
    const business = await Business.findById(user.business).select('name').lean();
    await logAdmin(req, { action: 'user.toggle', summary: `Switched ${user.name}'s account ${user.isActive ? 'on' : 'off'} (${user.email})`, business });
    res.json({ message: `Account switched ${user.isActive ? 'on' : 'off'}`, detail: await businessDetail(user.business) });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Payments                                                           */
/* ------------------------------------------------------------------ */

// GET /api/admin/payments?status=success&search=ref&page=1
async function listPayments(req, res, next) {
  try {
    const filter = {};
    if (['pending', 'success', 'failed', 'flagged'].includes(req.query.status)) filter.status = req.query.status;
    const search = cleanText(req.query.search, 80);
    if (search) filter.reference = { $regex: escapeRegex(search), $options: 'i' };
    const { page, size, skip } = pageOf(req, 25);

    const [rows, total, byStatus] = await Promise.all([
      BillingPayment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(size).populate('business', 'name').lean(),
      BillingPayment.countDocuments(filter),
      BillingPayment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    ]);
    const summary = { success: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 }, flagged: { count: 0, amount: 0 } };
    byStatus.forEach((r) => {
      if (summary[r._id]) summary[r._id] = { count: r.count, amount: naira(r.amount) };
    });

    res.json({
      items: rows.map((p) => ({ ...paymentRow(p), business: p.business ? { _id: p.business._id, name: p.business.name } : null })),
      total,
      page,
      pages: Math.max(Math.ceil(total / size), 1),
      summary,
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Activity and the admin log                                         */
/* ------------------------------------------------------------------ */

// GET /api/admin/activity?search=&business=<id>&before=<iso>    what people did, across every business
async function listActivity(req, res, next) {
  try {
    const filter = {};
    if (req.query.business && mongoose.isValidObjectId(req.query.business)) filter.business = req.query.business;
    const search = cleanText(req.query.search, 80);
    if (search) filter.summary = { $regex: escapeRegex(search), $options: 'i' };
    if (req.query.before) {
      const before = new Date(String(req.query.before));
      if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
    }
    const limit = 50;
    const rows = await AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).populate('business', 'name').lean();
    const items = rows.slice(0, limit).map((a) => ({
      _id: a._id,
      business: a.business ? { _id: a.business._id, name: a.business.name } : null,
      userName: a.userName,
      userRole: a.userRole,
      action: a.action,
      summary: a.summary,
      createdAt: a.createdAt,
    }));
    res.json({ items, nextBefore: rows.length > limit ? items[items.length - 1].createdAt : null });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/log?before=<iso>    what the super admin(s) did in this panel
async function listAdminLog(req, res, next) {
  try {
    const filter = {};
    if (req.query.before) {
      const before = new Date(String(req.query.before));
      if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
    }
    const limit = 50;
    const rows = await AdminLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    res.json({
      items: items.map((a) => ({ _id: a._id, adminEmail: a.adminEmail, action: a.action, summary: a.summary, business: a.business ? { _id: a.business, name: a.businessName } : null, createdAt: a.createdAt })),
      nextBefore: rows.length > limit ? items[items.length - 1].createdAt : null,
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Emails to owners                                                   */
/* ------------------------------------------------------------------ */

const AUDIENCES = {
  everyone: 'Every business owner',
  trialing: 'Owners on a free trial',
  paid: 'Owners with a paid plan running',
  ended: 'Owners whose trial or paid plan has ended',
  business: 'The owner of one business',
  me: 'Only me (a test)',
};

async function recipientsFor(req) {
  const audience = req.body.audience;
  if (!AUDIENCES[audience]) throw httpError(400, 'Choose who should get the email');

  if (audience === 'me') return [{ name: req.user.name, email: req.user.email }];

  if (audience === 'business') {
    checkId(req.body.businessId, 'business id');
    const owners = await User.find({ business: req.body.businessId, role: 'owner', isActive: true }).select('name email').lean();
    if (owners.length === 0) throw httpError(404, 'That business has no active owner');
    return owners.map((o) => ({ name: o.name, email: o.email }));
  }

  const states = await loadBusinessStates();
  const wanted = states
    .filter((st) => st.business.isActive !== false)
    .filter((st) => {
      if (audience === 'everyone') return true;
      if (audience === 'trialing') return st.ent.state === 'trialing';
      if (audience === 'paid') return st.ent.state === 'active';
      return st.ent.state === 'trial_ended' || st.ent.state === 'expired';
    })
    .map((st) => st.business._id);
  const owners = await User.find({ business: { $in: wanted }, role: 'owner', isActive: true }).select('name email').lean();
  const seen = new Set();
  return owners.filter((o) => (seen.has(o.email) ? false : seen.add(o.email))).map((o) => ({ name: o.name, email: o.email }));
}

// POST /api/admin/email   body: { audience, businessId?, subject, message, dryRun? }
// dryRun: only counts who would get it. A real send answers at once and carries on in the background
// (one email every 0.6 s, which stays inside the email service's limits); the result is written to the admin log.
async function sendAnnouncement(req, res, next) {
  try {
    const subject = cleanText(req.body.subject, 150);
    const message = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 5000) : '';
    const recipients = await recipientsFor(req);

    if (req.body.dryRun) return res.json({ recipients: recipients.length, sample: recipients.slice(0, 5).map((r) => r.email), audience: AUDIENCES[req.body.audience] });

    if (!subject) throw httpError(400, 'Write a subject');
    if (!message) throw httpError(400, 'Write the message');
    if (!mailer.isConfigured()) throw httpError(503, 'Email sending is not set up on the server.');
    if (recipients.length === 0) throw httpError(400, 'Nobody matches that audience right now');
    if (recipients.length > 500) throw httpError(400, 'That is more than 500 people. Send to a smaller group.');

    await logAdmin(req, {
      action: 'email.send',
      summary: `Started sending "${subject}" to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} (${AUDIENCES[req.body.audience]})`,
      meta: { audience: req.body.audience, recipients: recipients.length },
    });
    res.status(202).json({ message: `Sending to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}. This takes about ${Math.max(1, Math.ceil((recipients.length * 0.6) / 60))} minute(s); the result appears in the Admin log.`, recipients: recipients.length });

    // not waited for by the request
    (async () => {
      let sent = 0;
      let failed = 0;
      for (const r of recipients) {
        try {
          await mailer.sendEmail({ to: r.email, ...mailer.announcementEmail({ name: r.name, subject, message }) });
          sent += 1;
        } catch (err) {
          failed += 1;
          console.error('Announcement email failed:', err.message);
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await logAdmin(req, { action: 'email.done', summary: `Finished sending "${subject}": ${sent} sent, ${failed} failed`, meta: { sent, failed } });
    })().catch((err) => console.error('Announcement run failed:', err.message));
  } catch (err) {
    next(err);
  }
}

function audiences(req, res) {
  res.json({ audiences: Object.entries(AUDIENCES).map(([key, label]) => ({ key, label })) });
}

module.exports = {
  overview,
  listBusinesses,
  getBusiness,
  businessData,
  setSuspended,
  extendTrial,
  grantPlan,
  endPlan,
  sendReset,
  setUserActive,
  listPayments,
  listActivity,
  listAdminLog,
  sendAnnouncement,
  audiences,
};
