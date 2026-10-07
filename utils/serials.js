// IMEI / serial numbers: reading what a person typed, and the dates a warranty runs between.

const { httpError } = require('./httpError');

const MAX_PER_LINE = 500;
const MAX_WARRANTY_MONTHS = 120;
const SERIAL_PATTERN = /^[A-Z0-9][A-Z0-9\-_./]{2,39}$/;

// "  35-123456-789012-3 " is not valid, "356938035643809" is: upper case, no spaces, 3 to 40 characters
// of letters, digits and - _ . /. Returns null when it cannot be a serial number.
function normalizeSerial(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim().replace(/\s+/g, '').toUpperCase();
  return SERIAL_PATTERN.test(text) ? text : null;
}

// What the browser sends: a list, or one piece of text with the numbers separated by new lines, commas, semicolons or spaces.
function splitSerials(value) {
  if (value === undefined || value === null || value === '') return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[\s,;]+/);
  return parts.map((p) => (typeof p === 'string' ? p.trim() : p)).filter((p) => p !== '' && p !== undefined && p !== null);
}

// A clean list of serial numbers, or a 400 saying what is wrong. Duplicates inside the list are refused.
// `where` names the line, e.g. "Item 2".
function cleanSerialList(value, where) {
  const parts = splitSerials(value);
  if (parts.length > MAX_PER_LINE) throw httpError(400, `${where}: at most ${MAX_PER_LINE} serial numbers at a time`);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const serial = normalizeSerial(part);
    if (!serial) throw httpError(400, `${where}: "${String(part).slice(0, 45)}" is not a valid IMEI / serial number (3 to 40 letters, digits, - _ . /)`);
    if (seen.has(serial)) throw httpError(400, `${where}: ${serial} is listed twice`);
    seen.add(serial);
    out.push(serial);
  }
  return out;
}

// A warranty length in whole months, 0 (none) to 120. Empty means "use the default".
function readWarrantyMonths(value, fallback, where) {
  if (value === undefined || value === null || value === '') return Number(fallback) || 0;
  const months = Number(value);
  if (!Number.isInteger(months) || months < 0 || months > MAX_WARRANTY_MONTHS) {
    throw httpError(400, `${where}: the warranty must be a whole number of months from 0 to ${MAX_WARRANTY_MONTHS}`);
  }
  return months;
}

// The same day `months` later; 31 January + 1 month is 28 (or 29) February, not 3 March.
function addMonths(date, months) {
  const start = new Date(date);
  const day = start.getUTCDate();
  const out = new Date(start.getTime());
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

// Where a warranty stands today.
function warrantyState(endsAt, now = new Date()) {
  if (!endsAt) return { state: 'none', daysLeft: 0 };
  const ms = new Date(endsAt).getTime() - new Date(now).getTime();
  if (ms < 0) return { state: 'expired', daysLeft: 0 };
  return { state: 'active', daysLeft: Math.ceil(ms / 86400000) };
}

module.exports = { normalizeSerial, splitSerials, cleanSerialList, readWarrantyMonths, addMonths, warrantyState, MAX_WARRANTY_MONTHS };
