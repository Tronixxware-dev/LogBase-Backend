// Small helpers shared by the repair jobs and the laundry register.

const { httpError } = require('./httpError');
const { round2 } = require('./money');

const METHODS = ['cash', 'transfer', 'card', 'other'];
const MAX_AMOUNT = 1e12;

function clean(value, max = 200) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// Text that may keep its line breaks (notes)
function cleanLong(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
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

// An amount of money: empty means `fallback` (when given); otherwise a number from `min` up to a very large limit.
function readMoney(value, label, { min = 0, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw httpError(400, `${label} is required`);
  }
  const n = round2(Number(value));
  if (!Number.isFinite(n) || n < min) throw httpError(400, `${label} must be ${min > 0 ? `at least ${min}` : '0 or more'}`);
  if (n > MAX_AMOUNT) throw httpError(400, `${label} is too large`);
  return n;
}

function readMethod(value) {
  const method = value === undefined || value === null || value === '' ? 'cash' : value;
  if (!METHODS.includes(method)) throw httpError(400, 'Choose how it was paid: cash, transfer or card');
  return method;
}

// The id the app sends with a payment, so pressing "Record payment" twice (or a lost answer) never takes the money twice.
// Returns null when none was sent.
function readPaymentKey(body) {
  if (body.paymentKey == null || body.paymentKey === '') return null;
  if (typeof body.paymentKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.paymentKey)) throw httpError(400, 'The payment id is not valid');
  return body.paymentKey;
}

// Only a plain 24-character id text is accepted as the id of a record (never an object like {"$ne": null}).
function isIdText(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

// One payment to put on a job: { amount, method, note, at, recordedBy, recordedByName, kind, key }
function paymentEntry(req, { amount, method, note, kind, key }) {
  return {
    amount,
    method,
    note: clean(note, 120) || undefined,
    key: key || undefined,
    kind,
    at: new Date(),
    recordedBy: req.user._id,
    recordedByName: req.user.name,
  };
}

// What is still to be paid on a job: the price minus what has been paid (never below what the numbers say).
function balanceOf(total, paid) {
  return round2(Number(total || 0) - Number(paid || 0));
}

function sumPayments(payments) {
  return round2((payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
}

// The number as people read it: R-0001, L-0012
function jobCode(prefix, number) {
  return `${prefix}-${String(number).padStart(4, '0')}`;
}

// A search box entry that is just a job number ("12", "r12", "R-0012") gives that number, otherwise null.
function numberFromSearch(text, prefix) {
  const m = new RegExp(`^${prefix}?-?0*(\\d{1,9})$`, 'i').exec(String(text).trim());
  return m ? Number(m[1]) : null;
}

// Escapes text so it can be put in a regular expression for a search.
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  METHODS,
  MAX_AMOUNT,
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
  sumPayments,
  escapeRegex,
};
