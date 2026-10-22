// Approval policies: the rules the administrator sets (Settings > Approval policies) that make a staff's sale, return or
// stock change wait for an OK. The administrator is never held up. When a request is approved it is carried out exactly as the
// staff entered it, by the same code that would have run it straight away, under the staff's name.

const Approval = require('../models/Approval');
const Business = require('../models/Business');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const User = require('../models/User');
const { cloudinary } = require('../config/cloudinary');
const { httpError } = require('./httpError');
const { logActivity } = require('./audit');
const { notifyOwners, notifyUserId } = require('./notifications');
const { policiesOf } = require('./settings');

const KIND_LABELS = { sale: 'Sale', return: 'Return', stockAdjustment: 'Stock change' };

function money(n) {
  return `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function isId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

// A sale sent with photos carries the sale itself in a JSON `payload` field (same as the sale controller reads it)
function saleBody(req) {
  if (typeof (req.body && req.body.payload) !== 'string') return req.body || {};
  try {
    return JSON.parse(req.body.payload);
  } catch {
    return null;
  }
}

// ---- deciding whether a request needs approval: each returns null (go ahead) or { reasons, summary, facts } ----

async function checkSale(req, policies) {
  const body = saleBody(req);
  if (!body || typeof body !== 'object') return null;
  // an item swap has its own money rules (the old item is part of the payment): not held back
  if (body.tradeIn !== undefined && body.tradeIn !== null && body.tradeIn !== '') return null;

  const raw = Array.isArray(body.items) && body.items.length > 0 ? body.items : [{ product: body.product, variant: body.variant, quantity: body.quantity, unitPrice: body.unitPrice }];
  if (raw.length > 50) return null;
  const ids = raw.map((r) => (r && isId(String(r.product)) ? String(r.product) : null));
  if (ids.some((i) => !i)) return null;

  const products = await Product.find({ _id: { $in: ids }, business: req.businessId });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  let total = 0;
  let listTotal = 0;
  let units = 0;
  for (const r of raw) {
    const product = byId.get(String(r.product));
    const qty = Number(r.quantity);
    const price = Number(r.unitPrice);
    if (!product || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) return null; // the sale itself will be refused with a proper message
    let list = product.sellingPrice;
    if (r.variant && product.variants && product.variants.id) {
      const v = product.variants.id(r.variant);
      if (v && v.sellingPrice != null) list = v.sellingPrice;
    }
    total += qty * price;
    listTotal += qty * list;
    units += qty;
  }
  total = round2(total);
  listTotal = round2(listTotal);

  const paid = body.amountPaid === undefined || body.amountPaid === null || body.amountPaid === '' ? total : Math.min(Math.max(Number(body.amountPaid), 0), total);
  if (!Number.isFinite(paid)) return null;
  const owed = round2(total - paid);

  const reasons = [];
  const facts = { total, owed, units };

  const d = policies.discounts;
  const off = round2(listTotal - total);
  if (d.enabled && off > 0 && listTotal > 0) {
    const percent = round2((off / listTotal) * 100);
    facts.discount = off;
    facts.discountPercent = percent;
    if (percent > d.maxPercent) reasons.push(`Discount of ${percent}% (${money(off)} off the usual price)${d.maxPercent > 0 ? `, above the ${d.maxPercent}% allowed` : ''}`);
  }
  const c = policies.creditSales;
  if (c.enabled && owed > 0 && owed >= c.minAmount) {
    reasons.push(`${money(owed)} left unpaid${c.minAmount > 0 ? ` (rule: ${money(c.minAmount)} or more)` : ''}`);
  }
  if (reasons.length === 0) return null;

  let who = typeof body.customerName === 'string' ? body.customerName.trim() : '';
  if (!who && isId(String(body.customer))) {
    const customer = await Customer.findOne({ _id: body.customer, business: req.businessId }).select('name');
    who = customer ? customer.name : '';
  }
  const what = raw.length === 1 ? `${raw[0].quantity} × ${byId.get(String(raw[0].product)).name}` : `${raw.length} items`;
  return { reasons, summary: `Sale of ${money(total)} (${what})${who ? ` to ${who}` : ''}`, facts };
}

async function checkReturn(req, policies) {
  const rule = policies.returns;
  if (!rule.enabled) return null;
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items || items.length === 0 || items.length > 50) return null;
  const ids = items.map((i) => (i && isId(String(i.sale)) ? String(i.sale) : null));
  if (ids.some((i) => !i)) return null;
  const lines = await Sale.find({ _id: { $in: ids }, business: req.businessId });
  if (lines.length !== new Set(ids).size) return null;
  const byId = new Map(lines.map((l) => [String(l._id), l]));
  let value = 0;
  let units = 0;
  for (const i of items) {
    const qty = Number(i.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    value += qty * byId.get(String(i.sale)).unitPrice;
    units += qty;
  }
  value = round2(value);
  if (value < rule.minAmount) return null;
  const first = lines[0];
  return {
    reasons: [rule.minAmount > 0 ? `Return worth ${money(value)} (rule: ${money(rule.minAmount)} or more)` : 'Every return by staff needs approval'],
    summary: `Return of ${units} ${units === 1 ? 'item' : 'items'} worth ${money(value)}${first.customerName ? ` from ${first.customerName}` : ''}`,
    facts: { value, units },
  };
}

async function checkAdjustment(req, policies) {
  const rule = policies.stockAdjustments;
  if (!rule.enabled) return null;
  const body = req.body || {};
  const qty = Number(body.quantity);
  if (!isId(String(body.product)) || !Number.isFinite(qty) || qty < 0) return null;
  const counted = body.type === 'count';
  // a stock count is the number on the shelf, not a change, so it is always checked
  if (!counted && qty < rule.minUnits) return null;
  const product = await Product.findOne({ _id: body.product, business: req.businessId }).select('name');
  if (!product) return null;
  const labels = { damaged: 'damaged', lost: 'lost', expired: 'expired', stolen: 'stolen', found: 'found', count: 'stock count', other: 'other' };
  const kind = labels[body.type] || 'change';
  return {
    reasons: [counted ? 'Stock counts by staff need approval' : rule.minUnits > 0 ? `${qty} units (rule: ${rule.minUnits} or more)` : 'Every stock change by staff needs approval'],
    summary: counted ? `Stock count: ${qty} × ${product.name}` : `${body.direction === 'in' || body.type === 'found' ? 'Add' : 'Remove'} ${qty} × ${product.name} (${kind})`,
    facts: { units: qty },
  };
}

const CHECKS = { sale: checkSale, return: checkReturn, stockAdjustment: checkAdjustment };

async function destroyPhotos(files) {
  await Promise.all((files || []).map((f) => (f && f.publicId ? cloudinary.uploader.destroy(f.publicId).catch(() => {}) : null)));
}

// Express middleware: put it on a route AFTER the permission check (and, for sales, after the photos were uploaded).
// The administrator, and anyone no rule applies to, goes straight on to the real handler.
function needsApproval(kind) {
  return async (req, res, next) => {
    let verdict = null;
    let policies = null;
    try {
      if (req.user && req.user.role === 'owner') return next();
      const business = await Business.findById(req.businessId).select('approvalPolicies');
      policies = policiesOf(business);
      verdict = await CHECKS[kind](req, policies);
    } catch (err) {
      // the rules must never stop a sale: if they cannot be worked out, the real handler decides (and still checks everything)
      console.error('Approval check failed:', err.message);
      return next();
    }
    if (!verdict) return next();

    const files = (req.files || []).map((f) => ({ url: f.path, publicId: f.filename }));
    try {
      const body = kind === 'sale' ? saleBody(req) : req.body || {};
      const clientId = kind === 'sale' && body && typeof body.clientId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.clientId) ? body.clientId : undefined;

      // an offline sale sent again must not queue a second request
      if (clientId) {
        const same = await Approval.findOne({ business: req.businessId, clientId });
        if (same) {
          await destroyPhotos(files);
          return res.status(202).json(waiting(same));
        }
      }
      const header = req.headers && req.headers['x-shop-id'];
      const approval = await Approval.create({
        business: req.businessId,
        kind,
        requestedBy: req.user._id,
        requestedByName: req.user.name,
        summary: verdict.summary,
        reasons: verdict.reasons,
        facts: verdict.facts,
        payload: body,
        shopId: typeof header === 'string' ? header : undefined,
        files,
        clientId,
      });

      logActivity(req, { action: 'approval.request', summary: `Asked for approval: ${verdict.summary}`, entityType: 'Approval', entityId: approval._id, meta: { kind, reasons: verdict.reasons } });
      notifyOwners(
        req.businessId,
        { type: 'approvals', title: `${req.user.name} needs your approval`, body: `${verdict.summary}. ${verdict.reasons.join('; ')}`, link: '/dashboard/approvals' },
        { exceptUserId: req.user._id }
      );
      return res.status(202).json(waiting(approval));
    } catch (err) {
      await destroyPhotos(files);
      return next(err);
    }
  };
}

function waiting(approval) {
  return {
    approvalRequired: true,
    approval: { _id: approval._id, kind: approval.kind, status: approval.status, summary: approval.summary, reasons: approval.reasons },
    message: 'Sent to the administrator for approval. You will be told when it is answered.',
  };
}

// ---- carrying out an approved request ----

const CONTROLLERS = {
  sale: () => require('../controllers/saleController').createSale,
  return: () => require('../controllers/returnController').createReturn,
  stockAdjustment: () => require('../controllers/stockAdjustmentController').createAdjustment,
};

// Runs the real handler with a copy of the staff's request. Resolves { status, body } or { error }.
function runAs(handler, req) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish({ error: httpError(504, 'This took too long. Try again.') }), 60000);
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set() {
        return this;
      },
      json(body) {
        finish({ status: this.statusCode, body });
        return this;
      },
    };
    Promise.resolve(handler(req, res, (err) => finish({ error: err || httpError(500, 'Something went wrong') }))).catch((err) => finish({ error: err }));
  });
}

function resultOf(kind, body) {
  if (!body) return {};
  if (kind === 'sale' && body.sale) return { resultType: 'Sale', resultId: body.sale._id };
  if (kind === 'return' && body.return) return { resultType: 'SaleReturn', resultId: body.return._id };
  if (kind === 'stockAdjustment' && body.adjustment) return { resultType: 'StockAdjustment', resultId: body.adjustment._id };
  return {};
}

// Approves a waiting request and carries it out. Throws a 4xx when it is not waiting any more.
// If carrying it out fails (the stock is gone, the sale line changed...) the request is marked "failed" with the reason and the staff is told.
async function approve(approvalId, approver) {
  const claimed = await Approval.findOneAndUpdate(
    { _id: approvalId, business: approver.business, status: 'pending' },
    { $set: { status: 'processing' } },
    { new: true }
  );
  if (!claimed) throw httpError(409, 'This request was already answered or taken back.');

  const requester = await User.findOne({ _id: claimed.requestedBy, business: claimed.business });
  let outcome;
  if (!requester || requester.isActive === false) {
    outcome = { error: httpError(400, 'The person who asked is no longer on the team.') };
  } else {
    const fakeReq = {
      user: requester,
      businessId: claimed.business,
      body: claimed.payload || {},
      headers: claimed.shopId ? { 'x-shop-id': claimed.shopId } : {},
      files: (claimed.files || []).map((f) => ({ path: f.url, filename: f.publicId })),
      query: {},
      params: {},
      approvedBy: approver,
      get() {
        return undefined;
      },
    };
    outcome = await runAs(CONTROLLERS[claimed.kind](), fakeReq);
  }

  const now = new Date();
  const ok = !outcome.error && outcome.status >= 200 && outcome.status < 300;
  if (ok) {
    const done = await Approval.findByIdAndUpdate(
      claimed._id,
      { $set: { status: 'approved', decidedBy: approver._id, decidedByName: approver.name, decidedAt: now, ...resultOf(claimed.kind, outcome.body) } },
      { new: true }
    );
    notifyUserId(claimed.business, claimed.requestedBy, { type: 'approvals', title: 'Your request was approved', body: `${claimed.summary}. Approved by ${approver.name}.`, link: '/dashboard/approvals' });
    logActivity({ user: approver, businessId: claimed.business }, { action: 'approval.approve', summary: `Approved ${requester ? requester.name : 'a staff'}'s request: ${claimed.summary}`, entityType: 'Approval', entityId: claimed._id });
    return done;
  }

  const message = (outcome.error && outcome.error.message) || (outcome.body && outcome.body.message) || 'It could not be carried out.';
  const failed = await Approval.findByIdAndUpdate(
    claimed._id,
    { $set: { status: 'failed', decidedBy: approver._id, decidedByName: approver.name, decidedAt: now, failureMessage: String(message).slice(0, 300) } },
    { new: true }
  );
  await destroyPhotos(claimed.files); // a sale that did not happen keeps no photos
  notifyUserId(claimed.business, claimed.requestedBy, { type: 'approvals', title: 'Your request was approved but could not be done', body: `${claimed.summary}: ${message}`, link: '/dashboard/approvals' });
  return failed;
}

async function decline(approvalId, approver, note) {
  const found = await Approval.findOneAndUpdate(
    { _id: approvalId, business: approver.business, status: 'pending' },
    { $set: { status: 'declined', decidedBy: approver._id, decidedByName: approver.name, decidedAt: new Date(), decisionNote: note || undefined } },
    { new: true }
  );
  if (!found) throw httpError(409, 'This request was already answered or taken back.');
  await destroyPhotos(found.files);
  notifyUserId(found.business, found.requestedBy, { type: 'approvals', title: 'Your request was declined', body: `${found.summary}${note ? `. "${note}"` : ''}`, link: '/dashboard/approvals' });
  logActivity({ user: approver, businessId: found.business }, { action: 'approval.decline', summary: `Declined ${found.requestedByName || 'a staff'}'s request: ${found.summary}`, entityType: 'Approval', entityId: found._id });
  return found;
}

// A staff takes back their own request that is still waiting
async function cancel(approvalId, user) {
  const found = await Approval.findOneAndUpdate(
    { _id: approvalId, business: user.business, requestedBy: user._id, status: 'pending' },
    { $set: { status: 'cancelled', decidedAt: new Date() } },
    { new: true }
  );
  if (!found) throw httpError(409, 'This request was already answered or taken back.');
  await destroyPhotos(found.files);
  logActivity({ user, businessId: user.business }, { action: 'approval.cancel', summary: `Took back the request: ${found.summary}`, entityType: 'Approval', entityId: found._id });
  return found;
}

module.exports = { needsApproval, approve, decline, cancel, KIND_LABELS };
