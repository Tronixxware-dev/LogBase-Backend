const Supplier = require('../models/Supplier');
const Purchase = require('../models/Purchase');
const SupplierPayment = require('../models/SupplierPayment');
const mongoose = require('mongoose');
const { httpError } = require('../utils/httpError');
const { normalizePhone, phoneKey } = require('../utils/phone');
const { round2 } = require('../utils/money');
const { canSeeCosts } = require('../utils/permissions');
const { supplierForUser, suppliersForUser, purchasesForUser } = require('../utils/staffView');
const { logActivity } = require('../utils/audit');

function money(n) {
  return `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function validId(id) {
  return mongoose.isValidObjectId(id);
}

const MAX_AMOUNT = 1e12;
const EDITABLE_FIELDS = ['name', 'phone', 'email', 'address', 'notes'];

// Takes only the fields a supplier may set from the request, and checks the phone number.
function pickSupplierFields(body) {
  const data = {};
  EDITABLE_FIELDS.forEach((field) => {
    if (body[field] !== undefined) data[field] = body[field];
  });
  if (typeof data.phone === 'string' && data.phone.trim() !== '') data.phone = normalizePhone(data.phone);
  else if (data.phone !== undefined) data.phone = '';

  // the email is optional, but if it is given it must look like an email address
  if (data.email !== undefined) {
    data.email = String(data.email || '').trim().toLowerCase();
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      throw httpError(400, 'Enter a valid email address, or leave it empty');
    }
  }
  return data;
}

// One phone number belongs to one supplier in a business.
async function assertPhoneIsFree(businessId, phone, ignoreId) {
  if (!phone) return;
  const key = phoneKey(phone);
  const others = await Supplier.find({ business: businessId, phone: { $exists: true, $ne: '' } }).select('name phone');
  const clash = others.find((s) => String(s._id) !== String(ignoreId) && phoneKey(s.phone) === key);
  if (clash) throw httpError(409, `${clash.name} is already saved with this phone number.`);
}

async function listSuppliers(req, res, next) {
  try {
    const suppliers = await Supplier.find({ business: req.businessId }).sort({ name: 1 });
    res.json({ suppliers: suppliersForUser(req, suppliers) });
  } catch (err) {
    next(err);
  }
}

async function getSupplier(req, res, next) {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ message: 'Supplier not found' });
    const supplier = await Supplier.findOne({ _id: req.params.id, business: req.businessId });
    if (!supplier) return res.status(404).json({ message: 'Supplier not found' });

    const purchases = await Purchase.find({ supplier: supplier._id, business: req.businessId })
      .populate('product', 'name')
      .sort({ date: -1 });

    // what has been paid to this supplier is for the administrator only
    const payments = canSeeCosts(req.user)
      ? await SupplierPayment.find({ supplier: supplier._id, business: req.businessId }).sort({ date: -1, _id: -1 })
      : undefined;

    res.json({ supplier: supplierForUser(req, supplier), purchases: purchasesForUser(req, purchases), ...(payments ? { payments } : {}) });
  } catch (err) {
    next(err);
  }
}

async function createSupplier(req, res, next) {
  try {
    const data = pickSupplierFields(req.body);
    if (!data.name || !String(data.name).trim()) throw httpError(400, 'Supplier name is required');
    await assertPhoneIsFree(req.businessId, data.phone);

    // What was already owed to this supplier before LogBase. Only the administrator can enter it.
    let opening = 0;
    if (canSeeCosts(req.user) && req.body.openingBalance !== undefined && req.body.openingBalance !== null && req.body.openingBalance !== '') {
      opening = Number(req.body.openingBalance);
      if (!Number.isFinite(opening) || opening < 0 || opening > MAX_AMOUNT) {
        throw httpError(400, 'Enter what you already owe this supplier as a number, or leave it empty');
      }
      opening = round2(opening);
    }

    const supplier = await Supplier.create({ ...data, business: req.businessId, openingBalance: opening, balance: opening });
    if (opening > 0) {
      logActivity(req, {
        action: 'payment.supplier_opening',
        summary: `Added supplier ${supplier.name} owing ${money(opening)} from before`,
        entityType: 'Supplier',
        entityId: supplier._id,
        meta: { openingBalance: opening },
      });
    }
    res.status(201).json({ supplier: supplierForUser(req, supplier) });
  } catch (err) {
    next(err);
  }
}

async function updateSupplier(req, res, next) {
  try {
    const data = pickSupplierFields(req.body);
    await assertPhoneIsFree(req.businessId, data.phone, req.params.id);

    const supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, business: req.businessId },
      data,
      { new: true, runValidators: true }
    );
    if (!supplier) return res.status(404).json({ message: 'Supplier not found' });
    res.json({ supplier: supplierForUser(req, supplier) });
  } catch (err) {
    next(err);
  }
}

// POST /api/suppliers/:id/payments   body: { amount, note }   (administrator only)
// Pays off some of what the business owes this supplier. More than what is owed is refused.
// The balance is lowered in one atomic step that only goes through while enough is owed, so two payments
// recorded at the same moment can never take the balance below zero.
async function recordPayment(req, res, next) {
  let lowered = 0;
  let supplierId = null;
  try {
    if (!validId(req.params.id)) throw httpError(404, 'Supplier not found');
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      throw httpError(400, 'Payment amount must be greater than 0');
    }
    const paid = round2(amount);
    if (paid <= 0) throw httpError(400, 'Payment amount must be greater than 0');
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 300) : '';

    let supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, business: req.businessId, balance: { $gte: paid - 0.005 } },
      { $inc: { balance: -paid } },
      { new: true }
    );
    if (!supplier) {
      const exists = await Supplier.findOne({ _id: req.params.id, business: req.businessId });
      if (!exists) throw httpError(404, 'Supplier not found');
      const owed = Math.max(round2(exists.balance || 0), 0);
      throw httpError(400, owed > 0 ? `You only owe ${exists.name} ${money(owed)}. Enter ${money(owed)} or less.` : `You do not owe ${exists.name} anything.`);
    }
    lowered = paid;
    supplierId = supplier._id;

    // keep the balance clean to 2 decimals (this only ever moves it by a fraction of a kobo)
    const tidy = round2(supplier.balance) - supplier.balance;
    if (tidy !== 0) {
      await Supplier.updateOne({ _id: supplier._id }, { $inc: { balance: tidy } });
      supplier.balance = round2(supplier.balance);
    }

    const payment = await SupplierPayment.create({
      business: req.businessId,
      supplier: supplier._id,
      amount: paid,
      note: note || undefined,
      recordedBy: req.user._id,
    });
    lowered = 0;

    logActivity(req, {
      action: 'payment.supplier',
      summary: `Paid ${supplier.name} ${money(paid)}${Math.max(supplier.balance, 0) > 0 ? ` (${money(supplier.balance)} still owed)` : ' (fully settled)'}`,
      entityType: 'Supplier',
      entityId: supplier._id,
      meta: { amount: paid, balance: supplier.balance },
    });

    res.status(201).json({ payment, supplier: supplierForUser(req, supplier) });
  } catch (err) {
    if (lowered > 0 && supplierId) {
      await Supplier.updateOne({ _id: supplierId, business: req.businessId }, { $inc: { balance: lowered } }).catch(() => {});
    }
    next(err);
  }
}

// GET /api/suppliers/:id/statement   (administrator only)
// The account with this supplier as a list, oldest first, with what is owed after each line:
//   an opening balance  what was owed before LogBase
//   a purchase          debit = what the goods cost, credit = what was paid on the day
//   a payment           credit = what was paid later
// The last balance always matches the balance on the supplier's record.
async function getStatement(req, res, next) {
  try {
    if (!validId(req.params.id)) throw httpError(404, 'Supplier not found');
    const supplier = await Supplier.findOne({ _id: req.params.id, business: req.businessId });
    if (!supplier) throw httpError(404, 'Supplier not found');

    const [purchases, payments] = await Promise.all([
      Purchase.find({ supplier: supplier._id, business: req.businessId }).populate('product', 'name').sort({ date: 1, _id: 1 }),
      SupplierPayment.find({ supplier: supplier._id, business: req.businessId }).sort({ date: 1, _id: 1 }),
    ]);

    // lines received together are one entry
    const groups = new Map();
    for (const line of purchases) {
      const key = line.purchaseGroup ? String(line.purchaseGroup) : String(line._id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }

    const entries = [];
    for (const lines of groups.values()) {
      const first = lines[0];
      const total = round2(lines.reduce((sum, l) => sum + (l.totalCost || 0), 0));
      const owedNow = round2(lines.reduce((sum, l) => sum + (l.creditAmount || 0), 0));
      const what = lines
        .map((l) => `${l.quantity} × ${(l.product && l.product.name) || 'Deleted product'}${l.variantLabel ? ` (${l.variantLabel})` : ''}`)
        .join(', ');
      entries.push({
        type: 'purchase',
        date: first.date,
        sort: new Date(first.date).getTime(),
        id: first._id,
        label: what,
        debit: total,
        credit: round2(total - owedNow),
        onCredit: owedNow > 0,
      });
    }
    for (const p of payments) {
      entries.push({
        type: 'payment',
        date: p.date,
        sort: new Date(p.date).getTime(),
        id: p._id,
        label: p.note ? `Payment: ${p.note}` : 'Payment',
        debit: 0,
        credit: round2(p.amount),
      });
    }
    entries.sort((a, b) => a.sort - b.sort || (a.type === b.type ? 0 : a.type === 'purchase' ? -1 : 1));

    const rows = [];
    let running = 0;
    const opening = round2(supplier.openingBalance || 0);
    if (opening > 0) {
      running = opening;
      rows.push({ type: 'opening', date: supplier.createdAt, label: 'Owed from before LogBase', debit: opening, credit: 0, balance: running });
    }
    let bought = 0;
    let paidTotal = 0;
    for (const e of entries) {
      running = round2(running + e.debit - e.credit);
      bought = round2(bought + e.debit);
      paidTotal = round2(paidTotal + e.credit);
      const { sort, ...rest } = e;
      rows.push({ ...rest, balance: running });
    }

    res.json({
      supplier: { _id: supplier._id, name: supplier.name, phone: supplier.phone, email: supplier.email, address: supplier.address },
      balance: round2(supplier.balance || 0),
      entries: rows,
      totals: { bought: round2(bought + opening), paid: paidTotal },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listSuppliers, getSupplier, createSupplier, updateSupplier, recordPayment, getStatement };
