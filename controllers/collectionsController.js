const LaundryOrder = require('../models/LaundryOrder');
const TailorOrder = require('../models/TailorOrder');
const Repair = require('../models/Repair');
const { httpError } = require('../utils/httpError');
const { round2 } = require('../utils/money');
const { can } = require('../utils/permissions');
const { applyWorkingShop } = require('../utils/shopStock');
const { jobCode, numberFromSearch, escapeRegex } = require('../utils/jobHelpers');

// "Money collected": every payment taken on the order-based work (laundry orders, tailor orders, repair jobs),
// for any dates, with the orders taken in the same dates. Lagos time (UTC+1, no daylight saving) decides which day a payment belongs to.
const TIME_ZONE = 'Africa/Lagos';
const MAX_DAYS = 400;
const LIST_LIMIT = 1000;
const ORDER_CAP = 5000;
const METHODS = ['cash', 'transfer', 'card', 'other'];

const SOURCES = {
  laundry: { model: LaundryOrder, code: 'L', label: 'Laundry', dateField: 'dateIn', totalField: 'totalAmount', extra: '' },
  tailor: { model: TailorOrder, code: 'T', label: 'Tailor', dateField: 'receivedAt', totalField: 'total', extra: '' },
  repair: { model: Repair, code: 'R', label: 'Repair', dateField: 'receivedAt', totalField: 'quote', extra: 'device imei' },
};

const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
const DAY_MS = 24 * 60 * 60 * 1000;

function readDay(value, label) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(400, `${label} must be a date (YYYY-MM-DD)`);
  const d = new Date(`${text}T00:00:00+01:00`);
  if (Number.isNaN(d.getTime())) throw httpError(400, `${label} is not a valid date`);
  return { text, date: d };
}

async function collected(req, res, next) {
  try {
    const seesAll = can(req.user, 'viewInsights', 'viewAllSales');

    // the dates (default: this month so far)
    const today = dayKey(new Date());
    const fromText = req.query.from ? String(req.query.from) : `${today.slice(0, 8)}01`;
    const toText = req.query.to ? String(req.query.to) : today;
    const from = readDay(fromText, 'From');
    const to = readDay(toText, 'To');
    if (to.date < from.date) throw httpError(400, 'The "to" date is before the "from" date');
    const end = new Date(to.date.getTime() + DAY_MS); // up to the end of the "to" day
    if ((end - from.date) / DAY_MS > MAX_DAYS) throw httpError(400, `Choose a period of up to ${MAX_DAYS} days`);

    const source = req.query.source && req.query.source !== 'all' ? String(req.query.source) : 'all';
    if (source !== 'all' && !SOURCES[source]) throw httpError(400, 'Unknown source');
    const method = req.query.method && req.query.method !== 'all' ? String(req.query.method) : 'all';
    if (method !== 'all' && !METHODS.includes(method)) throw httpError(400, 'Unknown payment method');
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    const me = String(req.user._id);

    const keys = source === 'all' ? Object.keys(SOURCES) : [source];
    const rows = [];
    const byMethod = {};
    const bySource = {};
    const byDay = {};
    let total = 0;
    let count = 0;
    let truncated = false;
    const taken = { count: 0, value: 0, owing: 0 };

    for (const key of keys) {
      const src = SOURCES[key];
      const base = { business: req.businessId };
      await applyWorkingShop(req, base); // the store being worked in (?shop=all = every store)

      const searchOr = [];
      if (search) {
        const rx = { $regex: escapeRegex(search), $options: 'i' };
        searchOr.push({ customerName: rx }, { customerPhone: rx });
        if (key === 'repair') searchOr.push({ device: rx }, { imei: rx });
        const number = numberFromSearch(search, src.code);
        if (number !== null) searchOr.push({ number });
      }

      const matchPay = { at: { $gte: from.date, $lt: end } };
      if (method !== 'all') matchPay.method = method;
      if (!seesAll) matchPay.recordedBy = req.user._id; // a worker sees only the money they took themselves
      const payFilter = { ...base, payments: { $elemMatch: matchPay } };
      if (searchOr.length) payFilter.$or = searchOr;

      const orders = await src.model
        .find(payFilter)
        .select(`number customerName customerPhone payments ${src.extra}`)
        .sort({ number: -1 })
        .limit(ORDER_CAP + 1)
        .lean();
      if (orders.length > ORDER_CAP) {
        truncated = true;
        orders.length = ORDER_CAP;
      }

      let sourceTotal = 0;
      let sourceCount = 0;
      for (const o of orders) {
        for (const [i, p] of (o.payments || []).entries()) {
          const at = new Date(p.at);
          if (at < from.date || at >= end) continue;
          if (method !== 'all' && p.method !== method) continue;
          if (!seesAll && String(p.recordedBy || '') !== me) continue;
          const amount = round2(p.amount);
          total += amount;
          count += 1;
          sourceTotal += amount;
          sourceCount += 1;
          const m = p.method || 'cash';
          byMethod[m] = round2((byMethod[m] || 0) + amount);
          const day = dayKey(at);
          byDay[day] = round2((byDay[day] || 0) + amount);
          rows.push({
            id: `${key}-${o._id}-${i}`,
            at,
            source: key,
            sourceLabel: src.label,
            orderId: String(o._id),
            code: jobCode(src.code, o.number),
            customer: o.customerName || '',
            phone: o.customerPhone || '',
            detail: key === 'repair' ? o.device || '' : '',
            amount,
            method: m,
            kind: p.kind || 'payment',
            note: p.note || '',
            by: p.recordedByName || '',
          });
        }
      }
      bySource[key] = { label: src.label, amount: round2(sourceTotal), count: sourceCount };

      // the orders taken in the same dates (what was brought in, what it is worth, what is still owed on it)
      if (seesAll) {
        const takenFilter = { ...base, [src.dateField]: { $gte: from.date, $lt: end } };
        if (searchOr.length) takenFilter.$or = searchOr;
        const list = await src.model.find(takenFilter).select(`${src.totalField} amountPaid`).limit(ORDER_CAP).lean();
        for (const o of list) {
          const value = Number(o[src.totalField]) || 0;
          taken.count += 1;
          taken.value += value;
          taken.owing += Math.max(0, value - (Number(o.amountPaid) || 0));
        }
      }
    }

    rows.sort((a, b) => b.at - a.at);
    if (rows.length > LIST_LIMIT) truncated = true;

    const days = Object.keys(byDay)
      .sort()
      .map((day) => ({ day, amount: byDay[day] }));

    res.json({
      from: from.text,
      to: to.text,
      seesAll,
      total: round2(total),
      count,
      byMethod,
      bySource,
      days,
      orders: seesAll ? { count: taken.count, value: round2(taken.value), owing: round2(taken.owing) } : null,
      payments: rows.slice(0, LIST_LIMIT),
      truncated,
    });
  } catch (err) {
    next(err);
  }
}

// The permanent register of orders: every laundry order, tailor order and repair job in the chosen dates, including the ones
// already collected / delivered (which leave the working lists). Dates are the day the order came in, or the day it was collected.
const HISTORY = {
  laundry: { done: 'collected', inField: 'dateIn', doneField: 'collectedAt', totalField: 'totalAmount', fields: 'totalItems handover' },
  tailor: { done: 'delivered', inField: 'receivedAt', doneField: 'deliveredAt', totalField: 'total', fields: 'pieces.name' },
  repair: { done: 'collected', inField: 'receivedAt', doneField: 'collectedAt', totalField: 'quote', fields: 'device imei' },
};

async function history(req, res, next) {
  try {
    const today = dayKey(new Date());
    const fromText = req.query.from ? String(req.query.from) : `${today.slice(0, 8)}01`;
    const toText = req.query.to ? String(req.query.to) : today;
    const from = readDay(fromText, 'From');
    const to = readDay(toText, 'To');
    if (to.date < from.date) throw httpError(400, 'The "to" date is before the "from" date');
    const end = new Date(to.date.getTime() + DAY_MS);
    if ((end - from.date) / DAY_MS > 3700) throw httpError(400, 'Choose a period of up to 10 years');

    const source = req.query.source && req.query.source !== 'all' ? String(req.query.source) : 'all';
    if (source !== 'all' && !SOURCES[source]) throw httpError(400, 'Unknown source');
    const status = ['done', 'open'].includes(req.query.status) ? req.query.status : 'all';
    const basis = req.query.basis === 'done' ? 'done' : 'in'; // which date the range is about
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';

    const keys = source === 'all' ? Object.keys(HISTORY) : [source];
    const rows = [];
    const summary = { count: 0, done: 0, open: 0, value: 0, paid: 0, owing: 0 };
    let truncated = false;

    for (const key of keys) {
      const h = HISTORY[key];
      const src = SOURCES[key];
      const filter = { business: req.businessId };
      await applyWorkingShop(req, filter);

      const dateField = basis === 'done' ? h.doneField : h.inField;
      filter[dateField] = { $gte: from.date, $lt: end };
      if (basis === 'done' || status === 'done') filter.status = h.done;
      else if (status === 'open') filter.status = { $ne: h.done };

      if (search) {
        const rx = { $regex: escapeRegex(search), $options: 'i' };
        const or = [{ customerName: rx }, { customerPhone: rx }];
        if (key === 'repair') or.push({ device: rx }, { imei: rx });
        const number = numberFromSearch(search, src.code);
        if (number !== null) or.push({ number });
        filter.$or = or;
      }

      const orders = await src.model
        .find(filter)
        .select(`number customerName customerPhone status amountPaid ${h.inField} ${h.doneField} ${h.totalField} ${h.fields}`)
        .sort({ [h.inField]: -1, number: -1 })
        .limit(ORDER_CAP + 1)
        .lean();
      if (orders.length > ORDER_CAP) {
        truncated = true;
        orders.length = ORDER_CAP;
      }

      for (const o of orders) {
        const value = Number(o[h.totalField]) || 0;
        const paid = Number(o.amountPaid) || 0;
        const isDone = o.status === h.done;
        const owing = Math.max(0, round2(value - paid));
        summary.count += 1;
        if (isDone) summary.done += 1;
        else summary.open += 1;
        summary.value += value;
        summary.paid += paid;
        summary.owing += owing;
        rows.push({
          id: `${key}-${o._id}`,
          source: key,
          sourceLabel: src.label,
          orderId: String(o._id),
          code: jobCode(src.code, o.number),
          customer: o.customerName || '',
          phone: o.customerPhone || '',
          detail: key === 'repair' ? o.device || '' : key === 'laundry' ? (o.totalItems ? `${o.totalItems} piece${o.totalItems === 1 ? '' : 's'}` : '') : (o.pieces || []).length ? `${o.pieces.length} piece${o.pieces.length === 1 ? '' : 's'}` : '',
          status: o.status,
          done: isDone,
          cameIn: o[h.inField],
          doneAt: isDone ? o[h.doneField] || null : null,
          value,
          paid,
          owing,
        });
      }
    }

    rows.sort((a, b) => new Date(b.cameIn) - new Date(a.cameIn));
    if (rows.length > LIST_LIMIT) truncated = true;

    res.json({
      from: from.text,
      to: to.text,
      summary: { ...summary, value: round2(summary.value), paid: round2(summary.paid), owing: round2(summary.owing) },
      orders: rows.slice(0, LIST_LIMIT),
      truncated,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { collected, history };
