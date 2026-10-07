const Customer = require('../models/Customer');
const CustomerPayment = require('../models/CustomerPayment');
const Sale = require('../models/Sale');
const SaleReturn = require('../models/SaleReturn');
const { round2 } = require('../utils/money');
const { logActivity } = require('../utils/audit');
const { withSellerPhotos } = require('../utils/sellerPhotos');
const { httpError } = require('../utils/httpError');
const { normalizePhone, phoneKey } = require('../utils/phone');
const { customerForUser, customersForUser } = require('../utils/staffView');
const { can } = require('../utils/permissions');

const EDITABLE_FIELDS = ['name', 'phone', 'email', 'address', 'notes'];

// Takes only the fields a customer may set from the request (never the balance), and checks the phone number.
function pickCustomerFields(body) {
  const data = {};
  EDITABLE_FIELDS.forEach((field) => {
    if (body[field] !== undefined) data[field] = body[field];
  });
  if (typeof data.phone === 'string' && data.phone.trim() !== '') data.phone = normalizePhone(data.phone);
  else if (data.phone !== undefined) data.phone = '';
  return data;
}

// One phone number belongs to one customer in a business.
async function assertPhoneIsFree(businessId, phone, ignoreId) {
  if (!phone) return;
  const key = phoneKey(phone);
  const others = await Customer.find({ business: businessId, phone: { $exists: true, $ne: '' } }).select('name phone');
  const clash = others.find((b) => String(b._id) !== String(ignoreId) && phoneKey(b.phone) === key);
  if (clash) throw httpError(409, `${clash.name} is already saved with this phone number.`);
}

async function listCustomers(req, res, next) {
  try {
    const { search } = req.query;
    const filter = { business: req.businessId };
    if (search) filter.name = { $regex: search, $options: 'i' };

    const customers = await Customer.find(filter).sort({ name: 1 });
    res.json({ customers: customersForUser(req, customers) });
  } catch (err) {
    next(err);
  }
}

async function getCustomer(req, res, next) {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, business: req.businessId });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    // Without "Manage customers" only the customer's contact details are sent, not what they owe or their history.
    if (!can(req.user, 'manageCustomers')) return res.json({ customer: customerForUser(req, customer), sales: [], payments: [] });

    const sales = await Sale.find({ customer: customer._id, business: req.businessId })
      .populate('product', 'name')
      .sort({ date: -1 });

    const payments = await CustomerPayment.find({ customer: customer._id, business: req.businessId }).sort({
      date: -1,
    });

    res.json({ customer, sales: await withSellerPhotos(req.businessId, sales), payments });
  } catch (err) {
    next(err);
  }
}

async function createCustomer(req, res, next) {
  try {
    const data = pickCustomerFields(req.body);
    if (!data.name || !String(data.name).trim()) throw httpError(400, 'Customer name is required');
    await assertPhoneIsFree(req.businessId, data.phone);

    const customer = await Customer.create({ ...data, business: req.businessId });
    logActivity(req, {
      action: 'customer.create',
      summary: `Added customer ${customer.name}`,
      entityType: 'Customer',
      entityId: customer._id,
    });
    res.status(201).json({ customer: customerForUser(req, customer) });
  } catch (err) {
    next(err);
  }
}

async function updateCustomer(req, res, next) {
  try {
    const data = pickCustomerFields(req.body);
    await assertPhoneIsFree(req.businessId, data.phone, req.params.id);

    const customer = await Customer.findOneAndUpdate({ _id: req.params.id, business: req.businessId }, data, {
      new: true,
      runValidators: true,
    });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    logActivity(req, {
      action: 'customer.update',
      summary: `Changed the details of customer ${customer.name}`,
      entityType: 'Customer',
      entityId: customer._id,
    });
    res.json({ customer });
  } catch (err) {
    next(err);
  }
}

async function recordPayment(req, res, next) {
  try {
    const { amount, note } = req.body;
    const customer = await Customer.findOne({ _id: req.params.id, business: req.businessId });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Payment amount must be greater than 0' });
    }

    const payment = await CustomerPayment.create({
      business: req.businessId,
      customer: customer._id,
      amount,
      note,
      recordedBy: req.user._id,
    });

    customer.balance -= amount;
    await customer.save();
    logActivity(req, {
      action: 'payment.record',
      summary: `Recorded a payment of ₦${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })} from ${customer.name}`,
      entityType: 'Customer',
      entityId: customer._id,
      meta: { amount: Number(amount) },
    });

    res.status(201).json({ payment, customer });
  } catch (err) {
    next(err);
  }
}


function money(n) {
  return `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// GET /api/customers/:id/statement  (needs "Manage customers")
// The customer's account as a list, oldest first, with the balance after each line:
//   a sale        debit = what it was worth, credit = what they paid on the day
//   a payment     credit = what they paid later
//   a return      credit = what the returned goods were worth, debit = money handed back to them
// A balance from before this list existed is shown as one "Earlier balance" line, so the last
// balance always matches the balance on the customer's record.
async function getStatement(req, res, next) {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, business: req.businessId });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    const [sales, payments, returns] = await Promise.all([
      Sale.find({ customer: customer._id, business: req.businessId }).populate('product', 'name').sort({ date: 1, _id: 1 }),
      CustomerPayment.find({ customer: customer._id, business: req.businessId }).sort({ date: 1, _id: 1 }),
      SaleReturn.find({ customer: customer._id, business: req.businessId }).sort({ date: 1, _id: 1 }),
    ]);

    // lines bought together are one entry
    const groups = new Map();
    for (const line of sales) {
      const key = line.saleGroup ? String(line.saleGroup) : String(line._id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }

    const rows = [];
    for (const lines of groups.values()) {
      const first = lines[0];
      const bought = lines
        .map((l) => {
          const name = (l.product && l.product.name) || 'Item';
          return `${(l.quantity || 0) + (l.returnedQuantity || 0)} × ${name}${l.variantLabel ? ` (${l.variantLabel})` : ''}`;
        })
        .join(', ');
      rows.push({
        type: 'sale',
        date: first.date,
        order: first.createdAt,
        description: `Sale: ${bought}`,
        debit: round2(lines.reduce((s, l) => s + l.totalAmount + (l.returnedAmount || 0), 0)),
        credit: round2(lines.reduce((s, l) => s + l.amountPaid + (l.refundedAmount || 0), 0)),
        ref: String(first._id),
      });
    }
    for (const p of payments) {
      rows.push({
        type: 'payment',
        date: p.date,
        order: p.createdAt,
        description: p.note ? `Payment received (${p.note})` : 'Payment received',
        debit: 0,
        credit: round2(p.amount),
        ref: String(p._id),
      });
    }
    for (const r of returns) {
      const handedBack = r.refundMethod === 'cash' || r.refundMethod === 'transfer' ? r.refundAmount : 0;
      const parts = [];
      if (handedBack > 0) parts.push(`${money(handedBack)} refunded by ${r.refundMethod}`);
      if (r.refundMethod === 'credit' && r.refundAmount > 0) parts.push(`${money(r.refundAmount)} kept as store credit`);
      const goods = (r.items || []).map((i) => `${i.quantity} × ${i.productName || 'Item'}${i.variantLabel ? ` (${i.variantLabel})` : ''}`).join(', ');
      rows.push({
        type: 'return',
        date: r.date,
        order: r.createdAt,
        description: `Return: ${goods}${parts.length ? ` — ${parts.join(', ')}` : ''}`,
        debit: round2(handedBack),
        credit: round2(r.totalValue),
        ref: String(r.sales && r.sales[0]),
      });
    }

    rows.sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.order) - new Date(b.order));

    const net = rows.reduce((s, r) => s + r.debit - r.credit, 0);
    const earlier = round2(customer.balance - net);
    const entries = [];
    if (Math.abs(earlier) >= 0.01) {
      entries.push({
        type: 'earlier',
        date: null,
        description: 'Earlier balance (before these records)',
        debit: earlier > 0 ? earlier : 0,
        credit: earlier < 0 ? -earlier : 0,
      });
    }
    entries.push(...rows);

    let running = 0;
    for (const e of entries) {
      running = round2(running + e.debit - e.credit);
      e.balance = running;
      delete e.order;
    }

    res.json({
      customer: { _id: customer._id, name: customer.name, phone: customer.phone, address: customer.address, balance: customer.balance },
      entries,
      balance: round2(customer.balance),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, recordPayment, getStatement };