const Product = require('../models/Product');
const Customer = require('../models/Customer');
const { ensureCategory } = require('../utils/categories');
const { httpError } = require('../utils/httpError');
const { phoneKey } = require('../utils/phone');
const { logActivity } = require('../utils/audit');
const { entitlements } = require('../utils/billing');
const { cleanProductRow, cleanCustomerRow } = require('../utils/importRows');

const MAX_ROWS = 200; // per request: the page sends bigger files in several requests

function nameKey(name) {
  return String(name).replace(/\s+/g, ' ').trim().toLowerCase();
}

// rows: [{ line, ...fields }]. `line` is the row number in the person's file, used only to report problems.
function readRows(body) {
  const rows = body && body.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, 'There are no rows to import');
  if (rows.length > MAX_ROWS) throw httpError(400, `Send at most ${MAX_ROWS} rows at a time`);
  return rows.map((row, i) => {
    const line = row && Number.isInteger(row.line) && row.line > 0 ? row.line : i + 1;
    return { line, row };
  });
}

function skippedSummary(skipped) {
  return skipped.length ? ` (${skipped.length} skipped)` : '';
}

// POST /api/import/products   body: { rows: [{ line, name, sellingPrice, costPrice, quantity, ... }] }   (administrator only)
// Adds the good rows and reports why each bad row was skipped. A row that is skipped never stops the others.
// Products with a name that already exists, repeated names in the file, and anything over the plan's stock limit are skipped.
async function importProducts(req, res, next) {
  try {
    const items = readRows(req.body);

    const ent = await entitlements(req.businessId);
    const existing = await Product.find({ business: req.businessId, isActive: true }).select('name');
    const taken = new Set(existing.map((p) => nameKey(p.name)));
    let room = ent.limits.stocks == null ? Infinity : Math.max(0, ent.limits.stocks - existing.length);

    const created = [];
    const skipped = [];
    for (const { line, row } of items) {
      const cleaned = cleanProductRow(row);
      const label = (row && typeof row.name === 'string' && row.name.trim().slice(0, 60)) || '';
      if (cleaned.error) { skipped.push({ line, name: label, reason: cleaned.error }); continue; }

      const data = cleaned.value;
      const key = nameKey(data.name);
      if (taken.has(key)) { skipped.push({ line, name: data.name, reason: 'A product with this name already exists' }); continue; }
      if (room < 1) { skipped.push({ line, name: data.name, reason: `Your ${ent.planName} plan allows up to ${ent.limits.stocks} stocks` }); continue; }

      try {
        if (data.category) data.category = (await ensureCategory(req.businessId, data.category)).category.name;
        await Product.create({ ...data, business: req.businessId });
        taken.add(key);
        room -= 1;
        created.push(data.name);
      } catch (err) {
        skipped.push({ line, name: data.name, reason: err.name === 'ValidationError' ? 'Some of the values are not valid' : 'Could not be saved' });
      }
    }

    if (created.length > 0) {
      logActivity(req, {
        action: 'product.import',
        summary: `Imported ${created.length} product${created.length === 1 ? '' : 's'} from a file${skippedSummary(skipped)}.`,
        meta: { created: created.length, skipped: skipped.length },
      });
    }
    res.status(created.length > 0 ? 201 : 200).json({ created: created.length, skipped, total: items.length });
  } catch (err) {
    next(err);
  }
}

// POST /api/import/customers   body: { rows: [{ line, name, phone, email, address, notes, balance }] }   (administrator only)
// `balance` is what the customer already owes (opening balance). Phone numbers already saved are skipped.
async function importCustomers(req, res, next) {
  try {
    const items = readRows(req.body);

    const saved = await Customer.find({ business: req.businessId, phone: { $exists: true, $ne: '' } }).select('phone');
    const phones = new Set(saved.map((c) => phoneKey(c.phone)));

    const created = [];
    const skipped = [];
    let owed = 0;
    for (const { line, row } of items) {
      const cleaned = cleanCustomerRow(row);
      const label = (row && typeof row.name === 'string' && row.name.trim().slice(0, 60)) || '';
      if (cleaned.error) { skipped.push({ line, name: label, reason: cleaned.error }); continue; }

      const data = cleaned.value;
      const key = data.phone ? phoneKey(data.phone) : '';
      if (key && phones.has(key)) { skipped.push({ line, name: data.name, reason: 'This phone number is already saved for a customer' }); continue; }

      try {
        await Customer.create({ ...data, business: req.businessId });
        if (key) phones.add(key);
        owed += data.balance || 0;
        created.push(data.name);
      } catch (err) {
        skipped.push({ line, name: data.name, reason: err.name === 'ValidationError' ? 'Some of the values are not valid' : 'Could not be saved' });
      }
    }

    if (created.length > 0) {
      logActivity(req, {
        action: 'customer.import',
        summary: `Imported ${created.length} customer${created.length === 1 ? '' : 's'} from a file${skippedSummary(skipped)}.`,
        meta: { created: created.length, skipped: skipped.length, openingBalance: Math.round(owed * 100) / 100 },
      });
    }
    res.status(created.length > 0 ? 201 : 200).json({ created: created.length, skipped, total: items.length });
  } catch (err) {
    next(err);
  }
}

module.exports = { importProducts, importCustomers, MAX_ROWS };
