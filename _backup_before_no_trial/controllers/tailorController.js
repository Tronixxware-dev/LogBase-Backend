const TailorOrder = require('../models/TailorOrder');
const TailorStyle = require('../models/TailorStyle');
const Measurement = require('../models/Measurement');
const Worker = require('../models/Worker');
const Business = require('../models/Business');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const { cloudinary } = require('../config/cloudinary');
const { httpError } = require('../utils/httpError');
const { variantLabel } = require('../utils/variants');
const { round2 } = require('../utils/money');
const { can, canSeeCosts } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');
const { notifyOwners } = require('../utils/notifications');
const { createNumbered } = require('../utils/sequence');
const { assertCanAddOrder } = require('../utils/billing');
const { resolveShop, takeStock: takeStockFrom, putStock, quantityInShop, applyShopFilter } = require('../utils/shopStock');
const { recordEarning, removeEarning, removeEarningsOf } = require('../utils/workerLedger');
const { STANDARD_STYLES } = require('../utils/tailorStyles');
const {
  clean,
  cleanLong,
  money,
  parseDay,
  readMoney,
  readMethod,
  paymentEntry,
  readPaymentKey,
  isIdText,
  balanceOf,
  jobCode,
  numberFromSearch,
  escapeRegex,
} = require('../utils/jobHelpers');

const STATUSES = TailorOrder.STATUSES;
const STATUS_LABELS = {
  received: 'Received',
  cutting: 'Cutting',
  sewing: 'Sewing',
  fitting: 'Fitting',
  finishing: 'Finishing',
  ready: 'Ready for pick-up',
  delivered: 'Delivered',
};
const OPEN_STATUSES = STATUSES.filter((s) => s !== 'delivered');
const LIST_LIMIT = 300;
const MAX_PIECES = 20;
const MAX_MATERIALS = 50;
const MAX_PHOTOS = 12;
const MAX_MEASURES = 40;

const code = (order) => jobCode('T', order.number);

/* ---------- how an order is sent to the app ---------- */

function view(req, order) {
  const out = typeof order.toObject === 'function' ? order.toObject() : { ...order };
  out.code = code(out);
  out.balance = balanceOf(out.total, out.amountPaid);
  out.pieceCount = (out.pieces || []).reduce((n, p) => n + (p.quantity || 1), 0);
  out.piecesDone = (out.pieces || []).reduce((n, p) => n + (p.done ? p.quantity || 1 : 0), 0);
  if (canSeeCosts(req.user)) {
    out.materialsCost = round2((out.materials || []).reduce((sum, m) => sum + (Number(m.cost) || 0) * m.quantity, 0));
    out.labourCost = round2((out.pieces || []).reduce((sum, p) => sum + (Number(p.pay) || 0), 0));
  } else {
    // what the tailors earn and what the materials cost are for the administrator only
    out.pieces = (out.pieces || []).map((p) => {
      const copy = { ...p };
      delete copy.pay;
      return copy;
    });
    out.materials = (out.materials || []).map((m) => {
      const copy = { ...m };
      delete copy.cost;
      return copy;
    });
  }
  return out;
}

function readClientId(body) {
  if (body.clientId == null || body.clientId === '') return null;
  if (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) throw httpError(400, 'The order id is not valid');
  return body.clientId;
}

async function findCustomer(req, id) {
  if (!isIdText(id)) throw httpError(400, "The customer's phone number is required to take an order");
  const customer = await Customer.findOne({ _id: id, business: req.businessId });
  if (!customer) throw httpError(404, 'Customer not found');
  if (!clean(customer.phone)) throw httpError(400, 'This customer has no phone number. Add their phone number on the Customers page first.');
  return customer;
}

async function loadOrder(req) {
  if (!isIdText(req.params.id)) throw httpError(404, 'Order not found');
  const order = await TailorOrder.findOne({ _id: req.params.id, business: req.businessId });
  if (!order) throw httpError(404, 'Order not found');
  return order;
}

function assertOpen(order) {
  if (order.status === 'delivered') throw httpError(400, 'This order has been delivered, so it can no longer be changed.');
}

/* ---------- pieces and measurements ---------- */

// A list of { name, value } from the app: blank rows are dropped, a name is kept once.
function readMeasures(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw httpError(400, 'The measurements could not be read');
  if (list.length > MAX_MEASURES) throw httpError(400, `At most ${MAX_MEASURES} measurements can be kept for one garment`);
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const name = clean(m.name, 40);
    const value = clean(m.value === undefined || m.value === null ? '' : String(m.value), 16);
    if (!name || !value || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, value });
  }
  return out;
}

function readUnit(value, fallback = 'in') {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'in' && value !== 'cm') throw httpError(400, 'Measurements are in inches or centimetres');
  return value;
}

// The tailor chosen for a piece: must be one of this business's active tailors.
async function findTailor(req, id) {
  if (!isIdText(id)) throw httpError(400, 'The tailor could not be read');
  const worker = await Worker.findOne({ _id: id, business: req.businessId, kind: 'tailor' });
  if (!worker) throw httpError(404, 'Tailor not found');
  if (!worker.isActive) throw httpError(400, `${worker.name} is not working here any more. Choose another tailor.`);
  return worker;
}

// Builds one piece from what the app sent. `base` is the piece as it is now (when editing); only the fields sent are changed.
async function buildPiece(req, body, base) {
  const piece = base ? { ...base } : { quantity: 1, price: 0, fabricFrom: 'customer', measurements: [], pay: 0, done: false };
  if (body.style !== undefined || !base) {
    piece.style = clean(body.style, 80);
    if (!piece.style) throw httpError(400, 'Enter what is to be sewn (for example: Agbada)');
  }
  if (body.quantity !== undefined) {
    const qty = Number(body.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 500) throw httpError(400, 'The number of pieces must be a whole number of 1 or more');
    piece.quantity = qty;
  }
  if (body.price !== undefined) piece.price = readMoney(body.price, 'The price', { fallback: 0 });
  if (body.fabricFrom !== undefined) {
    if (body.fabricFrom !== 'customer' && body.fabricFrom !== 'shop') throw httpError(400, 'Say who supplied the cloth: the customer or the shop');
    piece.fabricFrom = body.fabricFrom;
  }
  if (body.fabric !== undefined) piece.fabric = clean(body.fabric, 120) || undefined;
  if (body.details !== undefined) piece.details = cleanLong(body.details, 500) || undefined;
  if (body.measurements !== undefined) piece.measurements = readMeasures(body.measurements);

  const isOwner = canSeeCosts(req.user);
  const workerChanged = body.worker !== undefined && String(body.worker || '') !== String(piece.worker || '');
  let rate = 0;
  if (body.worker !== undefined) {
    if (body.worker === null || body.worker === '') {
      piece.worker = undefined;
      piece.workerName = undefined;
      piece.pay = 0;
    } else if (workerChanged || !piece.workerName) {
      const tailor = await findTailor(req, body.worker);
      piece.worker = tailor._id;
      piece.workerName = tailor.name;
      rate = tailor.rate || 0;
    }
  }
  if (isOwner && body.pay !== undefined && piece.worker) {
    piece.pay = readMoney(body.pay, 'The pay', { fallback: 0 });
  } else if (workerChanged && piece.worker) {
    // the pay written on the price list for this garment, else the usual pay for this tailor, for the whole line
    let each = rate;
    const listed = await TailorStyle.findOne({ business: req.businessId, name: new RegExp(`^${String(piece.style).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('pay');
    if (listed && listed.pay > 0) each = listed.pay;
    piece.pay = round2(each * (piece.quantity || 1));
  }
  return piece;
}

function pieceLine(p) {
  return round2((Number(p.price) || 0) * (p.quantity || 1));
}

function totalOf(pieces, discount) {
  const sum = round2(pieces.reduce((s, p) => s + pieceLine(p), 0));
  return Math.max(round2(sum - (Number(discount) || 0)), 0);
}

// What the earning for a finished piece is called in the worker's account
function earningText(order, piece) {
  return `${piece.quantity > 1 ? `${piece.quantity} × ` : ''}${piece.style} for ${order.customerName} (${code(order)})`;
}

// Marks a piece done and puts what its tailor earned into their account. Returns true when this call is the one that did it.
async function finishPiece(req, order, piece) {
  const now = new Date();
  // (the piece is found by its place in the list and checked by its id, which also works on every database)
  const i = order.pieces.findIndex((p) => String(p._id) === String(piece._id));
  if (i < 0) return false;
  const updated = await TailorOrder.findOneAndUpdate(
    { _id: order._id, business: req.businessId, [`pieces.${i}._id`]: piece._id, [`pieces.${i}.done`]: false },
    { $set: { [`pieces.${i}.done`]: true, [`pieces.${i}.doneAt`]: now } },
    { new: true }
  );
  if (!updated) return false;
  if (piece.worker && piece.pay > 0) {
    await recordEarning(req, {
      worker: piece.worker,
      amount: piece.pay,
      description: earningText(order, piece),
      sourceType: 'order',
      sourceId: order._id,
      sourceCode: code(order),
      pieceId: piece._id,
    });
  }
  return true;
}

/* ---------- materials from stock ---------- */

function unitCostOf(product, variant) {
  if (variant && variant.costPrice != null) return Number(variant.costPrice) || 0;
  return Number(product.costPrice) || 0;
}

async function takeStock(businessId, product, variant, qty, shop) {
  const what = variant ? `${product.name} (${variantLabel(variant)})` : product.name;
  await takeStockFrom({
    businessId,
    product,
    variant,
    qty,
    shop,
    requireActive: true,
    notEnough: `Not enough stock for ${what}. Someone may have just used the last ones.`,
  });
}

async function putStockBack(businessId, material) {
  if (!material.product) return;
  await putStock({ businessId, productId: material.product, variantId: material.variant || null, qty: material.quantity, shopId: material.shop || null }).catch(() => {});
}

/* ---------- reading the list ---------- */

// "2026-10-05" from the app (the person's own today), otherwise today by the server's clock
function todayKey(req) {
  const given = req.query && req.query.today;
  return typeof given === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(given) ? given : new Date().toISOString().slice(0, 10);
}
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const addDaysKey = (key, n) => new Date(new Date(`${key}T12:00:00.000Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

// GET /api/tailor?status=open&search=ada&customer=<id>
async function listOrders(req, res, next) {
  try {
    const filter = { business: req.businessId };
    await applyShopFilter(req, filter);
    const scope = { business: req.businessId };
    if (filter.shop !== undefined) scope.shop = filter.shop;
    if (req.query.status === 'open') {
      filter.status = { $in: OPEN_STATUSES };
    } else if (req.query.status !== undefined && req.query.status !== '' && req.query.status !== 'all') {
      if (!STATUSES.includes(req.query.status)) throw httpError(400, 'Unknown status');
      filter.status = req.query.status;
    }
    if (req.query.customer !== undefined && req.query.customer !== '') {
      if (!isIdText(req.query.customer)) throw httpError(400, 'Unknown customer');
      filter.customer = req.query.customer;
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      const or = [{ customerName: rx }, { customerPhone: rx }, { occasion: rx }, { 'pieces.style': rx }, { 'pieces.workerName': rx }];
      const number = numberFromSearch(search, 'T');
      if (number !== null) or.push({ number });
      filter.$or = or;
    }

    const rows = await TailorOrder.find(filter).sort({ receivedAt: -1, number: -1 }).limit(LIST_LIMIT + 1);
    const truncated = rows.length > LIST_LIMIT;

    const seesMoney = can(req.user, 'viewInsights');
    const all = await TailorOrder.find(scope).select('status total amountPaid').lean();
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let owed = 0;
    for (const o of all) {
      if (o.status in counts) counts[o.status] += 1;
      if (OPEN_STATUSES.includes(o.status)) owed += Math.max((o.total || 0) - (o.amountPaid || 0), 0);
    }
    const out = { orders: rows.slice(0, LIST_LIMIT).map((o) => view(req, o)), counts, truncated };
    if (seesMoney) {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const taken = await TailorOrder.aggregate([
        { $match: scope },
        { $unwind: '$payments' },
        { $match: { 'payments.at': { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$payments.amount' } } },
      ]);
      out.summary = { owed: round2(owed), receivedThisMonth: round2(taken.length ? taken[0].total : 0) };
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
}

// GET /api/tailor/overview?today=2026-10-05: what needs attention today
async function overview(req, res, next) {
  try {
    const scope = { business: req.businessId };
    await applyShopFilter(req, scope);
    const today = todayKey(req);
    const week = addDaysKey(today, 7);
    const open = await TailorOrder.find({ ...scope, status: { $in: OPEN_STATUSES } })
      .select('number customerName customerPhone dueDate status total amountPaid receivedAt readyAt pieces fittings occasion')
      .lean();

    const brief = (o) => ({
      _id: o._id,
      code: code(o),
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      dueDate: o.dueDate || null,
      status: o.status,
      balance: balanceOf(o.total, o.amountPaid),
      what: (o.pieces || []).map((p) => `${p.quantity > 1 ? `${p.quantity} × ` : ''}${p.style}`).join(', '),
      piecesDone: (o.pieces || []).filter((p) => p.done).length,
      pieces: (o.pieces || []).length,
    });
    const byDue = (a, b) => String(a.dueDate || '9').localeCompare(String(b.dueDate || '9'));

    const notReady = open.filter((o) => o.status !== 'ready');
    const overdue = notReady.filter((o) => o.dueDate && dayKey(o.dueDate) < today).sort(byDue);
    const dueToday = notReady.filter((o) => o.dueDate && dayKey(o.dueDate) === today);
    const dueSoon = notReady.filter((o) => o.dueDate && dayKey(o.dueDate) > today && dayKey(o.dueDate) <= week).sort(byDue);
    const readyWaiting = open.filter((o) => o.status === 'ready').sort((a, b) => new Date(a.readyAt || 0) - new Date(b.readyAt || 0));

    const fittings = [];
    for (const o of open) {
      for (const f of o.fittings || []) {
        if (f.status !== 'scheduled') continue;
        const k = dayKey(f.at);
        if (k <= addDaysKey(today, 14)) fittings.push({ _id: f._id, order: o._id, code: code(o), customerName: o.customerName, customerPhone: o.customerPhone, at: f.at, note: f.note || '', late: k < today });
      }
    }
    fittings.sort((a, b) => new Date(a.at) - new Date(b.at));

    // how much each tailor still has to sew
    const load = new Map();
    for (const o of open) {
      for (const p of o.pieces || []) {
        if (p.done || !p.workerName) continue;
        const key = String(p.worker);
        const row = load.get(key) || { worker: p.worker, name: p.workerName, pieces: 0 };
        row.pieces += p.quantity || 1;
        load.set(key, row);
      }
    }
    const unassigned = open.reduce((n, o) => n + (o.pieces || []).filter((p) => !p.done && !p.worker).reduce((m, p) => m + (p.quantity || 1), 0), 0);

    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const o of open) counts[o.status] += 1;
    const out = {
      counts,
      openCount: open.length,
      overdue: overdue.slice(0, 8).map(brief),
      overdueCount: overdue.length,
      dueToday: dueToday.map(brief),
      dueSoon: dueSoon.slice(0, 8).map(brief),
      readyWaiting: readyWaiting.slice(0, 8).map(brief),
      readyCount: readyWaiting.length,
      fittings: fittings.slice(0, 10),
      workload: [...load.values()].sort((a, b) => b.pieces - a.pieces).slice(0, 8),
      unassigned,
    };

    if (can(req.user, 'viewInsights')) {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [taken, booked, delivered] = await Promise.all([
        TailorOrder.aggregate([{ $match: scope }, { $unwind: '$payments' }, { $match: { 'payments.at': { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$payments.amount' } } }]),
        TailorOrder.aggregate([{ $match: { ...scope, receivedAt: { $gte: monthStart } } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } }]),
        TailorOrder.countDocuments({ ...scope, status: 'delivered', deliveredAt: { $gte: monthStart } }),
      ]);
      out.summary = {
        owed: round2(open.reduce((s, o) => s + Math.max((o.total || 0) - (o.amountPaid || 0), 0), 0)),
        receivedThisMonth: round2(taken.length ? taken[0].total : 0),
        ordersThisMonth: booked.length ? booked[0].count : 0,
        billedThisMonth: round2(booked.length ? booked[0].total : 0),
        deliveredThisMonth: delivered,
      };
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
}

async function getOrder(req, res, next) {
  try {
    res.json({ order: view(req, await loadOrder(req)) });
  } catch (err) {
    next(err);
  }
}

/* ---------- taking an order ---------- */

// POST /api/tailor
// body: { customer, occasion?, unit?, pieces: [{ style, quantity?, price?, fabricFrom?, fabric?, details?, measurements?, worker?, pay? }],
//         discount?, deposit?, depositMethod?, dueDate?, notes?, clientId? }
async function createOrder(req, res, next) {
  let clientId = null;
  try {
    const body = req.body || {};
    clientId = readClientId(body);
    if (clientId) {
      const existing = await TailorOrder.findOne({ business: req.businessId, clientId });
      if (existing) {
        if (String(existing.recordedBy) !== String(req.user._id)) throw httpError(409, 'This order id was already used.');
        return res.status(200).json({ duplicate: true, order: view(req, existing) });
      }
    }

    const customer = await findCustomer(req, body.customer);
    if (!Array.isArray(body.pieces) || body.pieces.length === 0) throw httpError(400, 'Add at least one garment to sew');
    if (body.pieces.length > MAX_PIECES) throw httpError(400, `An order can have at most ${MAX_PIECES} garments`);
    const pieces = [];
    for (const raw of body.pieces) pieces.push(await buildPiece(req, raw || {}, null));

    const discount = readMoney(body.discount, 'The discount', { fallback: 0 });
    const subtotal = round2(pieces.reduce((s, p) => s + pieceLine(p), 0));
    if (discount > subtotal) throw httpError(400, 'The discount is more than the price of the garments');
    const total = totalOf(pieces, discount);
    const deposit = readMoney(body.deposit, 'The deposit', { fallback: 0 });
    if (total > 0 && deposit > total) throw httpError(400, 'The deposit is more than the price of the order');
    const method = readMethod(body.depositMethod);
    const dueDate = parseDay(body.dueDate, 'The delivery date');
    const unit = readUnit(body.unit);

    await assertCanAddOrder(req.businessId);

    const now = new Date();
    const takenIn = await resolveShop(req);
    const order = await createNumbered(TailorOrder, req.businessId, 'number', () => ({
      shop: takenIn.id || undefined,
      customer: customer._id,
      customerName: customer.name,
      customerPhone: customer.phone,
      occasion: clean(body.occasion, 100) || undefined,
      unit,
      pieces,
      discount,
      total,
      payments: deposit > 0 ? [paymentEntry(req, { amount: deposit, method, kind: 'deposit' })] : [],
      amountPaid: deposit,
      status: 'received',
      history: [{ status: 'received', at: now, byName: req.user.name }],
      notes: cleanLong(body.notes, 1000) || undefined,
      receivedAt: now,
      dueDate: dueDate || undefined,
      clientId: clientId || undefined,
      recordedBy: req.user._id,
      recordedByName: req.user.name,
    }));

    logActivity(req, {
      action: 'tailor.create',
      summary: `Took an order from ${customer.name} (${code(order)}): ${pieces.map((p) => `${p.quantity > 1 ? `${p.quantity} × ` : ''}${p.style}`).join(', ')}${total > 0 ? `, ${money(total)}` : ''}${deposit > 0 ? `, deposit ${money(deposit)}` : ''}.`,
      entityType: 'TailorOrder',
      entityId: order._id,
      meta: { number: order.number, total, deposit },
    });
    res.status(201).json({ order: view(req, order) });
  } catch (err) {
    if (clientId && err && err.code === 11000 && err.keyPattern && err.keyPattern.clientId) {
      try {
        const existing = await TailorOrder.findOne({ business: req.businessId, clientId });
        if (existing) return res.status(200).json({ duplicate: true, order: view(req, existing) });
      } catch (lookupErr) {
        // fall through to the original error
      }
    }
    next(err);
  }
}

// PATCH /api/tailor/:id   body: any of { occasion, unit, dueDate, notes, discount }
async function updateOrder(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const body = req.body || {};
    const set = {};
    const unset = {};
    const changes = [];

    if (body.occasion !== undefined) {
      const v = clean(body.occasion, 100);
      if (v) set.occasion = v;
      else unset.occasion = '';
      changes.push('occasion');
    }
    if (body.notes !== undefined) {
      const v = cleanLong(body.notes, 1000);
      if (v) set.notes = v;
      else unset.notes = '';
      changes.push('notes');
    }
    if (body.unit !== undefined) {
      set.unit = readUnit(body.unit);
      changes.push('measuring unit');
    }
    if (body.dueDate !== undefined) {
      const day = parseDay(body.dueDate, 'The delivery date');
      if (day) set.dueDate = day;
      else unset.dueDate = '';
      changes.push('delivery date');
    }

    const filter = { _id: order._id, business: req.businessId, status: { $ne: 'delivered' } };
    if (body.discount !== undefined) {
      const discount = readMoney(body.discount, 'The discount', { fallback: 0 });
      const subtotal = round2(order.pieces.reduce((s, p) => s + pieceLine(p), 0));
      if (discount > subtotal) throw httpError(400, 'The discount is more than the price of the garments');
      const total = totalOf(order.pieces, discount);
      if (total < order.amountPaid) throw httpError(400, `The customer has already paid ${money(order.amountPaid)}, so the price cannot go below that.`);
      filter.amountPaid = { $lte: total };
      filter.total = order.total;
      set.discount = discount;
      set.total = total;
      changes.push(`discount (${money(discount)})`);
    }
    if (changes.length === 0) return res.json({ order: view(req, order) });

    const update = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const updated = await TailorOrder.findOneAndUpdate(filter, update, { new: true });
    if (!updated) throw httpError(409, 'This order was just changed by someone else. Reload it and try again.');

    logActivity(req, { action: 'tailor.update', summary: `Changed order ${code(updated)}: ${changes.join(', ')}.`, entityType: 'TailorOrder', entityId: updated._id });
    res.json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// Saves a new list of pieces (and the price that follows from it), only if nobody changed the price or took money in the meantime.
async function savePieces(req, order, pieces, summary) {
  const total = totalOf(pieces, order.discount);
  if (total < order.amountPaid) throw httpError(400, `The customer has already paid ${money(order.amountPaid)}, so the price of the order cannot go below that.`);
  const updated = await TailorOrder.findOneAndUpdate(
    { _id: order._id, business: req.businessId, status: { $ne: 'delivered' }, amountPaid: order.amountPaid, total: order.total },
    { $set: { pieces, total } },
    { new: true }
  );
  if (!updated) throw httpError(409, 'This order was just changed by someone else. Reload it and try again.');
  logActivity(req, { action: 'tailor.piece', summary, entityType: 'TailorOrder', entityId: updated._id });
  return updated;
}

// POST /api/tailor/:id/pieces   body: a piece
async function addPiece(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    if (order.pieces.length >= MAX_PIECES) throw httpError(400, `An order can have at most ${MAX_PIECES} garments`);
    const piece = await buildPiece(req, req.body || {}, null);
    const pieces = [...order.pieces.map((p) => p.toObject()), piece];
    const updated = await savePieces(req, order, pieces, `Added ${piece.style} to order ${code(order)}.`);
    res.status(201).json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/tailor/:id/pieces/:pieceId   body: any field of a piece
async function updatePiece(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const existing = order.pieces.id(req.params.pieceId);
    if (!existing) throw httpError(404, 'Garment not found on this order');
    const before = existing.toObject();
    const piece = await buildPiece(req, req.body || {}, before);
    const pieces = order.pieces.map((p) => (String(p._id) === String(existing._id) ? piece : p.toObject()));
    const updated = await savePieces(req, order, pieces, `Changed ${piece.style} on order ${code(order)}.`);

    // a finished piece whose tailor or pay changed: the earning moves to the right account
    if (before.done && (String(before.worker || '') !== String(piece.worker || '') || (before.pay || 0) !== (piece.pay || 0) || (before.quantity || 1) !== (piece.quantity || 1) || before.style !== piece.style)) {
      await removeEarning(req.businessId, { sourceType: 'order', sourceId: order._id, pieceId: existing._id });
      if (piece.worker && piece.pay > 0) {
        await recordEarning(req, { worker: piece.worker, amount: piece.pay, description: earningText(order, piece), sourceType: 'order', sourceId: order._id, sourceCode: code(order), pieceId: existing._id });
      }
    }
    res.json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/tailor/:id/pieces/:pieceId   (an order keeps at least one garment)
async function removePiece(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const existing = order.pieces.id(req.params.pieceId);
    if (!existing) throw httpError(404, 'Garment not found on this order');
    if (order.pieces.length <= 1) throw httpError(400, 'An order needs at least one garment. Delete the order instead.');
    const pieces = order.pieces.filter((p) => String(p._id) !== String(existing._id)).map((p) => p.toObject());
    const updated = await savePieces(req, order, pieces, `Removed ${existing.style} from order ${code(order)}.`);
    await removeEarning(req.businessId, { sourceType: 'order', sourceId: order._id, pieceId: existing._id });
    res.json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// POST /api/tailor/:id/pieces/:pieceId/done   body: { done: true|false }
// Done puts what the tailor earned into their account; undoing it takes it back.
async function setPieceDone(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const piece = order.pieces.id(req.params.pieceId);
    if (!piece) throw httpError(404, 'Garment not found on this order');
    const done = !req.body || req.body.done !== false;
    if (done) {
      await finishPiece(req, order, piece.toObject());
    } else {
      const i = order.pieces.findIndex((p) => String(p._id) === String(piece._id));
      const updated = await TailorOrder.findOneAndUpdate(
        { _id: order._id, business: req.businessId, [`pieces.${i}._id`]: piece._id, [`pieces.${i}.done`]: true },
        { $set: { [`pieces.${i}.done`]: false }, $unset: { [`pieces.${i}.doneAt`]: '' } },
        { new: true }
      );
      if (updated) await removeEarning(req.businessId, { sourceType: 'order', sourceId: order._id, pieceId: piece._id });
    }
    logActivity(req, {
      action: 'tailor.piece',
      summary: `${piece.style} on order ${code(order)} ${done ? `is finished${piece.workerName ? ` (by ${piece.workerName})` : ''}` : 'is not finished after all'}.`,
      entityType: 'TailorOrder',
      entityId: order._id,
    });
    res.json({ order: view(req, await loadOrder(req)) });
  } catch (err) {
    next(err);
  }
}

/* ---------- status ---------- */

// POST /api/tailor/:id/status   body: { status, note?, free? }
async function changeStatus(req, res, next) {
  try {
    const next_ = req.body && req.body.status;
    if (!STATUSES.includes(next_)) throw httpError(400, 'Choose a status');

    const order = await loadOrder(req);
    assertOpen(order);
    if (order.status === next_) throw httpError(400, `This order is already "${STATUS_LABELS[next_]}".`);

    if (next_ === 'delivered') {
      const balance = balanceOf(order.total, order.amountPaid);
      if (balance > 0) throw httpError(400, `The customer still owes ${money(balance)}. Record the payment first, then hand over the clothes.`);
      if (order.total <= 0 && order.amountPaid <= 0 && (!req.body || req.body.free !== true)) {
        throw httpError(400, 'No price has been set for this order. Set the price first, or confirm that it is free of charge.');
      }
    }

    // ready or delivered means the sewing is over: every garment is marked finished (and its tailor is credited)
    if (next_ === 'ready' || next_ === 'delivered') {
      for (const p of order.pieces) {
        if (!p.done) await finishPiece(req, order, p.toObject());
      }
    }

    const now = new Date();
    const set = { status: next_ };
    const unset = {};
    if (next_ === 'ready') set.readyAt = now;
    else if (next_ === 'delivered') set.deliveredAt = now;
    else unset.readyAt = '';

    const update = { $set: set, $push: { history: { status: next_, at: now, byName: req.user.name, note: clean(req.body.note, 200) || undefined } } };
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const updated = await TailorOrder.findOneAndUpdate(
      { _id: order._id, business: req.businessId, status: order.status, amountPaid: order.amountPaid, total: order.total },
      update,
      { new: true }
    );
    if (!updated) throw httpError(409, 'This order was just changed by someone else. Reload it and try again.');

    logActivity(req, {
      action: 'tailor.status',
      summary: `Order ${code(updated)} (${updated.customerName}) is now "${STATUS_LABELS[next_]}".`,
      entityType: 'TailorOrder',
      entityId: updated._id,
      meta: { status: next_ },
    });
    if (next_ === 'ready') {
      notifyOwners(
        req.businessId,
        { type: 'jobReady', title: `Order ${code(updated)} is ready`, body: `${updated.customerName}'s clothes are ready for pick-up.`, link: `/dashboard/tailor/${updated._id}` },
        { exceptUserId: req.user._id }
      );
    }
    res.json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

/* ---------- money ---------- */

// POST /api/tailor/:id/payments   body: { amount, method?, note?, paymentKey? }
async function addPayment(req, res, next) {
  try {
    const body = req.body || {};
    const amount = readMoney(body.amount, 'The amount', { min: 0.01 });
    const method = readMethod(body.method);
    const paymentKey = readPaymentKey(body);

    const order = await loadOrder(req);
    if (paymentKey && (order.payments || []).some((p) => p.key === paymentKey)) {
      return res.status(200).json({ duplicate: true, order: view(req, order) });
    }
    assertOpen(order);
    const balance = balanceOf(order.total, order.amountPaid);
    if (order.total > 0 && amount > balance) throw httpError(400, balance > 0 ? `That is more than the balance of ${money(balance)}.` : 'This order is already paid in full.');

    const updated = await TailorOrder.findOneAndUpdate(
      { _id: order._id, business: req.businessId, status: { $ne: 'delivered' }, amountPaid: order.amountPaid, total: order.total },
      { $push: { payments: paymentEntry(req, { amount, method, note: body.note, kind: 'payment', key: paymentKey }) }, $inc: { amountPaid: amount } },
      { new: true }
    );
    if (!updated) throw httpError(409, 'Another payment was just recorded on this order. Check the balance and try again.');

    const exact = round2(updated.payments.reduce((sum, p) => sum + p.amount, 0));
    if (exact !== updated.amountPaid) {
      const tidy = await TailorOrder.findOneAndUpdate({ _id: updated._id, business: req.businessId, amountPaid: updated.amountPaid }, { $set: { amountPaid: exact } }, { new: true });
      if (tidy) updated.amountPaid = tidy.amountPaid;
    }

    logActivity(req, {
      action: 'tailor.payment',
      summary: `Took ${money(amount)} on order ${code(updated)} from ${updated.customerName}${balanceOf(updated.total, updated.amountPaid) > 0 ? `, ${money(balanceOf(updated.total, updated.amountPaid))} still to pay` : ''}.`,
      entityType: 'TailorOrder',
      entityId: updated._id,
      meta: { amount, method },
    });
    res.status(201).json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

/* ---------- materials ---------- */

// POST /api/tailor/:id/materials   body: { product?, variant?, name?, quantity, cost? }
async function addMaterial(req, res, next) {
  let taken = null;
  try {
    const body = req.body || {};
    const qty = Number(body.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) throw httpError(400, 'Enter how much was used');

    const order = await loadOrder(req);
    assertOpen(order);
    if (order.materials.length >= MAX_MATERIALS) throw httpError(400, `An order can list at most ${MAX_MATERIALS} materials.`);

    let material;
    if (body.product) {
      if (!Number.isInteger(qty)) throw httpError(400, 'Stock items are used in whole numbers');
      if (!isIdText(body.product) || (body.variant && !isIdText(body.variant))) throw httpError(400, 'The material could not be read');
      const product = await Product.findOne({ _id: body.product, business: req.businessId, isActive: true });
      if (!product) throw httpError(404, 'Item not found in stock');
      if (product.tracksSerials) throw httpError(400, `${product.name} is tracked by IMEI / serial number, so it cannot be used as a material here.`);

      let variant = null;
      if (product.variants.length > 0) {
        if (!body.variant) throw httpError(400, `Choose which colour / size of ${product.name} was used`);
        variant = product.variants.id(body.variant);
        if (!variant) throw httpError(404, 'Colour / size not found');
      } else if (body.variant) {
        throw httpError(400, `${product.name} has no colours / sizes`);
      }
      const shop = await resolveShop(req, body.shop, { strict: true });
      const available = await quantityInShop(req.businessId, product, variant, shop);
      if (available < qty) throw httpError(400, `Not enough stock for ${product.name}${variant ? ` (${variantLabel(variant)})` : ''}. Only ${available} left.`);

      await takeStock(req.businessId, product, variant, qty, shop);
      taken = { product: product._id, variant: variant ? variant._id : undefined, quantity: qty, shop: shop.id || undefined };
      material = {
        shop: shop.id || undefined,
        name: variant ? `${product.name} (${variantLabel(variant)})` : product.name,
        quantity: qty,
        cost: unitCostOf(product, variant),
        product: product._id,
        variant: variant ? variant._id : undefined,
      };
    } else {
      const name = clean(body.name, 120);
      if (!name) throw httpError(400, 'Enter the name of the material, or choose one from stock');
      material = { name, quantity: round2(qty), cost: canSeeCosts(req.user) ? readMoney(body.cost, 'The cost', { fallback: 0 }) : 0 };
    }
    material.addedAt = new Date();
    material.addedByName = req.user.name;

    const updated = await TailorOrder.findOneAndUpdate(
      { _id: order._id, business: req.businessId, status: { $ne: 'delivered' }, [`materials.${MAX_MATERIALS - 1}`]: { $exists: false } },
      { $push: { materials: material } },
      { new: true }
    );
    if (!updated) throw httpError(409, 'This order was just changed (or delivered). Reload it and try again.');
    taken = null;

    logActivity(req, {
      action: 'tailor.material',
      summary: `Used ${qty} × ${material.name} on order ${code(updated)}${material.product ? ' (taken from stock)' : ''}.`,
      entityType: 'TailorOrder',
      entityId: updated._id,
    });
    res.status(201).json({ order: view(req, updated) });
  } catch (err) {
    if (taken) await putStockBack(req.businessId, taken);
    next(err);
  }
}

// DELETE /api/tailor/:id/materials/:materialId
async function removeMaterial(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const material = order.materials.id(req.params.materialId);
    if (!material) throw httpError(404, 'Material not found on this order');
    const before = await TailorOrder.findOneAndUpdate(
      { _id: order._id, business: req.businessId, status: { $ne: 'delivered' }, 'materials._id': material._id },
      { $pull: { materials: { _id: material._id } } }
    );
    if (!before) throw httpError(409, 'This order was just changed (or delivered). Reload it and try again.');
    await putStockBack(req.businessId, material);
    logActivity(req, {
      action: 'tailor.material',
      summary: `Removed ${material.quantity} × ${material.name} from order ${code(order)}${material.product ? ' (put back in stock)' : ''}.`,
      entityType: 'TailorOrder',
      entityId: order._id,
    });
    res.json({ order: view(req, await loadOrder(req)) });
  } catch (err) {
    next(err);
  }
}

/* ---------- fittings ---------- */

// POST /api/tailor/:id/fittings   body: { at: '2026-10-12', note? }
async function addFitting(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const at = parseDay(req.body && req.body.at, 'The fitting date');
    if (!at) throw httpError(400, 'Choose the day of the fitting');
    if (order.fittings.length >= 20) throw httpError(400, 'An order can have at most 20 fittings.');
    const updated = await TailorOrder.findOneAndUpdate(
      { _id: order._id, business: req.businessId, status: { $ne: 'delivered' } },
      { $push: { fittings: { at, note: clean(req.body.note, 300) || undefined, byName: req.user.name } } },
      { new: true }
    );
    if (!updated) throw httpError(409, 'This order was just changed (or delivered). Reload it and try again.');
    logActivity(req, { action: 'tailor.fitting', summary: `Booked a fitting for ${updated.customerName} (order ${code(updated)}).`, entityType: 'TailorOrder', entityId: updated._id });
    res.status(201).json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/tailor/:id/fittings/:fittingId   body: { status?: 'scheduled'|'done'|'missed', note?, at? }
async function updateFitting(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const fitting = order.fittings.id(req.params.fittingId);
    if (!fitting) throw httpError(404, 'Fitting not found');
    const body = req.body || {};
    const i = order.fittings.findIndex((f) => String(f._id) === String(fitting._id));
    const set = {};
    if (body.status !== undefined) {
      if (!['scheduled', 'done', 'missed'].includes(body.status)) throw httpError(400, 'Unknown fitting status');
      set[`fittings.${i}.status`] = body.status;
    }
    if (body.note !== undefined) set[`fittings.${i}.note`] = clean(body.note, 300);
    if (body.at !== undefined) {
      const at = parseDay(body.at, 'The fitting date');
      if (!at) throw httpError(400, 'Choose the day of the fitting');
      set[`fittings.${i}.at`] = at;
    }
    if (Object.keys(set).length === 0) return res.json({ order: view(req, order) });
    const updated = await TailorOrder.findOneAndUpdate({ _id: order._id, business: req.businessId, status: { $ne: 'delivered' }, [`fittings.${i}._id`]: fitting._id }, { $set: set }, { new: true });
    if (!updated) throw httpError(409, 'This order was just changed (or delivered). Reload it and try again.');
    logActivity(req, {
      action: 'tailor.fitting',
      summary: `Fitting for ${updated.customerName} (order ${code(updated)})${body.status ? ` marked ${body.status}` : ' changed'}.`,
      entityType: 'TailorOrder',
      entityId: updated._id,
    });
    res.json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/tailor/:id/fittings/:fittingId
async function removeFitting(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const updated = await TailorOrder.findOneAndUpdate({ _id: order._id, business: req.businessId, status: { $ne: 'delivered' } }, { $pull: { fittings: { _id: req.params.fittingId } } }, { new: true });
    if (!updated) throw httpError(409, 'This order was just changed (or delivered). Reload it and try again.');
    res.json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

/* ---------- photos ---------- */

// POST /api/tailor/:id/photos   (multipart, field "images")
async function uploadPhotos(req, res, next) {
  const files = req.files || [];
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    if (order.photos.length + files.length > MAX_PHOTOS) throw httpError(400, `An order can have at most ${MAX_PHOTOS} photos.`);
    const photos = files.map((f) => ({ url: f.path, publicId: f.filename }));
    const updated = await TailorOrder.findOneAndUpdate({ _id: order._id, business: req.businessId, status: { $ne: 'delivered' } }, { $push: { photos: { $each: photos } } }, { new: true });
    if (!updated) throw httpError(409, 'This order was just changed (or delivered). Reload it and try again.');
    res.status(201).json({ order: view(req, updated) });
  } catch (err) {
    // the pictures were uploaded but could not be kept: do not leave them behind
    for (const f of files) await cloudinary.uploader.destroy(f.filename).catch(() => {});
    next(err);
  }
}

// DELETE /api/tailor/:id/photos/:photoId
async function deletePhoto(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const photo = order.photos.id(req.params.photoId);
    if (!photo) throw httpError(404, 'Photo not found');
    const updated = await TailorOrder.findOneAndUpdate({ _id: order._id, business: req.businessId }, { $pull: { photos: { _id: photo._id } } }, { new: true });
    await cloudinary.uploader.destroy(photo.publicId).catch(() => {});
    res.json({ order: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

/* ---------- deleting ---------- */

// DELETE /api/tailor/:id   (administrator): an order entered by mistake, before any money is taken
async function deleteOrder(req, res, next) {
  try {
    if (!isIdText(req.params.id)) throw httpError(404, 'Order not found');
    const removed = await TailorOrder.findOneAndDelete({ _id: req.params.id, business: req.businessId, status: { $ne: 'delivered' }, 'payments.0': { $exists: false } });
    if (!removed) {
      const order = await TailorOrder.findOne({ _id: req.params.id, business: req.businessId });
      if (!order) throw httpError(404, 'Order not found');
      throw httpError(400, order.status === 'delivered' ? 'A delivered order cannot be deleted.' : 'Money has been taken on this order, so it cannot be deleted.');
    }
    for (const m of removed.materials) await putStockBack(req.businessId, m);
    await removeEarningsOf(req.businessId, { sourceType: 'order', sourceId: removed._id });
    for (const photo of removed.photos) await cloudinary.uploader.destroy(photo.publicId).catch(() => {});
    logActivity(req, { action: 'tailor.delete', summary: `Deleted order ${code(removed)} (${removed.customerName}).`, entityType: 'TailorOrder', entityId: removed._id });
    res.json({ message: 'Order deleted' });
  } catch (err) {
    next(err);
  }
}

/* ---------- the price list of styles ---------- */

async function seedStyles(businessId) {
  const claimed = await Business.findOneAndUpdate({ _id: businessId, tailorStylesSeeded: { $ne: true } }, { $set: { tailorStylesSeeded: true } });
  if (!claimed) return;
  try {
    await TailorStyle.insertMany(STANDARD_STYLES.map((s) => ({ ...s, business: businessId, price: 0, pay: 0 })), { ordered: false });
  } catch (err) {
    if (!(err && (err.code === 11000 || err.writeErrors))) throw err;
  }
}

function styleView(req, style) {
  const out = typeof style.toObject === 'function' ? style.toObject() : { ...style };
  if (!canSeeCosts(req.user)) delete out.pay;
  return out;
}

// GET /api/tailor/styles
async function listStyles(req, res, next) {
  try {
    await seedStyles(req.businessId);
    const rows = await TailorStyle.find({ business: req.businessId }).sort({ isActive: -1, name: 1 });
    res.json({ styles: rows.map((s) => styleView(req, s)) });
  } catch (err) {
    next(err);
  }
}

function readMeasureNames(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw httpError(400, 'The measurements could not be read');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = clean(raw, 40);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (out.length > MAX_MEASURES) throw httpError(400, `At most ${MAX_MEASURES} measurements per garment`);
  return out;
}

// POST /api/tailor/styles   (administrator)   body: { name, price?, pay?, measures? }
async function createStyle(req, res, next) {
  try {
    const body = req.body || {};
    const name = clean(body.name, 80);
    if (!name) throw httpError(400, 'Enter the name of the garment');
    const style = await TailorStyle.create({
      business: req.businessId,
      name,
      price: readMoney(body.price, 'The price', { fallback: 0 }),
      pay: readMoney(body.pay, "The tailor's pay", { fallback: 0 }),
      measures: readMeasureNames(body.measures) || [],
    });
    logActivity(req, { action: 'tailor.style', summary: `Added "${name}" to the price list.`, entityType: 'TailorStyle', entityId: style._id });
    res.status(201).json({ style: styleView(req, style) });
  } catch (err) {
    if (err && err.code === 11000) return next(httpError(400, 'There is already a garment with this name.'));
    next(err);
  }
}

// PATCH /api/tailor/styles/:id   (administrator)
async function updateStyle(req, res, next) {
  try {
    if (!isIdText(req.params.id)) throw httpError(404, 'Garment not found');
    const style = await TailorStyle.findOne({ _id: req.params.id, business: req.businessId });
    if (!style) throw httpError(404, 'Garment not found');
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = clean(body.name, 80);
      if (!name) throw httpError(400, 'The name cannot be empty');
      style.name = name;
    }
    if (body.price !== undefined) style.price = readMoney(body.price, 'The price', { fallback: 0 });
    if (body.pay !== undefined) style.pay = readMoney(body.pay, "The tailor's pay", { fallback: 0 });
    if (body.measures !== undefined) style.measures = readMeasureNames(body.measures);
    if (body.isActive !== undefined) style.isActive = body.isActive === true;
    await style.save();
    logActivity(req, { action: 'tailor.style', summary: `Changed "${style.name}" on the price list.`, entityType: 'TailorStyle', entityId: style._id });
    res.json({ style: styleView(req, style) });
  } catch (err) {
    if (err && err.code === 11000) return next(httpError(400, 'There is already a garment with this name.'));
    next(err);
  }
}

// DELETE /api/tailor/styles/:id   (administrator). Orders keep the name they were made with.
async function deleteStyle(req, res, next) {
  try {
    if (!isIdText(req.params.id)) throw httpError(404, 'Garment not found');
    const removed = await TailorStyle.findOneAndDelete({ _id: req.params.id, business: req.businessId });
    if (!removed) throw httpError(404, 'Garment not found');
    logActivity(req, { action: 'tailor.style', summary: `Removed "${removed.name}" from the price list.`, entityType: 'TailorStyle', entityId: removed._id });
    res.json({ message: 'Garment removed' });
  } catch (err) {
    next(err);
  }
}

/* ---------- customers' saved measurements ---------- */

// GET /api/tailor/measurements?customer=<id>&search=ada
async function listMeasurements(req, res, next) {
  try {
    const filter = { business: req.businessId };
    if (req.query.customer !== undefined && req.query.customer !== '') {
      if (!isIdText(req.query.customer)) throw httpError(400, 'Unknown customer');
      filter.customer = req.query.customer;
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      const customers = await Customer.find({ business: req.businessId, $or: [{ name: rx }, { phone: rx }] }).select('_id').limit(200).lean();
      filter.$or = [{ label: rx }, { customer: { $in: customers.map((c) => c._id) } }];
    }
    const rows = await Measurement.find(filter).sort({ measuredAt: -1 }).limit(300).populate('customer', 'name phone');
    const sets = rows.map((m) => {
      const o = m.toObject();
      o.customerName = m.customer ? m.customer.name : '';
      o.customerPhone = m.customer ? m.customer.phone : '';
      o.customer = m.customer ? m.customer._id : m.customer;
      return o;
    });
    res.json({ measurements: sets });
  } catch (err) {
    next(err);
  }
}

// PUT /api/tailor/measurements   body: { customer, label?, unit?, values: [{ name, value }], notes? }
// Saves a set for the customer; a set with the same label is replaced.
async function saveMeasurement(req, res, next) {
  try {
    const body = req.body || {};
    if (!isIdText(body.customer)) throw httpError(400, 'Choose the customer');
    const customer = await Customer.findOne({ _id: body.customer, business: req.businessId });
    if (!customer) throw httpError(404, 'Customer not found');
    const label = clean(body.label, 60) || 'Main';
    const values = readMeasures(body.values);
    if (values.length === 0) throw httpError(400, 'Enter at least one measurement');
    const saved = await Measurement.findOneAndUpdate(
      { business: req.businessId, customer: customer._id, label },
      { $set: { unit: readUnit(body.unit), values, notes: cleanLong(body.notes, 300) || undefined, measuredAt: new Date(), recordedByName: req.user.name } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    logActivity(req, { action: 'tailor.measurement', summary: `Saved ${customer.name}'s measurements ("${label}").`, entityType: 'Measurement', entityId: saved._id });
    res.json({ measurement: { ...saved.toObject(), customerName: customer.name, customerPhone: customer.phone } });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/tailor/measurements/:id
async function deleteMeasurement(req, res, next) {
  try {
    if (!isIdText(req.params.id)) throw httpError(404, 'Measurements not found');
    const removed = await Measurement.findOneAndDelete({ _id: req.params.id, business: req.businessId });
    if (!removed) throw httpError(404, 'Measurements not found');
    logActivity(req, { action: 'tailor.measurement', summary: `Deleted a set of saved measurements ("${removed.label}").`, entityType: 'Measurement', entityId: removed._id });
    res.json({ message: 'Measurements deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listOrders,
  overview,
  getOrder,
  createOrder,
  updateOrder,
  addPiece,
  updatePiece,
  removePiece,
  setPieceDone,
  changeStatus,
  addPayment,
  addMaterial,
  removeMaterial,
  addFitting,
  updateFitting,
  removeFitting,
  uploadPhotos,
  deletePhoto,
  deleteOrder,
  listStyles,
  createStyle,
  updateStyle,
  deleteStyle,
  listMeasurements,
  saveMeasurement,
  deleteMeasurement,
  STATUSES,
};
