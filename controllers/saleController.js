const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const { cloudinary } = require('../config/cloudinary');
const { httpError } = require('../utils/httpError');
const { variantLabel } = require('../utils/variants');
const { productForUser, productsForUser, saleForUser, salesForUser } = require('../utils/staffView');
const { withSellerPhotos, withSellerPhoto } = require('../utils/sellerPhotos');
const { can } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');
const SaleReturn = require('../models/SaleReturn');
const { returnsForUser } = require('../utils/staffView');
const { cleanSerialList, readWarrantyMonths, addMonths } = require('../utils/serials');
const { claimForSale, undoClaim } = require('../utils/serialUnits');

// Everyone with "See all sales" / "See insights" sees every sale; anyone else only the ones they recorded.
function seesAllSales(req) {
  return can(req.user, 'viewAllSales', 'viewInsights');
}

function money(n) {
  return `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const MAX_SALE_PHOTOS = 8;

// "Are you paying for the delivery?" Yes means the business pays and the amount is required.
// No (or not answered) means the customer pays, so there is no delivery cost to record.
function readDelivery(body) {
  const paidByUs = body.deliveryPaidByUs === true || body.deliveryPaidByUs === 'true';
  if (!paidByUs) return { deliveryPaidByUs: false, deliveryCost: 0 };

  const cost = Number(body.deliveryCost);
  if (body.deliveryCost == null || body.deliveryCost === '' || !Number.isFinite(cost) || cost <= 0) {
    throw httpError(400, 'Enter how much you paid for the delivery');
  }
  return { deliveryPaidByUs: true, deliveryCost: cost };
}

// A sale sent with photos arrives as multipart form data with the sale itself in a JSON `payload` field.
// A sale sent without photos is plain JSON.
function readBody(req) {
  if (typeof req.body?.payload !== 'string') return req.body || {};
  try {
    return JSON.parse(req.body.payload);
  } catch {
    throw httpError(400, 'The sale data could not be read');
  }
}

async function listSales(req, res, next) {
  try {
    const filter = { business: req.businessId };
    if (!seesAllSales(req)) filter.recordedBy = req.user._id;

    const sales = await Sale.find(filter)
      .populate('product', 'name sku images')
      .populate('customer', 'name')
      .sort({ date: -1, createdAt: -1 });
    res.json({ sales: salesForUser(req, await withSellerPhotos(req.businessId, sales)) });
  } catch (err) {
    next(err);
  }
}

// Reads one line of a sale from the request and checks it against the product's stock.
async function prepareLine(businessId, raw, position) {
  const qty = Number(raw.quantity);
  const price = Number(raw.unitPrice);
  const label = `Item ${position}`;

  if (!raw.product || !Number.isFinite(qty) || qty <= 0 || raw.unitPrice == null || raw.unitPrice === '' || !Number.isFinite(price) || price < 0) {
    throw httpError(400, `${label}: product, quantity and unit price are required`);
  }

  const product = await Product.findOne({ _id: raw.product, business: businessId, isActive: true });
  if (!product) throw httpError(404, `${label}: product not found`);

  // Products with colours / sizes must say which one was sold.
  let variant = null;
  if (product.variants.length > 0) {
    if (!raw.variant) throw httpError(400, `${label}: choose which colour / size of ${product.name} was sold`);
    variant = product.variants.id(raw.variant);
    if (!variant) throw httpError(404, `${label}: colour / size not found`);
  } else if (raw.variant) {
    throw httpError(400, `${label}: ${product.name} has no colours / sizes`);
  }

  const available = variant ? variant.quantity : product.quantity;
  if (available < qty) {
    const what = variant ? `${product.name} (${variantLabel(variant)})` : product.name;
    throw httpError(400, `Not enough stock for ${what}. Only ${available} left.`);
  }

  // Tracked products (phones, laptops...): the sale must name every unit by its IMEI / serial number.
  let serials = [];
  if (product.tracksSerials) {
    if (!Number.isInteger(qty)) throw httpError(400, `${label}: ${product.name} is sold one unit at a time (whole numbers only)`);
    serials = cleanSerialList(raw.serials, label);
    if (serials.length !== qty) {
      throw httpError(400, `${label}: enter the IMEI / serial number of each unit of ${product.name}. You are selling ${qty} but entered ${serials.length}.`);
    }
  } else if (cleanSerialList(raw.serials, label).length > 0) {
    throw httpError(400, `${label}: ${product.name} is not tracked by IMEI / serial number. Turn that on in the product first.`);
  }

  const warrantyMonths = readWarrantyMonths(raw.warrantyMonths, product.warrantyMonths, label);

  return { product, variant, qty, price, totalAmount: qty * price, serials, warrantyMonths };
}

// The id the app gave this sale (see Sale.clientId). Optional: older versions of the app do not send one.
function readClientId(body) {
  if (body.clientId == null || body.clientId === '') return null;
  if (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) {
    throw httpError(400, 'The sale id is not valid');
  }
  return body.clientId;
}

// A sale with this id that is already recorded (by this same person), as the lines that were saved.
async function findRecorded(req, clientId) {
  if (!clientId) return null;
  const first = await Sale.findOne({ business: req.businessId, clientId });
  if (!first) return null;
  if (String(first.recordedBy) !== String(req.user._id)) throw httpError(409, 'This sale id was already used.');
  const sales = first.saleGroup ? await Sale.find({ business: req.businessId, saleGroup: first.saleGroup }).sort({ createdAt: 1, _id: 1 }) : [first];
  // the line that carries the id is always the first one
  return [first, ...sales.filter((s) => String(s._id) !== String(first._id))];
}

function sendRecorded(req, res, sales) {
  res.status(200).json({ duplicate: true, sale: saleForUser(req, sales[0]), sales: salesForUser(req, sales) });
}

// Records one sale. A customer buying several colours (or items) at once sends them as `items`;
// each one is saved as its own sale line, tied together by a shared saleGroup id.
// The older single-item shape (product / variant / quantity / unitPrice) still works.
async function createSale(req, res, next) {
  const taken = []; // stock already removed, remembered so it can be put back if anything fails
  const claimed = []; // serial units already given to this sale, remembered so they can be freed again
  let groupId = null;
  const files = req.files || []; // photos already uploaded by multer; removed again if the sale fails
  let clientId = null;

  try {
    const body = readBody(req);
    if (files.length > MAX_SALE_PHOTOS) throw httpError(400, `A sale can have at most ${MAX_SALE_PHOTOS} photos.`);

    // The same sale sent again (a lost answer, or one recorded offline) is not recorded twice.
    clientId = readClientId(body);
    const already = await findRecorded(req, clientId);
    if (already) {
      await Promise.all(files.map((f) => cloudinary.uploader.destroy(f.filename).catch(() => {}))); // its photos are saved already
      return sendRecorded(req, res, already);
    }

    const { customer: customerId, customerName, amountPaid, paymentMethod, date } = body;

    const rawItems =
      Array.isArray(body.items) && body.items.length > 0
        ? body.items
        : [
            {
              product: body.product,
              variant: body.variant,
              quantity: body.quantity,
              unitPrice: body.unitPrice,
              serials: body.serials,
              warrantyMonths: body.warrantyMonths,
            },
          ];

    if (rawItems.length > 50) throw httpError(400, 'A sale can have at most 50 items.');

    const lines = [];
    const seen = new Set();
    for (let i = 0; i < rawItems.length; i += 1) {
      const line = await prepareLine(req.businessId, rawItems[i] || {}, i + 1);
      const key = `${line.product._id}|${line.variant ? line.variant._id : ''}`;
      if (seen.has(key)) {
        const what = line.variant ? `${line.product.name} (${variantLabel(line.variant)})` : line.product.name;
        throw httpError(400, `${what} is listed twice. Add its quantities together in one item.`);
      }
      seen.add(key);
      lines.push(line);
    }

    // the same IMEI cannot be on two lines of one sale
    const serialSeen = new Set();
    for (const line of lines) {
      for (const serial of line.serials) {
        if (serialSeen.has(serial)) throw httpError(400, `${serial} is listed twice in this sale`);
        serialSeen.add(serial);
      }
    }

    const grandTotal = lines.reduce((sum, l) => sum + l.totalAmount, 0);
    let paid = amountPaid == null || amountPaid === '' ? grandTotal : Number(amountPaid);
    if (!Number.isFinite(paid) || paid < 0) throw httpError(400, 'amountPaid must be 0 or more');
    paid = Math.min(paid, grandTotal);

    const delivery = readDelivery(body);

    // Every sale needs a customer, and every customer needs a phone number.
    if (!customerId) throw httpError(400, "The customer's phone number is required to record a sale");
    const customer = await Customer.findOne({ _id: customerId, business: req.businessId });
    if (!customer) throw httpError(404, 'Customer not found');
    if (!clean(customer.phone)) {
      throw httpError(400, 'This customer has no phone number. Add their phone number on the Customers page first.');
    }

    let saleDate = new Date();
    if (date) {
      const parsed = new Date(date);
      if (Number.isNaN(parsed.getTime())) throw httpError(400, 'Invalid date');
      saleDate = parsed;
    }

    // Take the stock atomically so two sales at the same moment cannot sell the same last item.
    const updatedProducts = new Map();
    for (const line of lines) {
      const { product, variant, qty } = line;
      const filter = { _id: product._id, business: req.businessId };
      const inc = { quantity: -qty };
      if (variant) {
        filter.variants = { $elemMatch: { _id: variant._id, quantity: { $gte: qty } } };
        inc['variants.$.quantity'] = -qty;
      } else {
        filter.quantity = { $gte: qty };
      }

      const updated = await Product.findOneAndUpdate(filter, { $inc: inc }, { new: true });
      if (!updated) {
        const what = variant ? `${product.name} (${variantLabel(variant)})` : product.name;
        throw httpError(400, `Not enough stock for ${what}. Someone may have just sold the last items.`);
      }
      taken.push({ productId: product._id, variantId: variant ? variant._id : null, qty });
      updatedProducts.set(String(product._id), updated);
    }

    if (lines.length > 1) groupId = new mongoose.Types.ObjectId();

    // Give each tracked unit to this sale (one at a time, so the same IMEI can never be sold twice).
    // The ids of the sale lines are made now so the units can point at them.
    for (const line of lines) line.saleId = new mongoose.Types.ObjectId();
    for (const line of lines) {
      if (line.serials.length === 0) continue;
      line.warrantyEndsAt = line.warrantyMonths > 0 ? addMonths(saleDate, line.warrantyMonths) : undefined;
      await claimForSale({
        businessId: req.businessId,
        product: line.product,
        variant: line.variant,
        variantText: line.variant ? variantLabel(line.variant) : undefined,
        serials: line.serials,
        saleId: line.saleId,
        saleGroup: groupId,
        customer: customer._id,
        customerName: clean(customerName) || customer.name,
        soldAt: saleDate,
        soldBy: req.user._id,
        warrantyMonths: line.warrantyMonths,
        warrantyEndsAt: line.warrantyEndsAt,
        claimed,
      });
    }

    // Share the money paid across the lines in order.
    let remaining = paid;
    const photos = files.map((file) => ({ url: file.path, publicId: file.filename }));
    const docs = lines.map((line, index) => {
      const linePaid = Math.min(remaining, line.totalAmount);
      remaining -= linePaid;
      if (line.serials.length === 0) line.warrantyEndsAt = line.warrantyMonths > 0 ? addMonths(saleDate, line.warrantyMonths) : undefined;
      return {
        _id: line.saleId,
        business: req.businessId,
        saleGroup: groupId || undefined,
        product: line.product._id,
        variant: line.variant ? line.variant._id : undefined,
        variantLabel: line.variant ? variantLabel(line.variant) : undefined,
        customer: customer ? customer._id : undefined,
        customerName: clean(customerName) || (customer ? customer.name : ''),
        // every sale carries the name of the person who is signed in and recorded it
        sellerName: req.user.name,
        quantity: line.qty,
        serials: line.serials,
        warrantyMonths: line.warrantyMonths,
        warrantyEndsAt: line.warrantyEndsAt,
        unitPrice: line.price,
        totalAmount: line.totalAmount,
        amountPaid: linePaid,
        paymentStatus: linePaid >= line.totalAmount ? 'paid' : linePaid > 0 ? 'partial' : 'credit',
        paymentMethod,
        date: saleDate,
        // with several items, the delivery fee and the photos are kept on the first one
        deliveryPaidByUs: index === 0 ? delivery.deliveryPaidByUs : false,
        deliveryCost: index === 0 ? delivery.deliveryCost : 0,
        images: index === 0 ? photos : [],
        clientId: index === 0 && clientId ? clientId : undefined,
        recordedBy: req.user._id,
      };
    });

    const sales = await Sale.insertMany(docs);
    taken.length = 0; // saved successfully, nothing to put back
    claimed.length = 0; // the units now belong to the saved sale lines
    groupId = null;

    if (customer && paid < grandTotal) {
      await Customer.updateOne({ _id: customer._id }, { $inc: { balance: grandTotal - paid } });
    }

    const what = lines.length === 1 ? `${lines[0].qty} × ${lines[0].product.name}` : `${lines.length} items`;
    logActivity(req, {
      action: 'sale.create',
      summary: `Recorded a sale of ${money(grandTotal)} (${what}) to ${clean(customerName) || customer.name}${paid < grandTotal ? `, ${money(grandTotal - paid)} still owed` : ''}`,
      entityType: 'Sale',
      entityId: sales[0]._id,
      meta: { total: grandTotal, paid, items: lines.length },
    });

    res.status(201).json({
      sale: saleForUser(req, sales[0]), // photos are attached to the first line
      sales: salesForUser(req, sales),
      products: productsForUser(req, Array.from(updatedProducts.values())),
      product: productForUser(req, updatedProducts.get(String(lines[0].product._id))),
    });
  } catch (err) {
    if (groupId) await Sale.deleteMany({ saleGroup: groupId }).catch(() => {});
    await undoClaim(req.businessId, claimed);
    // the sale was not recorded, so its photos must not pile up in Cloudinary
    await Promise.all(files.map((f) => cloudinary.uploader.destroy(f.filename).catch(() => {})));
    for (const t of taken) {
      const filter = { _id: t.productId, business: req.businessId };
      const inc = { quantity: t.qty };
      if (t.variantId) {
        filter['variants._id'] = t.variantId;
        inc['variants.$.quantity'] = t.qty;
      }
      await Product.updateOne(filter, { $inc: inc }).catch(() => {});
    }
    // Two copies of the same sale arrived at the same moment, and the other copy got there first: its stock or IMEI
    // numbers are why this one failed, and its sale is about to be saved. Look for it for a moment instead of
    // telling the person their sale failed. (Only for the kinds of failure a clash can cause.)
    if (clientId && (err.statusCode === 400 || err.statusCode === 409 || err.code === 11000)) {
      try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const winner = await findRecorded(req, clientId);
          if (winner) return sendRecorded(req, res, winner);
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (lookupErr) {
        // fall through to the original error
      }
    }
    next(err);
  }
}

async function getSale(req, res, next) {
  try {
    const filter = { _id: req.params.id, business: req.businessId };
    if (!seesAllSales(req)) filter.recordedBy = req.user._id;

    const sale = await Sale.findOne(filter)
      .populate('product', 'name sku')
      .populate('customer', 'name phone address');
    if (!sale) throw httpError(404, 'Sale not found');

    // Every line of the same sale (this one included), oldest first. The first line holds the photos.
    let group = [];
    if (sale.saleGroup) {
      group = await Sale.find({ business: req.businessId, saleGroup: sale.saleGroup })
        .populate('product', 'name sku')
        .sort({ _id: 1 });
    }

    // returns made on any line of this sale
    const lineIds = (group.length > 0 ? group : [sale]).map((l) => l._id);
    const returns = await SaleReturn.find({ business: req.businessId, sales: { $in: lineIds } }).sort({ date: -1, createdAt: -1 });

    res.json({
      sale: saleForUser(req, await withSellerPhoto(req.businessId, sale)),
      group: salesForUser(req, await withSellerPhotos(req.businessId, group)),
      returns: returnsForUser(req, returns),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listSales, getSale, createSale };
