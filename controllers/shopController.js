const mongoose = require('mongoose');
const Shop = require('../models/Shop');
const ShopStock = require('../models/ShopStock');
const Transfer = require('../models/Transfer');
const { httpError } = require('../utils/httpError');
const { logActivity } = require('../utils/audit');
const { listShops } = require('../utils/shopStock');

const MAX_SHOPS = 25;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shopOut(shop) {
  return { _id: shop._id, name: shop.name, address: shop.address || '', phone: shop.phone || '', isMain: Boolean(shop.isMain), isActive: shop.isActive !== false };
}

async function assertNameFree(businessId, name, exceptId) {
  const filter = { business: businessId, name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await Shop.findOne(filter)) throw httpError(409, `You already have a store called "${name}".`);
}

function readFields(body, { requireName }) {
  const out = {};
  if (body.name !== undefined || requireName) {
    const name = clean(body.name);
    if (!name) throw httpError(400, 'Give the store a name');
    if (name.length > 60) throw httpError(400, 'The store name can be at most 60 characters');
    out.name = name;
  }
  if (body.address !== undefined) out.address = clean(body.address).slice(0, 200);
  if (body.phone !== undefined) out.phone = clean(body.phone).slice(0, 30);
  return out;
}

// GET /api/shops : the stores of this business (the main store first). Everyone who is signed in may see them,
// because everyone needs to pick the store they are working in.
async function listShopsHandler(req, res, next) {
  try {
    const shops = await listShops(req.businessId);
    res.json({ shops: shops.map(shopOut) });
  } catch (err) {
    next(err);
  }
}

// POST /api/shops  { name, address?, phone? }   (administrator)
async function createShop(req, res, next) {
  try {
    const data = readFields(req.body || {}, { requireName: true });
    const shops = await listShops(req.businessId);
    if (shops.length >= MAX_SHOPS) throw httpError(400, `A business can have at most ${MAX_SHOPS} stores.`);
    await assertNameFree(req.businessId, data.name);
    const shop = await Shop.create({ ...data, business: req.businessId });
    logActivity(req, { action: 'store.create', summary: `Added the store ${shop.name}`, entityType: 'Shop', entityId: shop._id });
    res.status(201).json({ shop: shopOut(shop) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/shops/:id  { name?, address?, phone?, isActive? }   (administrator)
async function updateShop(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Store not found');
    const shop = await Shop.findOne({ _id: req.params.id, business: req.businessId });
    if (!shop) throw httpError(404, 'Store not found');
    const body = req.body || {};
    const data = readFields(body, { requireName: false });
    if (data.name !== undefined && data.name !== shop.name) await assertNameFree(req.businessId, data.name, shop._id);

    let closing = false;
    if (body.isActive !== undefined) {
      const active = body.isActive === true || body.isActive === 'true';
      if (!active && shop.isMain) throw httpError(400, 'The main store cannot be closed.');
      if (!active && shop.isActive !== false) {
        const held = await ShopStock.find({ business: req.businessId, shop: shop._id, quantity: { $gt: 0 } }).lean();
        const units = held.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
        if (units > 0) throw httpError(409, `${shop.name} still holds ${units} ${units === 1 ? 'unit' : 'units'} of stock. Transfer it to another store before closing it.`);
        const pending = await Transfer.findOne({ business: req.businessId, status: 'pending', $or: [{ fromShop: shop._id }, { toShop: shop._id }] });
        if (pending) throw httpError(409, `${shop.name} has a transfer waiting (T-${String(pending.number).padStart(4, '0')}). Accept, decline or cancel it first.`);
        closing = true;
      }
      data.isActive = active;
    }

    const before = shop.name;
    shop.set(data);
    await shop.save();
    const what = closing ? `Closed the store ${shop.name}` : data.isActive === true ? `Reopened the store ${shop.name}` : before !== shop.name ? `Renamed the store ${before} to ${shop.name}` : `Edited the store ${shop.name}`;
    logActivity(req, { action: 'store.update', summary: what, entityType: 'Shop', entityId: shop._id });
    res.json({ shop: shopOut(shop) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listShops: listShopsHandler, createShop, updateShop, shopOut };
