// Checks and cleans one row of an imported file. Pure functions, so they are easy to test.
// Each returns { value } when the row is good, or { error: 'what is wrong' } when it is not.

const { normalizePhone } = require('./phone');

const MAX_MONEY = 1e12;

function text(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Free text keeps its line breaks (notes, descriptions), only the ends are trimmed
function longText(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

// "₦1,500.50" -> 1500.5. Empty -> null (not given). Anything else that is not a number -> NaN.
function parseNumber(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const cleaned = String(v).replace(/[₦,\s]/g, '').replace(/^N(?=\d)/i, '');
  if (cleaned === '') return null;
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : NaN;
}

function cleanProductRow(row) {
  const r = row || {};
  const name = text(r.name, 120);
  if (!name) return { error: 'The name is empty' };

  const sellingPrice = parseNumber(r.sellingPrice);
  if (sellingPrice === null) return { error: 'The selling price is missing' };
  if (Number.isNaN(sellingPrice) || sellingPrice < 0 || sellingPrice > MAX_MONEY) return { error: 'The selling price is not a valid amount' };

  const costPrice = parseNumber(r.costPrice);
  if (costPrice !== null && (Number.isNaN(costPrice) || costPrice < 0 || costPrice > MAX_MONEY)) return { error: 'The cost price is not a valid amount' };

  const quantity = parseNumber(r.quantity);
  if (quantity !== null && (Number.isNaN(quantity) || quantity < 0 || quantity > 1e9 || !Number.isInteger(quantity))) {
    return { error: 'The quantity must be a whole number, 0 or more' };
  }

  const reorderThreshold = parseNumber(r.reorderThreshold);
  if (reorderThreshold !== null && (Number.isNaN(reorderThreshold) || reorderThreshold < 0 || reorderThreshold > 1e9 || !Number.isInteger(reorderThreshold))) {
    return { error: 'The reorder level must be a whole number, 0 or more' };
  }

  const value = { name, sellingPrice };
  if (costPrice !== null) value.costPrice = costPrice;
  value.quantity = quantity === null ? 0 : quantity;
  if (reorderThreshold !== null) value.reorderThreshold = reorderThreshold;
  const sku = text(r.sku, 60); if (sku) value.sku = sku;
  const barcode = text(r.barcode, 60); if (barcode) value.barcode = barcode;
  const brand = text(r.brand, 60); if (brand) value.brand = brand;
  const category = text(r.category, 60); if (category) value.category = category;
  const description = longText(r.description, 500); if (description) value.description = description;
  return { value };
}

// A phone number from a spreadsheet: +2348031234567, 2348031234567, 08031234567 or 8031234567 (Nigerian numbers
// are the default for numbers without a country code).
function importPhone(raw) {
  const t = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!t) return '';
  if (t.startsWith('+')) return normalizePhone(t);
  const digits = t.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) return normalizePhone(`+${digits}`);
  if (digits.startsWith('0') && digits.length === 11) return normalizePhone(`+234${digits.slice(1)}`);
  if (digits.length === 10) return normalizePhone(`+234${digits}`);
  return normalizePhone(`+${digits}`); // lets the normal check explain what is wrong
}

function cleanCustomerRow(row) {
  const r = row || {};
  const name = text(r.name, 120);
  if (!name) return { error: 'The name is empty' };

  let phone = '';
  try {
    phone = importPhone(r.phone);
  } catch (err) {
    return { error: err.message };
  }

  const email = text(r.email, 120);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return { error: 'The email is not valid' };

  const balance = parseNumber(r.balance);
  if (balance !== null && (Number.isNaN(balance) || Math.abs(balance) > MAX_MONEY)) return { error: 'The amount owed is not a valid number' };

  const value = { name };
  if (phone) value.phone = phone;
  if (email) value.email = email;
  const address = text(r.address, 200); if (address) value.address = address;
  const notes = longText(r.notes, 500); if (notes) value.notes = notes;
  if (balance !== null && balance !== 0) value.balance = Math.round(balance * 100) / 100;
  return { value };
}

module.exports = { parseNumber, importPhone, cleanProductRow, cleanCustomerRow };
