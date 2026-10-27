const Product = require('../models/Product');
const { resolveShop, incRow, shopForNewRecord } = require('../utils/shopStock');
const Customer = require('../models/Customer');
const { ensureCategory } = require('../utils/categories');
const { httpError } = require('../utils/httpError');
const { phoneKey } = require('../utils/phone');
const { logActivity } = require('../utils/audit');
const { entitlements, unitsInStock } = require('../utils/billing');
const { cleanProductRow, cleanCustomerRow } = require('../utils/importRows');
const { loadPreferences } = require('../utils/settings');

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
    const shop = await resolveShop(req, undefined, { strict: true });
    const prefs = await loadPreferences(req.businessId);

    const ent = await entitlements(req.businessId);
    // each store has its own products, so a name only clashes with one in the same store
    const sameStore = await Product.find({ business: req.businessId, isActive: true, shop: shop.id || null }).select('name');
    const taken = new Set(sameStore.map((p) => nameKey(p.name)));
    // the plan holds a number of UNITS in stock: each row may add its opening stock only while there is room
    let room = ent.limits.stocks == null ? Infinity : Math.max(0, ent.limits.stocks - (await unitsInStock(req.businessId)));

    const created = [];
    const skipped = [];
    for (const { line, row } of items) {
      const cleaned = cleanProductRow(row);
      const label = (row && typeof row.name === 'string' && row.name.trim().slice(0, 60)) || '';
      if (cleaned.error) { skipped.push({ line, name: label, reason: cleaned.error }); continue; }

      const data = cleaned.value;
      // no low-stock level in the file: the business's usual one
      if (data.reorderThreshold === undefined) data.reorderThreshold = prefs.defaultReorderLevel;
      const key = nameKey(data.name);
      if (taken.has(key)) { skipped.push({ line, name: data.name, reason: 'A product with this name already exists' }); continue; }
      const units = Number(data.quantity) || 0;
      if (units > room) {
        skipped.push({ line, name: data.name, reason: `Your ${ent.planName} plan holds up to ${ent.limits.stocks} units in stock, and this row would go over that` });
        continue;
      }

      try {
        if (data.category) data.category = (await ensureCategory(req.businessId, data.category)).category.name;
        const made = await Product.create({ ...data, business: req.businessId, shop: shop.id || undefined });
        // opening stock goes into the store the person is working in
        if (shop.id && made.quantity > 0) await incRow(req.businessId, made._id, null, shop.id, made.quantity);
        taken.add(key);
        room -= units;
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

    const shop = await shopForNewRecord(req);
    const saved = await Customer.find({ business: req.businessId, shop: shop || null, phone: { $exists: true, $ne: '' } }).select('phone');
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
        await Customer.create({ ...data, business: req.businessId, shop });
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
