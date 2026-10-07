const Expense = require('../models/Expense');
const { httpError } = require('../utils/httpError');
const { round2 } = require('../utils/money');
const { logActivity } = require('../utils/audit');

const CATEGORIES = {
  rent: 'Rent',
  salaries: 'Salaries and wages',
  transport: 'Transport and fuel',
  power: 'Electricity and generator',
  internet: 'Internet and airtime',
  marketing: 'Marketing and ads',
  packaging: 'Packaging and supplies',
  repairs: 'Repairs and maintenance',
  taxes: 'Taxes, fees and licences',
  other: 'Other',
};
const METHODS = ['cash', 'transfer', 'card', 'other'];
const MAX_AMOUNT = 1e12;
const LIST_LIMIT = 1000;
const DAY = 24 * 60 * 60 * 1000;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function money(n) {
  return `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// "2026-10-05" (what a date box sends) means that day, whatever the time zone: stored at midday UTC.
function parseDay(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00.000Z`) : new Date(text);
  if (Number.isNaN(d.getTime())) throw httpError(400, `${label} is not a valid date`);
  return d;
}

// POST /api/expenses   body: { category, amount, description, date?, paymentMethod? }   (administrator only)
async function createExpense(req, res, next) {
  try {
    const body = req.body || {};
    const category = body.category;
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) throw httpError(400, 'Choose what the money was spent on');

    const amount = round2(Number(body.amount));
    if (body.amount === undefined || body.amount === '' || !Number.isFinite(amount) || amount <= 0) {
      throw httpError(400, 'Enter an amount above 0');
    }
    if (amount > MAX_AMOUNT) throw httpError(400, 'That amount is too large');

    const description = clean(body.description).slice(0, 200);
    if (category === 'other' && !description) throw httpError(400, 'Say what this was for');

    const paymentMethod = body.paymentMethod === undefined || body.paymentMethod === '' ? 'cash' : body.paymentMethod;
    if (!METHODS.includes(paymentMethod)) throw httpError(400, 'Choose how it was paid: cash, transfer or card');

    const now = Date.now();
    const date = parseDay(body.date, 'The date') || new Date(now);
    if (date.getTime() > now + 2 * DAY) throw httpError(400, 'The date cannot be in the future');
    if (date.getTime() < now - 3660 * DAY) throw httpError(400, 'That date is too far back');

    const expense = await Expense.create({
      business: req.businessId,
      category,
      amount,
      description,
      paymentMethod,
      date,
      createdBy: req.user._id,
      createdByName: req.user.name,
    });

    logActivity(req, {
      action: 'expense.create',
      summary: `Recorded an expense of ${money(amount)}: ${CATEGORIES[category]}${description ? ` (${description})` : ''}.`,
      entityType: 'Expense',
      entityId: expense._id,
      meta: { amount, category },
    });

    res.status(201).json({ expense });
  } catch (err) {
    next(err);
  }
}

// GET /api/expenses?from=<date>&to=<date>   (administrator only)
// Newest first, with the total and the total per category for everything that matches.
async function listExpenses(req, res, next) {
  try {
    const filter = { business: req.businessId };
    const from = parseDay(req.query.from, 'from');
    const to = parseDay(req.query.to, 'to');
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    const rows = await Expense.find(filter).sort({ date: -1, createdAt: -1 }).limit(LIST_LIMIT + 1);
    const truncated = rows.length > LIST_LIMIT;
    const expenses = rows.slice(0, LIST_LIMIT);

    let total = 0;
    const byCategory = {};
    for (const e of expenses) {
      total += e.amount;
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
    }

    res.json({
      expenses,
      total: round2(total),
      byCategory: Object.entries(byCategory)
        .map(([category, amount]) => ({ category, label: CATEGORIES[category] || category, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      truncated,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/expenses/:id   (administrator only). For a mistake: the removal is kept in the activity log.
async function deleteExpense(req, res, next) {
  try {
    const expense = await Expense.findOneAndDelete({ _id: req.params.id, business: req.businessId });
    if (!expense) throw httpError(404, 'Expense not found');

    logActivity(req, {
      action: 'expense.delete',
      summary: `Deleted an expense of ${money(expense.amount)}: ${CATEGORIES[expense.category] || expense.category}${expense.description ? ` (${expense.description})` : ''}.`,
      entityType: 'Expense',
      entityId: expense._id,
      meta: { amount: expense.amount, category: expense.category },
    });

    res.json({ message: 'Expense deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { createExpense, listExpenses, deleteExpense, CATEGORIES, METHODS };
