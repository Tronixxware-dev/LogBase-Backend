const Product = require('../models/Product');
const StockAdjustment = require('../models/StockAdjustment');
const { httpError } = require('../utils/httpError');
const { variantLabel } = require('../utils/variants');
const { round2 } = require('../utils/money');
const { adjustmentForUser, adjustmentsForUser, productForUser } = require('../utils/staffView');
const { logActivity } = require('../utils/audit');
const { notifyOwners, checkLowStock } = require('../utils/notifications');
const { resolveShop, quantityInShop, adjustStock, undoAdjust, applyShopFilter } = require('../utils/shopStock');

// What each reason does to the stock:
//   -1 takes units out, +1 puts units in, 0 means "the number I counted" (the change is worked out).
// "other" can go either way, so the person says which.
const TYPES = {
  damaged: -1,
  lost: -1,
  expired: -1,
  stolen: -1,
  found: 1,
  count: 0,
  other: null,
};

const TYPE_LABELS = {
  damaged: 'Damaged',
  lost: 'Lost',
  expired: 'Expired',
  stolen: 'Stolen',
  found: 'Found',
  count: 'Stock count',
  other: 'Other',
};

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unitCostOf(product, variant) {
  if (variant && variant.costPrice != null) return Number(variant.costPrice) || 0;
  return Number(product.costPrice) || 0;
}

// POST /api/stock-adjustments
// body: { product, variant?, type, quantity, direction? (only for "other": 'in' | 'out'), note }
//   damaged / lost / expired / stolen: quantity = how many units to take out
//   found: quantity = how many units to add
//   count: quantity = how many units are really on the shelf now (the difference is worked out)
async function createAdjustment(req, res, next) {
  let applied = null; // what was changed, kept so it can be undone if the record cannot be saved

  try {
    const body = req.body || {};
    const type = body.type;
    if (!Object.prototype.hasOwnProperty.call(TYPES, type)) throw httpError(400, 'Choose a reason for the change');

    const qty = Number(body.quantity);
    if (body.quantity === undefined || body.quantity === '' || !Number.isFinite(qty)) {
      throw httpError(400, type === 'count' ? 'Enter how many units you counted' : 'Enter how many units');
    }
    if (type === 'count' ? qty < 0 : qty <= 0) {
      throw httpError(400, type === 'count' ? 'The counted number cannot be below 0' : 'The quantity must be above 0');
    }

    let sign = TYPES[type];
    if (type === 'other') {
      if (body.direction !== 'in' && body.direction !== 'out') throw httpError(400, 'Say whether units are added or taken out');
      sign = body.direction === 'in' ? 1 : -1;
    }

    const note = clean(body.note).slice(0, 500);
    if ((type === 'other' || type === 'stolen') && !note) throw httpError(400, 'Add a short note explaining this change');

    if (!body.product) throw httpError(400, 'Choose a product');
    const product = await Product.findOne({ _id: body.product, business: req.businessId, isActive: true });
    if (!product) throw httpError(404, 'Product not found');

    let variant = null;
    if (product.variants.length > 0) {
      if (!body.variant) throw httpError(400, `Choose which colour / size of ${product.name}`);
      variant = product.variants.id(body.variant);
      if (!variant) throw httpError(404, 'Colour / size not found');
    } else if (body.variant) {
      throw httpError(400, `${product.name} has no colours / sizes`);
    }

    // the store being counted (the business has one store unless the administrator added more)
    const shop = await resolveShop(req, body.shop, { strict: true });
    const current = await quantityInShop(req.businessId, product, variant, shop);
    const totalNow = variant ? variant.quantity : product.quantity;
    const label = variant ? `${product.name} (${variantLabel(variant)})` : product.name;

    // the signed change
    let change;
    if (type === 'count') {
      change = round2(qty - current);
      if (change === 0) throw httpError(400, `Nothing to change: the system already shows ${current} for ${label}.`);
    } else {
      change = round2(sign * qty);
    }
    if (current + change < 0) throw httpError(400, `You cannot take out ${qty}: only ${current} of ${label} ${current === 1 ? 'is' : 'are'} in stock.`);

    // Apply it in one atomic step. The check holds the business total we calculated from, so if a sale
    // (or another adjustment) changed the stock in the meantime we stop instead of getting it wrong.
    const updated = await adjustStock({ businessId: req.businessId, product, variant, change, expectedTotal: totalNow, shop });
    if (!updated) throw httpError(409, `The stock of ${label} just changed (a sale or another adjustment). Reload and try again.`);
    applied = { productId: product._id, variantId: variant ? variant._id : null, change, shopId: shop.id || null };

    const after = round2(current + change);
    const adjustment = await StockAdjustment.create({
      business: req.businessId,
      product: product._id,
      productName: product.name,
      variant: variant ? variant._id : undefined,
      variantLabel: variant ? variantLabel(variant) : undefined,
      shop: shop.id || undefined,
      shopName: shop.name,
      type,
      change,
      before: current,
      after,
      note,
      costValue: round2(change * unitCostOf(product, variant)),
      createdBy: req.user._id,
      createdByName: req.user.name,
    });
    applied = null;

    const word = change > 0 ? `Added ${change}` : `Removed ${Math.abs(change)}`;
    const place = shop.doc && !shop.doc.isMain ? ` in ${shop.name}` : '';
    logActivity(req, {
      action: 'stock.adjust',
      summary: `${word} × ${label} (${TYPE_LABELS[type].toLowerCase()}). Stock${place} went from ${current} to ${after}.`,
      entityType: 'StockAdjustment',
      entityId: adjustment._id,
      meta: { type, change, before: current, after },
    });
    if (req.user.role !== 'owner' && !req.approvedBy) {
      notifyOwners(
        req.businessId,
        { type: 'stockAdjustments', title: `${req.user.name} changed the stock of ${product.name}`, body: `${word} × ${label} (${TYPE_LABELS[type].toLowerCase()}).`, link: '/dashboard/stock-activities' },
        { exceptUserId: req.user._id }
      );
    }
    if (change < 0 && updated) {
      checkLowStock(req.businessId, { productId: product._id, name: product.name, before: product.quantity, after: updated.quantity, level: product.reorderThreshold });
    }

    res.status(201).json({
      adjustment: adjustmentForUser(req, adjustment),
      product: productForUser(req, updated),
    });
  } catch (err) {
    if (applied) await undoAdjust(req.businessId, applied);
    next(err);
  }
}

// GET /api/stock-adjustments?product=<id>
async function listAdjustments(req, res, next) {
  try {
    const filter = { business: req.businessId };
    if (req.query.product) filter.product = String(req.query.product);
    await applyShopFilter(req, filter);
    const adjustments = await StockAdjustment.find(filter).sort({ date: -1, createdAt: -1 }).limit(500);
    res.json({ adjustments: adjustmentsForUser(req, adjustments) });
  } catch (err) {
    next(err);
  }
}

module.exports = { createAdjustment, listAdjustments, TYPES, TYPE_LABELS };
