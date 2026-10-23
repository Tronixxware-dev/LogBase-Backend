// Referral codes (LogBase super admin only; see routes/adminRoutes.js).
// The admin gives a code to someone who wants to refer businesses. A business that signs up with the code is "referred";
// every plan payment it makes earns the referrer a share (50% unless set otherwise). The admin sees what each referrer is
// owed and records a payout once the money has been sent to them.
//
// Money: commissions are stored in kobo like BillingPayment; this file sends naira to the browser.

const mongoose = require('mongoose');
const Referrer = require('../models/Referrer');
const Referral = require('../models/Referral');
const ReferralCommission = require('../models/ReferralCommission');
const ReferralPayout = require('../models/ReferralPayout');
const Subscription = require('../models/Subscription');
const Business = require('../models/Business');
const User = require('../models/User');
const AdminLog = require('../models/AdminLog');
const { httpError } = require('../utils/httpError');
const { DEFAULT_RATE, normalizeCode, freshCode, syncCommissions } = require('../utils/referrals');
const { PLANS } = require('../config/plans');

const naira = (kobo) => Math.round(Number(kobo) || 0) / 100;
const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

async function logAdmin(req, { action, summary, meta }) {
  try {
    await AdminLog.create({ admin: req.user._id, adminEmail: req.user.email, action, summary: String(summary).slice(0, 300), meta });
  } catch (err) {
    console.error('Admin log failed:', err.message);
  }
}

function checkId(id) {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Referrer not found');
}

function readRate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 1 || rate > 100) throw httpError(400, 'The share must be a number from 1 to 100');
  return rate;
}

function readEmail(value) {
  const email = text(value, 120).toLowerCase();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'Enter a valid email address, or leave it empty');
  return email;
}

// totals for a set of referrers: { [id]: { referred, paying, earned, owed, paid, payments } } (naira)
async function totalsFor(ids) {
  const out = new Map(ids.map((id) => [String(id), { referred: 0, paying: 0, earned: 0, owed: 0, paid: 0, payments: 0 }]));
  if (ids.length === 0) return out;
  const [referrals, commissions] = await Promise.all([
    Referral.find({ referrer: { $in: ids } }).select('referrer').lean(),
    ReferralCommission.find({ referrer: { $in: ids } }).select('referrer business amount status').lean(),
  ]);
  referrals.forEach((r) => {
    out.get(String(r.referrer)).referred += 1;
  });
  const paying = new Map();
  commissions.forEach((c) => {
    const key = String(c.referrer);
    const t = out.get(key);
    t.earned += c.amount;
    t.payments += 1;
    if (c.status === 'owed') t.owed += c.amount;
    else t.paid += c.amount;
    if (!paying.has(key)) paying.set(key, new Set());
    paying.get(key).add(String(c.business));
  });
  out.forEach((t, key) => {
    t.paying = (paying.get(key) || new Set()).size;
    t.earned = naira(t.earned);
    t.owed = naira(t.owed);
    t.paid = naira(t.paid);
  });
  return out;
}

function present(r, t) {
  return {
    _id: r._id,
    name: r.name,
    phone: r.phone || '',
    email: r.email || '',
    code: r.code,
    ratePercent: r.ratePercent,
    isActive: r.isActive,
    notes: r.notes || '',
    createdAt: r.createdAt,
    ...t,
  };
}

// GET /api/admin/referrers?search=
async function listReferrers(req, res, next) {
  try {
    const filter = {};
    const search = text(req.query.search, 60);
    if (search) {
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ name: rx }, { code: rx }, { phone: rx }, { email: rx }];
    }
    const rows = await Referrer.find(filter).sort({ createdAt: -1 }).lean();
    const totals = await totalsFor(rows.map((r) => r._id));
    const items = rows.map((r) => present(r, totals.get(String(r._id))));
    const summary = items.reduce(
      (s, i) => ({ referrers: s.referrers + 1, referred: s.referred + i.referred, owed: s.owed + i.owed, paid: s.paid + i.paid }),
      { referrers: 0, referred: 0, owed: 0, paid: 0 }
    );
    summary.owed = Math.round(summary.owed * 100) / 100;
    summary.paid = Math.round(summary.paid * 100) / 100;
    res.json({ items, summary, defaultRate: DEFAULT_RATE });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/referrers   body: { name, phone?, email?, code?, ratePercent?, notes? }   (no code = one is made)
async function createReferrer(req, res, next) {
  try {
    const name = text(req.body.name, 80);
    if (!name) throw httpError(400, "Enter the referrer's name");
    const email = readEmail(req.body.email);
    const rate = readRate(req.body.ratePercent);
    let code = normalizeCode(req.body.code);
    if (req.body.code && String(req.body.code).trim() && code.length < 4) throw httpError(400, 'A code needs at least 4 letters or numbers');
    if (code) {
      if (await Referrer.exists({ code })) throw httpError(409, 'That code is already used. Choose another, or leave it empty to get one made for you.');
    } else {
      code = await freshCode();
    }
    const referrer = await Referrer.create({
      name,
      phone: text(req.body.phone, 30) || undefined,
      email: email || undefined,
      code,
      ratePercent: rate || DEFAULT_RATE,
      notes: text(req.body.notes, 300) || undefined,
      createdBy: req.user._id,
    });
    await logAdmin(req, { action: 'referral.create', summary: `Made referral code ${code} for ${name} (${referrer.ratePercent}% of each payment)`, meta: { code } });
    res.status(201).json({ referrer: present(referrer.toObject(), { referred: 0, paying: 0, earned: 0, owed: 0, paid: 0, payments: 0 }) });
  } catch (err) {
    if (err && err.code === 11000) return next(httpError(409, 'That code is already used. Try again.'));
    next(err);
  }
}

async function detail(referrerId) {
  const referrer = await Referrer.findById(referrerId).lean();
  if (!referrer) throw httpError(404, 'Referrer not found');
  await syncCommissions(referrer._id).catch((err) => console.error('Commission sync failed:', err.message));

  const [referrals, commissions, payouts, totals] = await Promise.all([
    Referral.find({ referrer: referrer._id }).sort({ createdAt: -1 }).populate('business', 'name email phone').lean(),
    ReferralCommission.find({ referrer: referrer._id }).sort({ earnedAt: -1 }).limit(200).lean(),
    ReferralPayout.find({ referrer: referrer._id }).sort({ createdAt: -1 }).limit(100).lean(),
    totalsFor([referrer._id]),
  ]);
  const subs = await Subscription.find({ business: { $in: referrals.map((r) => r.business && r.business._id).filter(Boolean) } }).lean();
  const subOf = new Map(subs.map((s) => [String(s.business), s]));
  const earnedBy = new Map();
  commissions.forEach((c) => earnedBy.set(String(c.business), (earnedBy.get(String(c.business)) || 0) + c.amount));

  return {
    referrer: present(referrer, totals.get(String(referrer._id))),
    referred: referrals
      .filter((r) => r.business)
      .map((r) => {
        const s = subOf.get(String(r.business._id));
        const paid = s && s.status === 'active' && s.currentPeriodEnd && new Date(s.currentPeriodEnd) > new Date();
        return {
          _id: r.business._id,
          name: r.business.name,
          email: r.business.email,
          signedUpAt: r.createdAt,
          plan: paid ? (PLANS[s.plan] ? PLANS[s.plan].name : s.plan) : s && s.status === 'active' ? 'Expired' : 'Free trial',
          earned: naira(earnedBy.get(String(r.business._id)) || 0),
        };
      }),
    commissions: commissions.map((c) => ({
      _id: c._id,
      businessName: c.businessName,
      business: c.business,
      plan: PLANS[c.plan] ? PLANS[c.plan].name : c.plan,
      interval: c.interval,
      paymentAmount: naira(c.paymentAmount),
      ratePercent: c.ratePercent,
      amount: naira(c.amount),
      status: c.status,
      earnedAt: c.earnedAt,
      paidAt: c.paidAt,
    })),
    payouts: payouts.map((p) => ({ _id: p._id, amount: naira(p.amount), commissions: p.commissions, note: p.note || '', paidByEmail: p.paidByEmail, createdAt: p.createdAt })),
  };
}

// GET /api/admin/referrers/:id
async function getReferrer(req, res, next) {
  try {
    checkId(req.params.id);
    res.json(await detail(req.params.id));
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/referrers/:id   body: any of { name, phone, email, ratePercent, isActive, notes }
// (the code itself never changes; switch the referrer off to stop it being used. Businesses already referred stay theirs.)
async function updateReferrer(req, res, next) {
  try {
    checkId(req.params.id);
    const b = req.body || {};
    const set = {};
    if (b.name !== undefined) {
      set.name = text(b.name, 80);
      if (!set.name) throw httpError(400, "Enter the referrer's name");
    }
    if (b.phone !== undefined) set.phone = text(b.phone, 30);
    if (b.email !== undefined) set.email = readEmail(b.email);
    if (b.notes !== undefined) set.notes = text(b.notes, 300);
    if (b.ratePercent !== undefined) set.ratePercent = readRate(b.ratePercent) ?? DEFAULT_RATE;
    if (b.isActive !== undefined) set.isActive = Boolean(b.isActive);
    const referrer = await Referrer.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
    if (!referrer) throw httpError(404, 'Referrer not found');
    const summary =
      b.isActive !== undefined
        ? `${referrer.isActive ? 'Switched on' : 'Switched off'} referral code ${referrer.code} (${referrer.name})`
        : `Changed the details of referral code ${referrer.code} (${referrer.name})`;
    await logAdmin(req, { action: 'referral.update', summary, meta: { code: referrer.code, ...set } });
    res.json(await detail(referrer._id));
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/referrers/:id/payout   body: { note? }
// Records that everything the referrer is owed right now has been paid to them.
async function payReferrer(req, res, next) {
  try {
    checkId(req.params.id);
    const referrer = await Referrer.findById(req.params.id);
    if (!referrer) throw httpError(404, 'Referrer not found');
    await syncCommissions(referrer._id).catch(() => {});

    const owed = await ReferralCommission.find({ referrer: referrer._id, status: 'owed' }).select('_id amount').lean();
    const total = owed.reduce((s, c) => s + c.amount, 0);
    if (owed.length === 0 || total <= 0) throw httpError(400, 'Nothing is owed to this referrer right now');

    const payout = await ReferralPayout.create({
      referrer: referrer._id,
      amount: total,
      commissions: owed.length,
      note: text(req.body && req.body.note, 200) || undefined,
      paidByEmail: req.user.email,
    });
    // only the commissions still owed are marked, so two clicks at once never mark one twice
    const result = await ReferralCommission.updateMany(
      { _id: { $in: owed.map((c) => c._id) }, status: 'owed' },
      { $set: { status: 'paid', payout: payout._id, paidAt: new Date() } }
    );
    const done = result.modifiedCount ?? result.nModified ?? owed.length;
    if (done !== owed.length) {
      // something changed between reading and marking: record what was really marked
      const marked = await ReferralCommission.find({ payout: payout._id }).select('amount').lean();
      payout.amount = marked.reduce((s, c) => s + c.amount, 0);
      payout.commissions = marked.length;
      await payout.save();
    }
    await logAdmin(req, { action: 'referral.payout', summary: `Paid ${referrer.name} (code ${referrer.code}) ${naira(payout.amount).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })}`, meta: { code: referrer.code, amount: naira(payout.amount) } });
    res.json(await detail(referrer._id));
  } catch (err) {
    next(err);
  }
}

// People who already have a LogBase account, so the admin can pick a referrer instead of typing them in.
// Matches the person's name, email or phone, or the name of their business. With nothing typed, the newest sign-ups come first.
async function listPeople(req, res, next) {
  try {
    const search = text(req.query.search, 80);
    const filter = {};
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const shops = await Business.find({ name: rx }).select('_id').limit(50).lean();
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { business: { $in: shops.map((b) => b._id) } }];
    }
    const users = await User.find(filter).sort({ createdAt: -1 }).limit(8).select('name email phone role business').lean();
    const shops = await Business.find({ _id: { $in: users.map((u) => u.business) } }).select('name phone').lean();
    const shopById = new Map(shops.map((b) => [String(b._id), b]));
    const emails = users.map((u) => String(u.email || '').toLowerCase()).filter(Boolean);
    const existing = emails.length ? await Referrer.find({ email: { $in: emails } }).select('email code').lean() : [];
    const codeByEmail = new Map(existing.map((r) => [r.email, r.code]));
    res.json({
      items: users.map((u) => {
        const shop = shopById.get(String(u.business));
        const email = String(u.email || '').toLowerCase();
        return {
          _id: u._id,
          name: u.name,
          email,
          phone: u.phone || (shop && shop.phone) || '',
          role: u.role,
          businessName: shop ? shop.name : '',
          existingCode: codeByEmail.get(email) || '',
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPeople, listReferrers, createReferrer, getReferrer, updateReferrer, payReferrer };
