const Product = require('../models/Product');
const { cloudinary } = require('../config/cloudinary');
const { ensureCategory } = require('../utils/categories');
const { httpError } = require('../utils/httpError');
const {
  normalizeVariant,
  normalizeVariantList,
  variantKey,
  variantLabel,
  totalQuantity,
} = require('../utils/variants');
const { productForUser, productsForUser } = require('../utils/staffView');
const { canSeeCosts } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');
const { assertRoomForUnits } = require('../utils/billing');
const { loadPreferences } = require('../utils/settings');
const ShopStock = require('../models/ShopStock');
const SerialUnit = require('../models/SerialUnit');
const { cleanSerialList } = require('../utils/serials');
const { assertSerialsNew } = require('../utils/serialUnits');
const { resolveShop, listShops, withShopStock, incRow, heldOutsideMain } = require('../utils/shopStock');

const EDITABLE_FIELDS = [
  'name',
  'sku',
  'barcode',
  'category',
  'brand',
  'description',
  'costPrice',
  'sellingPrice',
  'quantity',
  'baseUnit',
  'packs',
  'reorderThreshold',
  'tracksSerials',
  'warrantyMonths',
];

// Only the owner may set a cost price; for anyone else it is ignored (and never sent back either).
function pickFields(body, user) {
  const data = {};
  for (const field of EDITABLE_FIELDS) {
    if (field === 'costPrice' && !canSeeCosts(user)) continue;
    if (body[field] !== undefined) data[field] = body[field];
  }
  if (data.tracksSerials !== undefined) data.tracksSerials = data.tracksSerials === true || data.tracksSerials === 'true';
  if (data.brand !== undefined) {
    data.brand = String(data.brand || '').replace(/\s+/g, ' ').trim();
    if (data.brand.length > 60) throw httpError(400, 'The brand can be at most 60 characters');
  }
  if (data.barcode !== undefined) {
    data.barcode = String(data.barcode || '').trim();
    if (data.barcode.length > 60) throw httpError(400, 'The barcode can be at most 60 characters');
  }
  if (data.description !== undefined) {
    data.description = String(data.description || '').trim();
    if (data.description.length > 1000) throw httpError(400, 'The description can be at most 1000 characters');
  }
  if (data.warrantyMonths !== undefined) {
    const months = data.warrantyMonths === '' || data.warrantyMonths === null ? 0 : Number(data.warrantyMonths);
    if (!Number.isInteger(months) || months < 0 || months > 120) throw httpError(400, 'The warranty must be a whole number of months from 0 to 120');
    data.warrantyMonths = months;
  }
  return data;
}

// Variants sent by someone who may not set costs keep no cost price of their own.
function withoutVariantCosts(user, variants) {
  if (canSeeCosts(user) || !Array.isArray(variants)) return variants;
  return variants.map((v) => {
    const copy = { ...(v || {}) };
    delete copy.costPrice;
    return copy;
  });
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Product names must be unique per business (ignoring capital letters and extra spaces).
// Deleted products don't count, so their names can be used again.
async function assertNameIsFree(businessId, rawName, ignoreId, shopId) {
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : '';
  if (!name) return;

  const pattern = name.split(' ').map(escapeRegex).join('\\s+');
  const filter = {
    business: businessId,
    isActive: true,
    name: new RegExp(`^${pattern}$`, 'i'),
    // each store has its own products
    shop: shopId || null,
  };
  if (ignoreId) filter._id = { $ne: ignoreId };

  const existing = await Product.findOne(filter).select('name');
  if (existing) {
    throw httpError(
      409,
      `A product named "${existing.name}" already exists. Give this one a different name, or add colours/sizes to the existing product if it is the same item.`
    );
  }
}

async function findOwnProduct(req) {
  const product = await Product.findOne({ _id: req.params.id, business: req.businessId });
  if (!product) throw httpError(404, 'Product not found');
  return product;
}

// The products as the signed-in person may see them, with how much the store they work in holds.
async function present(req, products) {
  const [shop, shops] = await Promise.all([resolveShop(req, undefined), listShops(req.businessId)]);
  const plain = productsForUser(req, products).map((p) => (typeof p.toObject === 'function' ? p.toObject() : p));
  const decorated = await withShopStock(req.businessId, plain, shop, shops);
  // what the other stores hold is not this store's business: the per-store breakdown is not sent
  return decorated.map((p) => {
    const { stores, ...rest } = p;
    return rest;
  });
}

// Each store only sees its own products: the ones made in it, and the ones it holds or has held (received by a transfer or a
// purchase). A product that was made in another store and never reached this one is not shown here at all.
// ?shop=all skips this (a backup of the whole business).
async function visibleHere(req, plain) {
  if (req.query && req.query.shop === 'all') return plain;
  const [shop, shops] = await Promise.all([resolveShop(req, undefined), listShops(req.businessId)]);
  const open = shops.filter((s) => s.isActive !== false);
  if (open.length < 2) return plain; // one open store: everything is its own
  const openOther = new Set(open.filter((s) => !s.isMain).map((s) => String(s._id)));
  if (shop.id) {
    const held = new Set((await ShopStock.find({ business: req.businessId, shop: shop.id }).distinct('product')).map(String));
    return plain.filter((p) => String(p.shop || '') === String(shop.id) || held.has(String(p._id)) || (Number(p.shopQuantity) || 0) > 0);
  }
  // the main store: what was made without a store (or in a store that has closed), or what it still holds
  return plain.filter((p) => !p.shop || !openOther.has(String(p.shop)) || (Number(p.shopQuantity) || 0) > 0);
}

async function presentOne(req, product) {
  return (await present(req, [product]))[0];
}

// What the other stores hold of a product (or one colour / size) cannot be taken away by editing the total.
async function assertTotalCoversStores(businessId, productId, variantId, newTotal, what) {
  const held = await heldOutsideMain(businessId, productId, variantId);
  if (held > 0 && Number(newTotal) < held) {
    throw httpError(400, `${held} of ${what} ${held === 1 ? 'is' : 'are'} held in other stores or on the way, so the total cannot be below ${held}. Use Adjust stock in the store you are counting.`);
  }
}

async function listProducts(req, res, next) {
  try {
    const { search, category, lowStock } = req.query;
    // ?archived=true lists the products that were deleted (archived), so one can be brought back
    const filter = { business: req.businessId, isActive: req.query.archived !== 'true' };

    if (category) filter.category = category;
    if (search) filter.$text = { $search: search };

    const products = await Product.find(filter).sort({ createdAt: -1 });

    const result = lowStock === 'true'
      ? products.filter((p) => p.quantity <= p.reorderThreshold)
      : products;

    res.json({ products: await visibleHere(req, await present(req, result)) });
  } catch (err) {
    next(err);
  }
}

async function getProduct(req, res, next) {
  try {
    const product = await findOwnProduct(req);
    res.json({ product: await presentOne(req, product) });
  } catch (err) {
    next(err);
  }
}

// The numbers typed with a new product: [{ index (null = the product itself, else the colour / size's place), serials }].
// Not more numbers than pieces, none twice, and only for a product tracked by IMEI / serial number.
function readOpeningSerials(body, data, variants) {
  const groups = [];
  if (variants.length > 0) {
    const raw = Array.isArray(body.variants) ? body.variants : [];
    variants.forEach((v, index) => {
      const list = cleanSerialList(raw[index] && raw[index].serials, variantLabel(v) || 'This colour / size');
      if (list.length === 0) return;
      if (list.length > (Number(v.quantity) || 0)) {
        throw httpError(400, `${variantLabel(v)}: you entered ${list.length} IMEI / serial numbers but only ${Number(v.quantity) || 0} piece${Number(v.quantity) === 1 ? '' : 's'}. Raise the quantity or remove some numbers.`);
      }
      groups.push({ index, serials: list });
    });
  } else {
    const list = cleanSerialList(body.serials, 'The list');
    if (list.length > 0) {
      if (list.length > (Number(data.quantity) || 0)) {
        throw httpError(400, `You entered ${list.length} IMEI / serial numbers but only ${Number(data.quantity) || 0} piece${Number(data.quantity) === 1 ? '' : 's'}. Raise the starting quantity or remove some numbers.`);
      }
      groups.push({ index: null, serials: list });
    }
  }
  if (groups.length === 0) return groups;
  if (!data.tracksSerials) throw httpError(400, 'Turn on "Track each item by IMEI / serial number" to record numbers.');
  const all = groups.flatMap((g) => g.serials);
  if (new Set(all).size !== all.length) throw httpError(400, 'The same IMEI / serial number is listed twice.');
  return groups;
}

async function createProduct(req, res, next) {
  try {
    const data = pickFields(req.body, req.user);

    // the product belongs to the store it is made in
    const shop = await resolveShop(req, undefined, { strict: true });
    await assertNameIsFree(req.businessId, data.name, undefined, shop.id);

    if (data.category !== undefined) {
      data.category = String(data.category).trim()
        ? (await ensureCategory(req.businessId, data.category)).category.name
        : undefined;
    }

    const variants = normalizeVariantList(withoutVariantCosts(req.user, req.body.variants));
    if (variants.length > 0) {
      data.variants = variants;
      data.quantity = totalQuantity(variants);
    }

    // the opening stock must fit in what the plan holds
    await assertRoomForUnits(req.businessId, Number(data.quantity) || 0);

    // IMEI / serial numbers of the opening stock (optional: as many as the person has, up to the pieces added)
    const wantedSerials = readOpeningSerials(req.body, data, variants);
    await assertSerialsNew(req.businessId, wantedSerials.flatMap((g) => g.serials));

    // a product added without a low-stock level gets the business's usual one (Settings > Preferences)
    if (data.reorderThreshold === undefined || data.reorderThreshold === '' || data.reorderThreshold === null) {
      data.reorderThreshold = (await loadPreferences(req.businessId)).defaultReorderLevel;
    }

    // opening stock goes into the store the person is working in
    const product = await Product.create({ ...data, business: req.businessId, shop: shop.id || undefined });
    if (shop.id) {
      if (product.variants.length > 0) {
        for (const v of product.variants) if (v.quantity > 0) await incRow(req.businessId, product._id, v._id, shop.id, v.quantity);
      } else if (product.quantity > 0) {
        await incRow(req.businessId, product._id, null, shop.id, product.quantity);
      }
    }
    if (wantedSerials.length > 0) {
      const now = new Date();
      const docs = wantedSerials.flatMap((g) => {
        const v = g.index === null ? null : product.variants[g.index];
        return g.serials.map((serial) => ({
          business: req.businessId,
          product: product._id,
          variant: v ? v._id : undefined,
          variantLabel: v ? variantLabel(v) : undefined,
          shop: shop.id || undefined,
          serial,
          status: 'in_stock',
          receivedAt: now,
          events: [{ type: 'received', at: now, note: 'Opening stock' }],
        }));
      });
      try {
        await SerialUnit.insertMany(docs);
      } catch (err) {
        // undo the product so nothing is half saved
        await ShopStock.deleteMany({ business: req.businessId, product: product._id }).catch(() => {});
        await SerialUnit.deleteMany({ business: req.businessId, product: product._id }).catch(() => {});
        await Product.deleteOne({ _id: product._id, business: req.businessId }).catch(() => {});
        if (err && (err.code === 11000 || (err.writeErrors && err.writeErrors.length))) {
          throw httpError(409, 'One of those IMEI / serial numbers was just recorded by someone else. Check them and try again.');
        }
        throw err;
      }
    }
    logActivity(req, {
      action: 'product.create',
      summary: `Added product ${product.name}${product.quantity > 0 ? ` with ${product.quantity} in stock` : ''}`,
      entityType: 'Product',
      entityId: product._id,
    });
    res.status(201).json({ product: await presentOne(req, product) });
  } catch (err) {
    next(err);
  }
}

async function updateProduct(req, res, next) {
  try {
    const product = await findOwnProduct(req);
    const data = pickFields(req.body, req.user);

    if (data.name !== undefined) await assertNameIsFree(req.businessId, data.name, product._id, product.shop);

    if (data.category !== undefined) {
      data.category = String(data.category).trim()
        ? (await ensureCategory(req.businessId, data.category)).category.name
        : undefined;
    }

    // With variants, stock is edited per variant (see the variant routes).
    if (product.variants.length > 0) delete data.quantity;

    if (data.quantity !== undefined) await assertTotalCoversStores(req.businessId, product._id, null, data.quantity, product.name);
    // raising the stock count is adding stock
    if (data.quantity !== undefined) await assertRoomForUnits(req.businessId, (Number(data.quantity) || 0) - (Number(product.quantity) || 0));
    const quantityBefore = product.quantity;
    product.set(data);
    await product.save();
    const stockText = product.quantity !== quantityBefore ? `. Stock changed from ${quantityBefore} to ${product.quantity}` : '';
    logActivity(req, {
      action: 'product.update',
      summary: `Edited product ${product.name}${stockText}`,
      entityType: 'Product',
      entityId: product._id,
      meta: product.quantity !== quantityBefore ? { before: quantityBefore, after: product.quantity } : undefined,
    });
    res.json({ product: await presentOne(req, product) });
  } catch (err) {
    next(err);
  }
}

async function deleteProduct(req, res, next) {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, business: req.businessId },
      { isActive: false },
      { new: true }
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });
    logActivity(req, { action: 'product.delete', summary: `Deleted product ${product.name}`, entityType: 'Product', entityId: product._id });
    res.json({ message: 'Product deleted' });
  } catch (err) {
    next(err);
  }
}

// POST /api/products/:id/restore : brings a deleted (archived) product back
async function restoreProduct(req, res, next) {
  try {
    if (!/^[a-f0-9]{24}$/i.test(String(req.params.id))) throw httpError(404, 'Product not found');
    const product = await Product.findOne({ _id: req.params.id, business: req.businessId, isActive: false });
    if (!product) throw httpError(404, 'Archived product not found');
    await assertRoomForUnits(req.businessId, Number(product.quantity) || 0);
    await assertNameIsFree(req.businessId, product.name, product._id, product.shop);
    product.isActive = true;
    await product.save();
    logActivity(req, { action: 'product.update', summary: `Restored product ${product.name} from the archive`, entityType: 'Product', entityId: product._id });
    res.json({ product: await presentOne(req, product) });
  } catch (err) {
    next(err);
  }
}

// PUT /api/products/low-stock-threshold   body: { threshold }
// The number at or below which every product counts as low on stock.
async function setLowStockThreshold(req, res, next) {
  try {
    const threshold = Number((req.body || {}).threshold);
    if ((req.body || {}).threshold === '' || (req.body || {}).threshold == null || !Number.isInteger(threshold) || threshold < 0 || threshold > 100000) {
      throw httpError(400, 'Enter a whole number of 0 or more');
    }
    const result = await Product.updateMany({ business: req.businessId, isActive: true }, { $set: { reorderThreshold: threshold } });
    const count = result.matchedCount ?? result.n ?? 0;
    logActivity(req, { action: 'product.update', summary: `Set the low stock level of every product to ${threshold}`, meta: { threshold, products: count } });
    res.json({ threshold, updated: count });
  } catch (err) {
    next(err);
  }
}

async function addVariant(req, res, next) {
  try {
    const product = await findOwnProduct(req);
    const variant = normalizeVariant(withoutVariantCosts(req.user, [req.body])[0]);

    const key = variantKey(variant);
    if (product.variants.some((v) => variantKey(v) === key)) {
      throw httpError(400, `This product already has a "${variantLabel(variant)}" variant`);
    }

    // First variant of a product that already had plain stock: carry that stock over
    // unless a quantity was given explicitly.
    const isFirst = product.variants.length === 0;
    if (isFirst && product.quantity > 0 && (req.body.quantity === undefined || req.body.quantity === '')) {
      variant.quantity = product.quantity;
    }

    // the product's total after this colour / size is added (a first colour / size carries the plain stock over)
    const totalBefore = Number(product.quantity) || 0;
    const totalAfter = totalQuantity([...product.variants.map((v) => ({ quantity: v.quantity })), { quantity: variant.quantity }]);
    await assertRoomForUnits(req.businessId, totalAfter - totalBefore);

    product.variants.push(variant);
    await product.save();
    // stock other stores held of the plain product now belongs to this first colour / size
    if (isFirst) {
      const added = product.variants[product.variants.length - 1];
      await ShopStock.updateMany({ business: req.businessId, product: product._id, variant: null }, { $set: { variant: added._id } });
    }
    logActivity(req, { action: 'product.update', summary: `Added ${variantLabel(variant)} to ${product.name}`, entityType: 'Product', entityId: product._id });
    res.status(201).json({ product: productForUser(req, product) });
  } catch (err) {
    next(err);
  }
}

async function updateVariant(req, res, next) {
  try {
    const product = await findOwnProduct(req);
    const variant = product.variants.id(req.params.variantId);
    if (!variant) throw httpError(404, 'Variant not found');

    const merged = normalizeVariant({
      color: req.body.color ?? variant.color,
      size: req.body.size ?? variant.size,
      sku: req.body.sku ?? variant.sku,
      quantity: req.body.quantity ?? variant.quantity,
      costPrice: canSeeCosts(req.user) && req.body.costPrice !== undefined ? req.body.costPrice : variant.costPrice,
      sellingPrice: req.body.sellingPrice !== undefined ? req.body.sellingPrice : variant.sellingPrice,
    });

    const key = variantKey(merged);
    const clash = product.variants.some(
      (v) => String(v._id) !== String(variant._id) && variantKey(v) === key
    );
    if (clash) throw httpError(400, `This product already has a "${variantLabel(merged)}" variant`);

    await assertTotalCoversStores(req.businessId, product._id, variant._id, merged.quantity, `${product.name} (${variantLabel(variant)})`);
    const variantBefore = variant.quantity;
    await assertRoomForUnits(req.businessId, (Number(merged.quantity) || 0) - (Number(variantBefore) || 0));
    const labelBefore = variantLabel(variant);
    variant.set(merged);
    // an emptied price box means "use the product's price again"
    if (req.body.sellingPrice === '' || req.body.sellingPrice === null) variant.sellingPrice = undefined;
    if (canSeeCosts(req.user) && (req.body.costPrice === '' || req.body.costPrice === null)) variant.costPrice = undefined;
    await product.save();
    // the numbers recorded under this colour / size show its new name
    if (variantLabel(merged) !== labelBefore) {
      await SerialUnit.updateMany({ business: req.businessId, product: product._id, variant: variant._id }, { $set: { variantLabel: variantLabel(merged) } }).catch(() => {});
    }
    logActivity(req, {
      action: 'product.update',
      summary: `Edited ${variantLabel(merged)} of ${product.name}${merged.quantity !== variantBefore ? `. Stock changed from ${variantBefore} to ${merged.quantity}` : ''}`,
      entityType: 'Product',
      entityId: product._id,
    });
    res.json({ product: productForUser(req, product) });
  } catch (err) {
    next(err);
  }
}

async function deleteVariant(req, res, next) {
  try {
    const product = await findOwnProduct(req);
    const variant = product.variants.id(req.params.variantId);
    if (!variant) throw httpError(404, 'Variant not found');

    const removedLabel = variantLabel(variant);
    product.variants.pull(variant._id);
    if (product.variants.length === 0) product.quantity = 0;
    await product.save();
    // the stores no longer hold that colour / size
    await ShopStock.deleteMany({ business: req.businessId, product: product._id, variant: variant._id });
    await ShopStock.deleteMany({ business: req.businessId, product: product._id, variant: null });
    logActivity(req, { action: 'product.update', summary: `Removed ${removedLabel} from ${product.name}`, entityType: 'Product', entityId: product._id });
    res.json({ product: productForUser(req, product) });
  } catch (err) {
    next(err);
  }
}

async function uploadImages(req, res, next) {
  try {
    const product = await findOwnProduct(req);

    const files = req.files || [];
    // the first photo of a product with no photos yet becomes the cover (only one cover)
    const hadNone = product.images.length === 0;
    const newImages = files.map((file, index) => ({
      url: file.path,
      publicId: file.filename,
      isCover: hadNone && index === 0,
    }));

    product.images.push(...newImages);
    await product.save();

    res.status(201).json({ product: productForUser(req, product) });
  } catch (err) {
    next(err);
  }
}

async function deleteImage(req, res, next) {
  try {
    const product = await findOwnProduct(req);

    const publicId = decodeURIComponent(req.params.publicId);
    // only a photo that really belongs to this product may be removed (and deleted from Cloudinary)
    if (!product.images.some((img) => img.publicId === publicId)) throw httpError(404, 'Photo not found');
    product.images = product.images.filter((img) => img.publicId !== publicId);
    // if the cover photo was deleted, the next photo becomes the cover
    if (product.images.length > 0 && !product.images.some((img) => img.isCover)) {
      product.images[0].isCover = true;
    }
    await product.save();

    await cloudinary.uploader.destroy(publicId).catch(() => {});

    res.json({ product: productForUser(req, product) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
  setLowStockThreshold,
  addVariant,
  updateVariant,
  deleteVariant,
  uploadImages,
  deleteImage,
};
