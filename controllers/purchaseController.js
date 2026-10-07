const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const { cloudinary } = require('../config/cloudinary');
const { httpError } = require('../utils/httpError');
const { variantLabel } = require('../utils/variants');
const { purchaseForUser, purchasesForUser, productsForUser, productForUser } = require('../utils/staffView');
const { canSeeCosts } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');
const SerialUnit = require('../models/SerialUnit');
const { cleanSerialList } = require('../utils/serials');
const { assertSerialsNew, receivedUnitDocs } = require('../utils/serialUnits');
const { round2 } = require('../utils/money');

const MAX_PURCHASE_PHOTOS = 8;

// "Are you paying for the delivery?" Yes means the business pays and the amount is required.
// No (or not answered) means the supplier pays or there was no delivery, so there is no cost to record.
function readDelivery(body) {
  const paidByUs = body.deliveryPaidByUs === true || body.deliveryPaidByUs === 'true';
  if (!paidByUs) return { deliveryPaidByUs: false, deliveryCost: 0 };

  const cost = Number(body.deliveryCost);
  if (body.deliveryCost == null || body.deliveryCost === '' || !Number.isFinite(cost) || cost <= 0) {
    throw httpError(400, 'Enter how much you paid for the delivery');
  }
  return { deliveryPaidByUs: true, deliveryCost: cost };
}

// Buying on credit: how much of the goods was left unpaid.
// The administrator types how much was handed over on the day (leave it empty for "paid in full").
// A staff has no supplier to owe, so a staff purchase is never on credit: the administrator adds the supplier
// (and what was paid) afterwards.
function readPayment(body, isOwner, total) {
  const none = { onCredit: false, amountPaid: undefined, credit: 0 };
  if (!isOwner) return none;
  if (body.amountPaid == null || body.amountPaid === '') return none;
  const paid = Number(body.amountPaid);
  if (!Number.isFinite(paid) || paid < 0) throw httpError(400, 'Enter how much you paid, or leave it empty if you paid in full');
  const amountPaid = round2(paid);
  if (amountPaid > total) throw httpError(400, 'You entered more than the purchase cost. Enter what you paid, up to the total.');
  const credit = round2(total - amountPaid);
  return { onCredit: credit > 0, amountPaid, credit };
}

function money(n) {
  return `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// A purchase sent with photos arrives as multipart form data with the purchase itself in a JSON `payload` field.
// A purchase sent without photos is plain JSON.
function readBody(req) {
  if (typeof req.body?.payload !== 'string') return req.body || {};
  try {
    return JSON.parse(req.body.payload);
  } catch {
    throw httpError(400, 'The purchase data could not be read');
  }
}

async function listPurchases(req, res, next) {
  try {
    // only the administrator ever gets supplier details
    let query = Purchase.find({ business: req.businessId }).populate('product', 'name sku images');
    if (canSeeCosts(req.user)) query = query.populate('supplier', 'name');
    const purchases = await query.sort({ date: -1, createdAt: -1 });
    res.json({ purchases: purchasesForUser(req, purchases) });
  } catch (err) {
    next(err);
  }
}

// Reads one line of a purchase from the request and checks the product / colour exists.
// The owner types what each unit cost. A staff never sees or sets costs, so for a staff the cost
// is whatever the product's cost price already is (and the product's cost price is left alone).
async function prepareLine(businessId, raw, position, ownerSetsCost) {
  const qty = Number(raw.quantity);
  const label = `Item ${position}`;
  let cost = Number(raw.costPricePerUnit);

  if (!raw.product || !Number.isFinite(qty) || qty <= 0) {
    throw httpError(400, `${label}: product and quantity are required`);
  }
  if (ownerSetsCost && (raw.costPricePerUnit == null || raw.costPricePerUnit === '' || !Number.isFinite(cost) || cost < 0)) {
    throw httpError(400, `${label}: product, quantity and cost per unit are required`);
  }

  const product = await Product.findOne({ _id: raw.product, business: businessId, isActive: true });
  if (!product) throw httpError(404, `${label}: product not found`);

  let variant = null;
  if (product.variants.length > 0) {
    if (!raw.variant) throw httpError(400, `${label}: choose which colour / size of ${product.name} was received`);
    variant = product.variants.id(raw.variant);
    if (!variant) throw httpError(404, `${label}: colour / size not found`);
  } else if (raw.variant) {
    throw httpError(400, `${label}: ${product.name} has no colours / sizes`);
  }

  // IMEI / serial numbers of the units received: optional, but all of them or none
  const serials = cleanSerialList(raw.serials, label);
  if (serials.length > 0) {
    if (!product.tracksSerials) throw httpError(400, `${label}: ${product.name} is not tracked by IMEI / serial number. Turn that on in the product first.`);
    if (serials.length !== qty) {
      throw httpError(400, `${label}: you are receiving ${qty} but entered ${serials.length} IMEI / serial numbers. Enter all of them, or leave them out.`);
    }
  }

  const previousCost = variant ? variant.costPrice : product.costPrice;
  if (!ownerSetsCost) {
    const known = variant && variant.costPrice != null ? variant.costPrice : product.costPrice;
    cost = Number(known) || 0;
  }

  return {
    product,
    variant,
    qty,
    cost,
    totalCost: qty * cost,
    serials,
    previousCost,
    keepCost: !ownerSetsCost,
  };
}

// Puts a purchase's stock change back (used when something fails part-way).
function undoStock(businessId, step) {
  const filter = { _id: step.productId, business: businessId };
  const update = { $inc: { quantity: -step.qty } };
  if (step.variantId) {
    filter['variants._id'] = step.variantId;
    update.$inc['variants.$.quantity'] = -step.qty;
    if (step.keepCost) {
      // the cost price was not changed, so there is nothing to put back
    } else if (step.previousCost !== undefined && step.previousCost !== null) update.$set = { 'variants.$.costPrice': step.previousCost };
    else update.$unset = { 'variants.$.costPrice': '' };
  } else if (!step.keepCost && step.previousCost !== undefined && step.previousCost !== null) {
    update.$set = { costPrice: step.previousCost };
  }
  return Product.updateOne(filter, update).catch(() => {});
}

// Records one purchase. Several colours (or items) received at once are sent as `items`;
// each one is saved as its own purchase line, tied together by a shared purchaseGroup id.
// The older single-item shape (product / variant / quantity / costPricePerUnit) still works.
async function createPurchase(req, res, next) {
  const applied = []; // stock already added, remembered so it can be taken off again if anything fails
  const unitIds = []; // serial units already created, removed again if the purchase fails
  let creditApplied = null; // what was added to the supplier's balance, taken off again if the purchase fails
  let groupId = null;
  const files = req.files || []; // photos already uploaded by multer; removed again if the purchase fails

  try {
    const body = readBody(req);
    if (files.length > MAX_PURCHASE_PHOTOS) {
      throw httpError(400, `A purchase can have at most ${MAX_PURCHASE_PHOTOS} photos.`);
    }

    const { supplier: supplierId, purchasedBy, batchNumber, date } = body;
    const isOwner = canSeeCosts(req.user);

    const rawItems =
      Array.isArray(body.items) && body.items.length > 0
        ? body.items
        : [
            {
              product: body.product,
              variant: body.variant,
              quantity: body.quantity,
              costPricePerUnit: body.costPricePerUnit,
              serials: body.serials,
            },
          ];

    if (rawItems.length > 50) throw httpError(400, 'A purchase can have at most 50 items.');

    const lines = [];
    const seen = new Set();
    for (let i = 0; i < rawItems.length; i += 1) {
      const line = await prepareLine(req.businessId, rawItems[i] || {}, i + 1, isOwner);
      const key = `${line.product._id}|${line.variant ? line.variant._id : ''}`;
      if (seen.has(key)) {
        const what = line.variant ? `${line.product.name} (${variantLabel(line.variant)})` : line.product.name;
        throw httpError(400, `${what} is listed twice. Add its quantities together in one item.`);
      }
      seen.add(key);
      lines.push(line);
    }

    // IMEI / serial numbers: not twice in this purchase, and none that the shop already has on record
    const allSerials = lines.flatMap((l) => l.serials);
    if (new Set(allSerials).size !== allSerials.length) {
      const dup = allSerials.find((s, i) => allSerials.indexOf(s) !== i);
      throw httpError(400, `${dup} is listed twice in this purchase`);
    }
    await assertSerialsNew(req.businessId, allSerials);

    // The administrator records who the goods came from (every supplier needs a phone number).
    // A staff never sees or picks a supplier: their purchase is saved without one and the administrator adds it later.
    let supplier = null;
    if (isOwner) {
      if (!supplierId) throw httpError(400, "The supplier's phone number is required to record a purchase");
      supplier = await Supplier.findOne({ _id: supplierId, business: req.businessId });
      if (!supplier) throw httpError(404, 'Supplier not found');
      if (!clean(supplier.phone)) {
        throw httpError(400, 'This supplier has no phone number. Add their phone number on the Suppliers page first.');
      }
    }

    let purchaseDate = new Date();
    if (date) {
      const parsed = new Date(date);
      if (Number.isNaN(parsed.getTime())) throw httpError(400, 'Invalid date');
      purchaseDate = parsed;
    }

    const delivery = readDelivery(body);
    const total = round2(lines.reduce((sum, l) => sum + l.totalCost, 0));
    const payment = readPayment(body, isOwner, total);

    // Add the stock (and remember the new cost price) for every line.
    const updatedProducts = new Map();
    for (const line of lines) {
      const { product, variant, qty, cost, keepCost } = line;
      const filter = { _id: product._id, business: req.businessId };
      const update = { $inc: { quantity: qty } };
      if (!keepCost) update.$set = { costPrice: cost };
      if (variant) {
        filter['variants._id'] = variant._id;
        update.$inc['variants.$.quantity'] = qty;
        if (!keepCost) update.$set['variants.$.costPrice'] = cost;
      }

      const updated = await Product.findOneAndUpdate(filter, update, { new: true });
      if (!updated) throw httpError(404, `${product.name} could not be updated. It may have just been deleted.`);
      applied.push({
        productId: product._id,
        variantId: variant ? variant._id : null,
        qty,
        previousCost: line.previousCost,
        keepCost,
      });
      updatedProducts.set(String(product._id), updated);
    }

    if (lines.length > 1) groupId = new mongoose.Types.ObjectId();
    for (const line of lines) line.purchaseId = new mongoose.Types.ObjectId();

    // record each received unit (before the purchase lines, so a clash with another user is caught first)
    const unitDocs = lines.flatMap((line) =>
      receivedUnitDocs({
        businessId: req.businessId,
        line: { ...line, variantLabel: line.variant ? variantLabel(line.variant) : undefined },
        serials: line.serials,
        purchaseId: line.purchaseId,
        supplierName: supplier ? supplier.name : undefined,
        date: purchaseDate,
        cost: line.cost,
      })
    );
    if (unitDocs.length > 0) {
      unitIds.push(...unitDocs.map((d) => d._id));
      try {
        await SerialUnit.insertMany(unitDocs);
      } catch (err) {
        if (err && (err.code === 11000 || (err.writeErrors && err.writeErrors.length))) {
          throw httpError(409, 'One of those IMEI / serial numbers was just recorded by someone else. Check them and try again.');
        }
        throw err;
      }
    }

    // what is still owed to the supplier goes on their balance (before the lines are saved, so a failure can undo it)
    if (supplier && payment.credit > 0) {
      await Supplier.updateOne({ _id: supplier._id, business: req.businessId }, { $inc: { balance: payment.credit } });
      creditApplied = { supplierId: supplier._id, amount: payment.credit };
    }

    const photos = files.map((file) => ({ url: file.path, publicId: file.filename }));
    const docs = lines.map((line, index) => ({
      _id: line.purchaseId,
      business: req.businessId,
      purchaseGroup: groupId || undefined,
      product: line.product._id,
      variant: line.variant ? line.variant._id : undefined,
      variantLabel: line.variant ? variantLabel(line.variant) : undefined,
      supplier: supplier ? supplier._id : undefined,
      supplierName: supplier ? supplier.name : undefined,
      purchasedBy: clean(purchasedBy) || req.user.name,
      quantity: line.qty,
      serials: line.serials,
      costPricePerUnit: line.cost,
      totalCost: line.totalCost,
      batchNumber: clean(batchNumber) || undefined,
      date: purchaseDate,
      // with several items, the delivery fee and the photos are kept on the first one
      deliveryPaidByUs: index === 0 ? delivery.deliveryPaidByUs : false,
      deliveryCost: index === 0 ? delivery.deliveryCost : 0,
      onCredit: payment.onCredit,
      amountPaid: index === 0 ? payment.amountPaid : undefined,
      creditAmount: index === 0 && (payment.amountPaid !== undefined || payment.onCredit) ? payment.credit : undefined,
      images: index === 0 ? photos : [],
      recordedBy: req.user._id,
    }));

    const purchases = await Purchase.insertMany(docs);
    applied.length = 0; // saved successfully, nothing to take off
    unitIds.length = 0;
    creditApplied = null;
    groupId = null;

    const units = lines.reduce((s, l) => s + l.qty, 0);
    const what = lines.length === 1 ? `${lines[0].qty} × ${lines[0].product.name}` : `${lines.length} items (${units} units)`;
    logActivity(req, {
      action: 'purchase.create',
      summary: `Recorded a purchase of ${what}${supplier ? ` from ${supplier.name}` : ' (supplier not set yet)'}${payment.onCredit ? ` on credit (${money(payment.credit)} owed)` : ''}`,
      entityType: 'Purchase',
      entityId: purchases[0]._id,
      meta: { items: lines.length, units, ...(payment.onCredit ? { credit: payment.credit } : {}) },
    });

    res.status(201).json({
      purchase: purchaseForUser(req, purchases[0]), // photos are attached to the first line
      purchases: purchasesForUser(req, purchases),
      products: productsForUser(req, Array.from(updatedProducts.values())),
      product: productForUser(req, updatedProducts.get(String(lines[0].product._id))),
    });
  } catch (err) {
    if (groupId) await Purchase.deleteMany({ purchaseGroup: groupId }).catch(() => {});
    if (creditApplied) {
      await Supplier.updateOne({ _id: creditApplied.supplierId, business: req.businessId }, { $inc: { balance: -creditApplied.amount } }).catch(() => {});
    }
    if (unitIds.length > 0) await SerialUnit.deleteMany({ business: req.businessId, _id: { $in: unitIds } }).catch(() => {});
    for (const step of applied) await undoStock(req.businessId, step);
    // the purchase was not recorded, so its photos must not pile up in Cloudinary
    await Promise.all(files.map((f) => cloudinary.uploader.destroy(f.filename).catch(() => {})));
    next(err);
  }
}

async function getPurchase(req, res, next) {
  try {
    let query = Purchase.findOne({ _id: req.params.id, business: req.businessId }).populate('product', 'name sku');
    if (canSeeCosts(req.user)) query = query.populate('supplier', 'name phone address email');
    const purchase = await query;
    if (!purchase) throw httpError(404, 'Purchase not found');

    // Every line of the same purchase (this one included), oldest first. The first line holds the photos.
    let group = [];
    if (purchase.purchaseGroup) {
      group = await Purchase.find({ business: req.businessId, purchaseGroup: purchase.purchaseGroup })
        .populate('product', 'name sku')
        .sort({ _id: 1 });
    }

    res.json({ purchase: purchaseForUser(req, purchase), group: purchasesForUser(req, group) });
  } catch (err) {
    next(err);
  }
}

// PUT /api/purchases/:id/supplier   body: { supplier, amountPaid? }   (administrator only)
// Adds the supplier to a purchase a staff recorded without one (every line received together gets it), and says what
// was paid for the goods: leave amountPaid out for "paid in full", or give what was paid and the rest is added to what
// is owed to that supplier. A purchase that already has a supplier cannot be changed.
async function assignSupplier(req, res, next) {
  const claimed = []; // lines that now carry the supplier, put back if anything fails
  let creditApplied = null;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Purchase not found');
    const purchase = await Purchase.findOne({ _id: req.params.id, business: req.businessId });
    if (!purchase) throw httpError(404, 'Purchase not found');

    let lines = [purchase];
    if (purchase.purchaseGroup) {
      lines = await Purchase.find({ business: req.businessId, purchaseGroup: purchase.purchaseGroup }).sort({ _id: 1 });
    }
    if (lines.some((l) => l.supplier)) throw httpError(409, 'This purchase already has a supplier.');

    if (!req.body.supplier || !mongoose.isValidObjectId(req.body.supplier)) throw httpError(400, 'Choose the supplier');
    const supplier = await Supplier.findOne({ _id: req.body.supplier, business: req.businessId });
    if (!supplier) throw httpError(404, 'Supplier not found');
    if (!clean(supplier.phone)) {
      throw httpError(400, 'This supplier has no phone number. Add their phone number on the Suppliers page first.');
    }

    const total = round2(lines.reduce((sum, l) => sum + (l.totalCost || 0), 0));
    const payment = readPayment(req.body, true, total);

    for (let i = 0; i < lines.length; i += 1) {
      const set = { supplier: supplier._id, supplierName: supplier.name, onCredit: payment.onCredit };
      if (i === 0 && (payment.amountPaid !== undefined || payment.onCredit)) {
        set.amountPaid = payment.amountPaid === undefined ? 0 : payment.amountPaid;
        set.creditAmount = payment.credit;
      }
      // only a line that still has no supplier is taken, so two people adding one at the same moment cannot both win
      const result = await Purchase.updateOne({ _id: lines[i]._id, business: req.businessId, supplier: null }, { $set: set });
      if (!result || !result.matchedCount) throw httpError(409, 'This purchase already has a supplier.');
      claimed.push(lines[i]._id);
    }

    if (payment.credit > 0) {
      await Supplier.updateOne({ _id: supplier._id, business: req.businessId }, { $inc: { balance: payment.credit } });
      creditApplied = payment.credit;
    }

    // the units received on these lines now say who they came from
    await SerialUnit.updateMany(
      { business: req.businessId, purchase: { $in: lines.map((l) => l._id) } },
      { $set: { supplierName: supplier.name, 'events.0.note': supplier.name } }
    ).catch(() => {});

    claimed.length = 0;
    creditApplied = null;

    logActivity(req, {
      action: 'purchase.supplier',
      summary: `Added ${supplier.name} as the supplier of a purchase${payment.onCredit ? ` (on credit, ${money(payment.credit)} owed)` : ''}`,
      entityType: 'Purchase',
      entityId: purchase._id,
      meta: { lines: lines.length, ...(payment.onCredit ? { credit: payment.credit } : {}) },
    });

    const saved = await Purchase.find({ business: req.businessId, _id: { $in: lines.map((l) => l._id) } }).sort({ _id: 1 });
    res.json({ purchase: purchaseForUser(req, saved.find((l) => String(l._id) === String(purchase._id)) || saved[0]), purchases: purchasesForUser(req, saved) });
  } catch (err) {
    if (creditApplied) {
      const sid = req.body && req.body.supplier;
      await Supplier.updateOne({ _id: sid, business: req.businessId }, { $inc: { balance: -creditApplied } }).catch(() => {});
    }
    for (const id of claimed) {
      await Purchase.updateOne(
        { _id: id, business: req.businessId },
        { $unset: { supplier: '', supplierName: '', amountPaid: '', creditAmount: '' }, $set: { onCredit: false } }
      ).catch(() => {});
    }
    next(err);
  }
}

module.exports = { listPurchases, getPurchase, createPurchase, assignSupplier };
