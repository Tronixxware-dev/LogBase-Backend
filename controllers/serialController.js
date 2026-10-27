const SerialUnit = require('../models/SerialUnit');
const Product = require('../models/Product');
const { httpError } = require('../utils/httpError');
const { can, canSeeCosts } = require('../utils/permissions');
const { warrantyState } = require('../utils/serials');
const { resolveShop, listShops, quantityInShop } = require('../utils/shopStock');
const Purchase = require('../models/Purchase');
const { normalizeSerial, cleanSerialList } = require('../utils/serials');
const { STATUS_TEXT } = require('../utils/serialUnits');
const { logActivity } = require('../utils/audit');
const { variantLabel } = require('../utils/variants');

const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const MAX_ADD = 200;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One unit as the lookup page shows it. Anyone who can only see their own sales learns nothing about who bought
// a unit somebody else sold, and only the administrator sees what it cost.
function unitView(req, unit, productName) {
  const u = typeof unit.toObject === 'function' ? unit.toObject() : { ...unit };
  const sees = can(req.user, 'viewAllSales', 'viewInsights') || (u.soldBy && String(u.soldBy) === String(req.user._id));
  const warranty = u.status === 'sold' ? { months: u.warrantyMonths || 0, endsAt: u.warrantyEndsAt || null, ...warrantyState(u.warrantyEndsAt) } : null;

  const out = {
    _id: u._id,
    serial: u.serial,
    status: u.status,
    product: { _id: u.product, name: productName || '' },
    variant: u.variant || null,
    variantLabel: u.variantLabel || '',
    supplierName: canSeeCosts(req.user) ? u.supplierName || '' : '',
    receivedAt: u.receivedAt || null,
    soldAt: u.soldAt || null,
    warranty,
    events: (u.events || []).map((e) => ({
      type: e.type,
      at: e.at,
      // a "received" note is the supplier's name, which only the administrator sees
      note: (u.status === 'sold' && !sees) || (e.type === 'received' && !canSeeCosts(req.user)) ? '' : e.note || '',
      ref: sees ? e.ref : undefined,
    })),
  };
  if (canSeeCosts(req.user)) out.costPrice = u.costPrice == null ? null : u.costPrice;
  if (u.status === 'sold' && sees) {
    out.sale = u.sale;
    out.customer = u.customer;
    out.customerName = u.customerName || '';
  }
  return out;
}

// GET /api/serials/lookup?q=356938035643809
// Finds a unit by its full IMEI / serial number, or by any part of it (4 characters or more, e.g. the last digits).
// Answers: what it is, where it came from, whether it is on the shelf, who bought it and whether the warranty still runs.
async function lookup(req, res, next) {
  try {
    const q = String(req.query.q || '').trim().replace(/\s+/g, '').toUpperCase();
    if (q.length < 4) throw httpError(400, 'Type at least 4 characters of the IMEI / serial number');
    if (q.length > 40 || !/^[A-Z0-9\-_./]+$/.test(q)) throw httpError(400, 'That is not a valid IMEI / serial number');

    let units = await SerialUnit.find({ business: req.businessId, serial: q }).limit(1);
    if (units.length === 0) {
      units = await SerialUnit.find({ business: req.businessId, serial: { $regex: escapeRegex(q) } }).sort({ updatedAt: -1 }).limit(20);
    }

    const products = await Product.find({ _id: { $in: units.map((u) => u.product) }, business: req.businessId });
    const nameOf = new Map(products.map((p) => [String(p._id), p.name]));
    // where each unit is, when the business has more than one store
    const shops = await listShops(req.businessId);
    const where = (u) => {
      if (shops.length < 2 || u.status !== 'in_stock') return '';
      if (!u.shop) return (shops.find((x) => x.isMain) || {}).name || '';
      const hit = shops.find((x) => String(x._id) === String(u.shop));
      return hit ? hit.name : 'On its way between stores';
    };
    res.json({ query: q, units: units.map((u) => ({ ...unitView(req, u, nameOf.get(String(u.product))), store: where(u) })) });
  } catch (err) {
    next(err);
  }
}

// GET /api/serials/available?product=<id>&variant=<id>
// The numbers of the units of a product that are on the shelf, so the sale form can offer them.
async function available(req, res, next) {
  try {
    if (!req.query.product) throw httpError(400, 'Choose a product');
    // only the units in the store the person is working in (units of the main store have no store id)
    const shop = await resolveShop(req, req.query.shop);
    const filter = { business: req.businessId, product: String(req.query.product), status: 'in_stock', shop: shop.id || null };
    if (req.query.variant) filter.variant = String(req.query.variant);
    const units = await SerialUnit.find(filter).sort({ receivedAt: 1, createdAt: 1 }).limit(1000);
    res.json({ serials: units.map((u) => u.serial) });
  } catch (err) {
    next(err);
  }
}

// Where a unit is, in words: the store's name, or null while it is on its way between stores.
function storeNameOf(shops, unit) {
  if (!unit.shop) return (shops.find((x) => x.isMain) || {}).name || '';
  const hit = shops.find((x) => String(x._id) === String(unit.shop));
  return hit ? hit.name : null;
}

async function ownProduct(req) {
  if (!isId(req.params.id)) throw httpError(404, 'Product not found');
  const product = await Product.findOne({ _id: req.params.id, business: req.businessId });
  if (!product) throw httpError(404, 'Product not found');
  return product;
}

// GET /api/serials/product/:id
// Every IMEI / serial number recorded for a product, for the product page: which are on the shelf (editable) and which were sold.
// Also says how many of the pieces the store working holds have a number on record.
async function listForProduct(req, res, next) {
  try {
    const product = await ownProduct(req);
    const shops = await listShops(req.businessId);
    const shop = await resolveShop(req, undefined);
    const units = await SerialUnit.find({ business: req.businessId, product: product._id }).sort({ createdAt: -1 }).limit(2000);
    const order = { in_stock: 0, sold: 1, written_off: 2 };
    units.sort((a, b) => (order[a.status] - order[b.status]) || String(a.serial).localeCompare(String(b.serial)));

    const here = (u) => u.status === 'in_stock' && String(u.shop || '') === String(shop.id || '');
    // per colour / size (or for the product as a whole): pieces held here and numbers recorded for them
    const groups = [];
    const parts = product.variants.length > 0 ? product.variants.map((v) => ({ variant: v })) : [{ variant: null }];
    for (const part of parts) {
      const held = await quantityInShop(req.businessId, product, part.variant, shop);
      const recorded = units.filter((u) => here(u) && (part.variant ? String(u.variant || '') === String(part.variant._id) : true)).length;
      groups.push({ variant: part.variant ? part.variant._id : null, label: part.variant ? variantLabel(part.variant) : '', held, recorded });
    }

    res.json({
      tracksSerials: Boolean(product.tracksSerials),
      store: shop.name,
      groups,
      units: units.map((u) => {
        const name = storeNameOf(shops, u);
        return {
          ...unitView(req, u, product.name),
          store: shops.length > 1 && u.status === 'in_stock' ? name || 'On its way between stores' : '',
          inTransit: u.status === 'in_stock' && name === null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/serials/product/:id   body: { serials, variant? }
// Records the numbers of pieces the shop already holds (stock bought before numbers were tracked). The stock count does not
// change: only which pieces they are. No more numbers than the pieces the store holds.
async function addForProduct(req, res, next) {
  try {
    const product = await ownProduct(req);
    if (!product.isActive) throw httpError(400, 'This product is deleted. Bring it back first.');
    if (!product.tracksSerials) throw httpError(400, 'Turn on "Track each item by IMEI / serial number" for this product first.');
    const serials = cleanSerialList((req.body || {}).serials, 'The list');
    if (serials.length === 0) throw httpError(400, 'Type at least one IMEI / serial number');
    if (serials.length > MAX_ADD) throw httpError(400, `Add at most ${MAX_ADD} numbers at a time`);

    let variant = null;
    if (product.variants.length > 0) {
      if (!isId((req.body || {}).variant)) throw httpError(400, 'Choose the colour / size these belong to');
      variant = product.variants.id(req.body.variant);
      if (!variant) throw httpError(400, 'That colour / size is not on this product');
    }

    const shop = await resolveShop(req, undefined, { strict: true });
    const held = await quantityInShop(req.businessId, product, variant, shop);
    const filter = { business: req.businessId, product: product._id, status: 'in_stock', shop: shop.id || null };
    if (variant) filter.variant = variant._id;
    const recorded = await SerialUnit.countDocuments(filter);
    const room = Math.max(0, held - recorded);
    if (serials.length > room) {
      throw httpError(
        400,
        room === 0
          ? `All ${held} piece${held === 1 ? '' : 's'} of ${product.name}${variant ? ` (${variantLabel(variant)})` : ''} in ${shop.name} already have a number. To add one, first record the stock (a purchase or Adjust stock).`
          : `You can add ${room} more number${room === 1 ? '' : 's'} here: ${shop.name} holds ${held} and ${recorded} already ${recorded === 1 ? 'has' : 'have'} one.`
      );
    }

    const found = await SerialUnit.find({ business: req.businessId, serial: { $in: serials } });
    if (found.length > 0) {
      const u = found[0];
      throw httpError(409, `${u.serial} is ${STATUS_TEXT[u.status] || 'already recorded'}. Each IMEI / serial number can be recorded only once.`);
    }

    const now = new Date();
    try {
      await SerialUnit.insertMany(
        serials.map((serial) => ({
          business: req.businessId,
          product: product._id,
          variant: variant ? variant._id : undefined,
          variantLabel: variant ? variantLabel(variant) : undefined,
          shop: shop.id || undefined,
          serial,
          status: 'in_stock',
          receivedAt: now,
          events: [{ type: 'received', at: now, note: 'Added by hand' }],
        }))
      );
    } catch (err) {
      if (err && (err.code === 11000 || (err.writeErrors && err.writeErrors.length))) {
        throw httpError(409, 'One of those numbers was just recorded by someone else. Check them and try again.');
      }
      throw err;
    }
    logActivity(req, {
      action: 'product.update',
      summary: `Recorded ${serials.length} IMEI / serial number${serials.length === 1 ? '' : 's'} for ${product.name}`,
      entityType: 'Product',
      entityId: product._id,
    });
    res.status(201).json({ added: serials.length });
  } catch (err) {
    next(err);
  }
}

async function ownUnit(req) {
  if (!isId(req.params.id)) throw httpError(404, 'That number is not recorded');
  const unit = await SerialUnit.findOne({ _id: req.params.id, business: req.businessId });
  if (!unit) throw httpError(404, 'That number is not recorded');
  return unit;
}

// A unit may only be changed while it is on a shelf or written off; a sold one belongs to a sale (and its warranty).
async function assertEditable(unit, shops, what) {
  if (unit.status === 'sold') {
    throw httpError(409, `${unit.serial} was sold, so it cannot be ${what}. If it came back, record the return first.`);
  }
  if (unit.status === 'in_stock' && storeNameOf(shops, unit) === null) {
    throw httpError(409, `${unit.serial} is on its way between stores. ${what === 'removed' ? 'Remove' : 'Change'} it once the transfer arrives.`);
  }
}

// PUT /api/serials/:id   body: { serial?, variant? }
// Corrects the number typed for a unit that is not sold yet (and/or the colour / size it is under).
async function updateUnit(req, res, next) {
  try {
    const unit = await ownUnit(req);
    const shops = await listShops(req.businessId);
    await assertEditable(unit, shops, 'changed');
    const product = await Product.findOne({ _id: unit.product, business: req.businessId });
    if (!product) throw httpError(404, 'Product not found');

    const body = req.body || {};
    const set = {};
    const notes = [];

    if (body.serial !== undefined) {
      const wanted = normalizeSerial(body.serial);
      if (!wanted) throw httpError(400, 'That is not a valid IMEI / serial number (3 to 40 letters, digits, - _ . /)');
      if (wanted !== unit.serial) {
        const clash = await SerialUnit.findOne({ business: req.businessId, serial: wanted });
        if (clash) throw httpError(409, `${wanted} is ${STATUS_TEXT[clash.status] || 'already recorded'}. Each IMEI / serial number can be recorded only once.`);
        set.serial = wanted;
        notes.push(`Number changed from ${unit.serial} to ${wanted}`);
      }
    }

    if (body.variant !== undefined && String(body.variant || '') !== String(unit.variant || '')) {
      if (product.variants.length === 0) throw httpError(400, 'This product has no colours or sizes');
      const target = isId(body.variant) ? product.variants.id(body.variant) : null;
      if (!target) throw httpError(400, 'That colour / size is not on this product');
      set.variant = target._id;
      set.variantLabel = variantLabel(target);
      notes.push(`Colour / size changed to ${variantLabel(target)}`);
    }

    if (notes.length === 0) return res.json({ unit: unitView(req, unit, product.name) });

    const event = { type: 'edited', at: new Date(), note: notes.join('. ') };
    let saved;
    try {
      saved = await SerialUnit.findOneAndUpdate(
        { _id: unit._id, business: req.businessId, status: unit.status, serial: unit.serial },
        { $set: set, $push: { events: event } },
        { new: true }
      );
    } catch (err) {
      if (err && err.code === 11000) throw httpError(409, 'That number was just recorded by someone else. Check it and try again.');
      throw err;
    }
    if (!saved) throw httpError(409, 'This unit just changed. Reload and try again.');

    // the purchase it came in on keeps the corrected number too
    if (set.serial && unit.purchase) {
      await Purchase.updateOne({ _id: unit.purchase, business: req.businessId, serials: unit.serial }, { $set: { 'serials.$': set.serial } }).catch(() => {});
    }
    logActivity(req, {
      action: 'product.update',
      summary: `Edited an IMEI / serial number of ${product.name}: ${notes.join('. ')}`,
      entityType: 'Product',
      entityId: product._id,
    });
    res.json({ unit: unitView(req, saved, product.name) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/serials/:id
// Takes a number off the record (a wrong number typed by mistake). The stock count does not change.
async function removeUnit(req, res, next) {
  try {
    const unit = await ownUnit(req);
    const shops = await listShops(req.businessId);
    await assertEditable(unit, shops, 'removed');
    const result = await SerialUnit.deleteOne({ _id: unit._id, business: req.businessId, status: { $ne: 'sold' } });
    if (!result || !result.deletedCount) throw httpError(409, 'This unit just changed. Reload and try again.');
    const product = await Product.findOne({ _id: unit.product, business: req.businessId });
    logActivity(req, {
      action: 'product.update',
      summary: `Removed IMEI / serial number ${unit.serial} from the record of ${product ? product.name : 'a product'}`,
      entityType: 'Product',
      entityId: unit.product,
    });
    res.json({ message: 'Removed' });
  } catch (err) {
    next(err);
  }
}

module.exports = { lookup, available, unitView, listForProduct, addForProduct, updateUnit, removeUnit };
