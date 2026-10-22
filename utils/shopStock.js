// Stores and the stock they hold.
//
// A product's own quantity (and each colour / size's quantity) stays the business-wide TOTAL, exactly as before, so every
// report and every older screen keeps working. On top of that, ShopStock rows say how much of it sits in each store
// other than the main store; the main store holds the rest (total minus all the rows).
//
// That means a business with one store has no rows at all and nothing changes for it. Every step here is atomic on its
// own and returns what is needed to undo it, because there are no database transactions in this app.

const mongoose = require('mongoose');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const ShopStock = require('../models/ShopStock');
const { httpError } = require('./httpError');
const { variantLabel } = require('./variants');

const MAIN_NAME = 'Main store';

const isIdText = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const sameId = (a, b) => String(a || '') === String(b || '');

// The main store of a business, created the first time anyone needs it.
async function ensureMainShop(businessId) {
  let main = await Shop.findOne({ business: businessId, isMain: true });
  if (main) return main;
  try {
    main = await Shop.create({ business: businessId, name: MAIN_NAME, isMain: true });
  } catch (err) {
    if (err && err.code === 11000) main = await Shop.findOne({ business: businessId, isMain: true });
    else throw err;
  }
  return main;
}

// All the stores, the main store first.
async function listShops(businessId) {
  const main = await ensureMainShop(businessId);
  const others = await Shop.find({ business: businessId, isMain: { $ne: true } }).sort({ createdAt: 1, _id: 1 });
  return [main, ...others];
}

// { doc, id, name }: `id` is null for the main store (its stock is whatever the other stores do not hold).
function shopContext(doc) {
  return { doc, id: doc.isMain ? null : doc._id, name: doc.name };
}

// Which store a request is working in.
//   requested: a store id sent in the body (a sale recorded offline names its store, so it lands in the right one)
//   otherwise the X-Shop-Id header the app sends with every call, otherwise the main store.
// A wrong or closed store in the body is an error. A stale header (the store was closed since) is an error too when the
// call changes stock (strict), so stock never lands in the main store by mistake; for reading it falls back to the main store.
async function resolveShop(req, requested, { strict = false } = {}) {
  const main = await ensureMainShop(req.businessId);
  const fromBody = requested !== undefined && requested !== null && requested !== '';
  const header = req.headers && req.headers['x-shop-id'];
  const wanted = fromBody ? requested : header;
  if (wanted === undefined || wanted === null || wanted === '' || wanted === 'main') return shopContext(main);
  if (sameId(wanted, main._id)) return shopContext(main);
  const text = String(wanted);
  const doc = isIdText(text) ? await Shop.findOne({ _id: text, business: req.businessId }) : null;
  if (doc && doc.isActive !== false) return shopContext(doc);
  if (fromBody || strict) throw httpError(400, 'That store is not available any more. Choose another store and try again.');
  return shopContext(main);
}

// What `shop` must equal on a record that belongs to this store. Records of the main store carry no store id, so they are
// matched by "no store"; records of a store that was closed since belong to nobody any more, so the main store keeps them.
async function shopValue(businessId, shop) {
  if (shop && shop.id) return shop.id;
  const closed = await Shop.find({ business: businessId, isMain: { $ne: true }, isActive: false }).distinct('_id');
  return closed.length > 0 ? { $in: [null, ...closed] } : null;
}

// Narrows a list to one store when the request asks for it (?shop=<store id> or ?shop=main); leave it out for every store.
async function applyShopFilter(req, filter) {
  const wanted = req.query && req.query.shop;
  if (wanted === undefined || wanted === null || wanted === '' || wanted === 'all') return;
  const shop = await resolveShop(req, wanted === 'main' ? 'main' : String(wanted));
  filter.shop = await shopValue(req.businessId, shop);
}

// For lists that always belong to one store (customers, suppliers, expenses, products...): the store being worked in
// (the X-Shop-Id the app sends), unless the request says ?shop=all (a backup of the whole business) or names another store.
async function applyWorkingShop(req, filter) {
  const wanted = req.query && req.query.shop;
  if (wanted === 'all') return null;
  const shop = await resolveShop(req, wanted === undefined || wanted === '' ? undefined : wanted === 'main' ? 'main' : String(wanted));
  filter.shop = await shopValue(req.businessId, shop);
  return shop;
}

// The store a new record is made in (a wrong or closed store is an error, so a record never lands in the wrong store).
// Returns the id to save as `shop`, or undefined for the main store.
async function shopForNewRecord(req) {
  const shop = await resolveShop(req, undefined, { strict: true });
  return shop.id || undefined;
}

/* ---------- rows ---------- */

const rowFilter = (businessId, productId, variantId, shopId) => ({
  business: businessId,
  product: productId,
  variant: variantId || null,
  shop: shopId,
});

const matched = (result) => (result && (result.matchedCount ?? result.n ?? 0)) > 0;

// Adds (or takes off) units on one store's row. `upsert` false means "only if the row exists" (used when undoing).
async function incRow(businessId, productId, variantId, shopId, delta, { upsert = true } = {}) {
  const filter = rowFilter(businessId, productId, variantId, shopId);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await ShopStock.updateOne(filter, { $inc: { quantity: delta } }, { upsert });
      return;
    } catch (err) {
      // two requests creating the same row at the same moment: the second one simply adds to it
      if (attempt < 3 && err && err.code === 11000) continue;
      throw err;
    }
  }
}

// Takes `qty` units off a row, only if it holds at least that many. Returns true when it did.
async function decRowGuarded(businessId, productId, variantId, shopId, qty) {
  const result = await ShopStock.updateOne({ ...rowFilter(businessId, productId, variantId, shopId), quantity: { $gte: qty } }, { $inc: { quantity: -qty } });
  return matched(result);
}

async function rowsOf(businessId, productId, variantId) {
  return ShopStock.find({ business: businessId, product: productId, variant: variantId || null }).lean();
}

const sumRows = (rows) => rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);

// What the main store holds of a product / colour right now (total minus what the other stores and transfers hold).
async function mainRemaining(businessId, productId, variantId) {
  const product = await Product.findOne({ _id: productId, business: businessId }).select('quantity variants').lean();
  if (!product) return 0;
  let total = Number(product.quantity) || 0;
  if (variantId) {
    const v = (product.variants || []).find((x) => sameId(x._id, variantId));
    total = v ? Number(v.quantity) || 0 : 0;
  }
  return total - sumRows(await rowsOf(businessId, productId, variantId));
}

// How much of a product / colour is held outside the main store (other stores and transfers on their way).
async function heldOutsideMain(businessId, productId, variantId) {
  return sumRows(await rowsOf(businessId, productId, variantId));
}

/* ---------- moving the business total together with a store ---------- */

function totalFilterAndInc(businessId, productId, variantId, delta) {
  const filter = { _id: productId, business: businessId };
  const inc = { quantity: delta };
  if (variantId) {
    filter['variants._id'] = variantId;
    inc['variants.$.quantity'] = delta;
  }
  return { filter, inc };
}

// Changes the total by `delta` and the store's row too (no guards; used for putting things back and undoing).
// Returns true when the product was found.
async function shiftStock({ businessId, productId, variantId, delta, shopId }) {
  const { filter, inc } = totalFilterAndInc(businessId, productId, variantId, delta);
  const result = await Product.updateOne(filter, { $inc: inc });
  if (!matched(result)) return false;
  if (shopId) await incRow(businessId, productId, variantId, shopId, delta, { upsert: delta > 0 });
  return true;
}

function whatText(product, variant) {
  return variant ? `${product.name} (${variantLabel(variant)})` : product.name;
}

// Takes units out of stock for a sale, a repair part and the like, from one store.
//   product: the Product document   variant: its colour / size subdocument or null   shop: from shopContext()
//   notEnough: the message when the business as a whole does not have that many (kept as each screen already words it)
// Atomic: two people at the same moment cannot take the last unit. Throws a 400 when the store does not have enough.
async function takeStock({ businessId, product, variant, qty, shop, notEnough, requireActive = false }) {
  const filter = { _id: product._id, business: businessId };
  if (requireActive) filter.isActive = true;
  const inc = { quantity: -qty };
  if (variant) {
    filter.variants = { $elemMatch: { _id: variant._id, quantity: { $gte: qty } } };
    inc['variants.$.quantity'] = -qty;
  } else {
    filter.quantity = { $gte: qty };
  }
  const updated = await Product.findOneAndUpdate(filter, { $inc: inc }, { new: true });
  if (!updated) throw httpError(400, notEnough);

  const variantId = variant ? variant._id : null;
  const putTotalBack = () => shiftStock({ businessId, productId: product._id, variantId, delta: qty, shopId: null }).catch(() => {});
  try {
    if (shop && shop.id) {
      const ok = await decRowGuarded(businessId, product._id, variantId, shop.id, qty);
      if (!ok) {
        await putTotalBack();
        throw httpError(400, `Not enough stock for ${whatText(product, variant)} in ${shop.name}. Move more stock there with a transfer, or sell it from the store that has it.`);
      }
    } else {
      const rows = await rowsOf(businessId, product._id, variantId);
      const held = sumRows(rows);
      if (held > 0) {
        const total = variant ? Number((updated.variants.id(variant._id) || {}).quantity) || 0 : Number(updated.quantity) || 0;
        if (total - held < 0) {
          await putTotalBack();
          throw httpError(
            400,
            `Not enough stock for ${whatText(product, variant)} in ${shop ? shop.name : MAIN_NAME}. ${held} ${held === 1 ? 'is' : 'are'} held in other stores or on the way: move ${held === 1 ? 'it' : 'them'} here with a transfer first.`
          );
        }
      }
    }
  } catch (err) {
    if (!err.statusCode) await putTotalBack();
    throw err;
  }
  return updated;
}

// What takeStock did, as a record the caller keeps so it can be undone.
function takenRecord(product, variant, qty, shop) {
  return { productId: product._id, variantId: variant ? variant._id : null, qty, shopId: shop && shop.id ? shop.id : null };
}

// Undo of takeStock.
function restoreTaken(businessId, t) {
  return shiftStock({ businessId, productId: t.productId, variantId: t.variantId, delta: t.qty, shopId: t.shopId }).catch(() => false);
}

// Puts units back on a store's shelf (a return, a part removed from a job). Returns false when the product no longer exists.
async function putStock({ businessId, productId, variantId, qty, shopId }) {
  return shiftStock({ businessId, productId, variantId, delta: qty, shopId: shopId || null });
}

// A manual change (found, damaged, a recount) in one store: atomic on the business total with `expectedTotal`, which is
// the total the caller worked from, so if anything sold in the meantime this stops instead of getting it wrong.
// Returns the updated product, or null when the total changed (the caller says so). Throws when the store lacks the units.
async function adjustStock({ businessId, product, variant, change, expectedTotal, shop }) {
  const variantId = variant ? variant._id : null;
  const filter = { _id: product._id, business: businessId, isActive: true };
  const inc = { quantity: change };
  if (variant) {
    filter.variants = { $elemMatch: { _id: variant._id, quantity: expectedTotal } };
    inc['variants.$.quantity'] = change;
  } else {
    filter.quantity = expectedTotal;
  }
  const updated = await Product.findOneAndUpdate(filter, { $inc: inc }, { new: true });
  if (!updated) return null;

  const revert = () => shiftStock({ businessId, productId: product._id, variantId, delta: -change, shopId: null }).catch(() => {});
  try {
    if (shop && shop.id) {
      if (change < 0) {
        const ok = await decRowGuarded(businessId, product._id, variantId, shop.id, -change);
        if (!ok) {
          await revert();
          throw httpError(400, `Not enough of ${whatText(product, variant)} in ${shop.name}.`);
        }
      } else {
        await incRow(businessId, product._id, variantId, shop.id, change);
      }
    } else if (change < 0) {
      const held = sumRows(await rowsOf(businessId, product._id, variantId));
      if (held > 0) {
        const total = variant ? Number((updated.variants.id(variant._id) || {}).quantity) || 0 : Number(updated.quantity) || 0;
        if (total - held < 0) {
          await revert();
          throw httpError(400, `Not enough of ${whatText(product, variant)} in ${shop ? shop.name : MAIN_NAME}: the rest is held in other stores.`);
        }
      }
    }
  } catch (err) {
    if (!err.statusCode) await revert();
    throw err;
  }
  return updated;
}

// Undo of adjustStock.
function undoAdjust(businessId, { productId, variantId, change, shopId }) {
  return shiftStock({ businessId, productId, variantId: variantId || null, delta: -change, shopId: shopId || null }).catch(() => false);
}

/* ---------- transfers (stock on its way between stores) ---------- */

// Stock leaves the sending store and waits on a row named after the transfer. The business total does not change.
// Returns false (and changes nothing) when the sending store does not hold enough.
async function moveToTransit({ businessId, productId, variantId, qty, fromShopId, transitId }) {
  if (fromShopId) {
    const ok = await decRowGuarded(businessId, productId, variantId, fromShopId, qty);
    if (!ok) return false;
    try {
      await incRow(businessId, productId, variantId, transitId, qty);
    } catch (err) {
      await incRow(businessId, productId, variantId, fromShopId, qty).catch(() => {});
      throw err;
    }
    return true;
  }
  // the main store holds the rest: crediting the transfer is what takes it out of the main store, so check afterwards
  await incRow(businessId, productId, variantId, transitId, qty);
  const left = await mainRemaining(businessId, productId, variantId);
  if (left < 0) {
    await incRow(businessId, productId, variantId, transitId, -qty, { upsert: false }).catch(() => {});
    return false;
  }
  return true;
}

// The transfer is accepted: the stock leaves its waiting row and joins the receiving store (the main store simply has more left).
async function receiveFromTransit({ businessId, productId, variantId, qty, toShopId, transitId }) {
  const ok = await decRowGuarded(businessId, productId, variantId, transitId, qty);
  if (!ok) return false;
  if (toShopId) await incRow(businessId, productId, variantId, toShopId, qty);
  return true;
}

// The transfer is declined or cancelled: the stock goes back to the sending store.
async function returnFromTransit({ businessId, productId, variantId, qty, fromShopId, transitId }) {
  const ok = await decRowGuarded(businessId, productId, variantId, transitId, qty);
  if (!ok) return false;
  if (fromShopId) await incRow(businessId, productId, variantId, fromShopId, qty);
  return true;
}

/* ---------- reading ---------- */

// Per product: its rows, for reading how much each store holds.
async function rowsForProducts(businessId, productIds) {
  const map = new Map();
  if (productIds.length === 0) return map;
  const rows = await ShopStock.find({ business: businessId, product: { $in: productIds } }).lean();
  for (const r of rows) {
    const key = String(r.product);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

function qtyIn(total, rows, variantId, shopKey) {
  const mine = rows.filter((r) => sameId(r.variant, variantId));
  if (shopKey) {
    const row = mine.find((r) => sameId(r.shop, shopKey));
    return row ? Number(row.quantity) || 0 : 0;
  }
  return total - sumRows(mine);
}

// Adds to each product (plain objects, as the serializers produce) how much the chosen store holds:
//   shopQuantity   on the product and on each colour / size
//   stores         [{ shop, name, quantity }] for every store, only when the business has more than one
// `quantity` stays the business total.
async function withShopStock(businessId, products, shop, shops) {
  const list = Array.isArray(products) ? products : [products];
  const active = shops.filter((s) => s.isActive !== false);
  const rowsByProduct = await rowsForProducts(businessId, list.map((p) => p._id));
  const decorated = list.map((p) => {
    const rows = rowsByProduct.get(String(p._id)) || [];
    const shopKey = shop && shop.id ? shop.id : null;
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const hasVariants = variants.length > 0;

    const storeQty = (key) =>
      hasVariants
        ? variants.reduce((s, v) => s + qtyIn(Number(v.quantity) || 0, rows, v._id, key), 0)
        : qtyIn(Number(p.quantity) || 0, rows, null, key);

    const out = { ...p, shopQuantity: storeQty(shopKey) };
    if (hasVariants) out.variants = variants.map((v) => ({ ...v, shopQuantity: qtyIn(Number(v.quantity) || 0, rows, v._id, shopKey) }));
    if (active.length > 1) {
      out.stores = active.map((s) => ({ shop: String(s._id), name: s.name, isMain: Boolean(s.isMain), quantity: storeQty(s.isMain ? null : s._id) }));
    }
    return out;
  });
  return Array.isArray(products) ? decorated : decorated[0];
}

// How many units of a product / colour one store holds right now (for checks before a change).
async function quantityInShop(businessId, product, variant, shop) {
  const variantId = variant ? variant._id : null;
  const total = variant ? Number(variant.quantity) || 0 : Number(product.quantity) || 0;
  return qtyIn(total, await rowsOf(businessId, product._id, variantId), variantId, shop && shop.id ? shop.id : null);
}

module.exports = {
  MAIN_NAME,
  isIdText,
  ensureMainShop,
  listShops,
  shopContext,
  resolveShop,
  applyShopFilter,
  applyWorkingShop,
  shopForNewRecord,
  shopValue,
  incRow,
  decRowGuarded,
  rowsOf,
  sumRows,
  mainRemaining,
  heldOutsideMain,
  shiftStock,
  moveToTransit,
  receiveFromTransit,
  returnFromTransit,
  takeStock,
  takenRecord,
  restoreTaken,
  putStock,
  adjustStock,
  undoAdjust,
  withShopStock,
  quantityInShop,
  whatText,
};
