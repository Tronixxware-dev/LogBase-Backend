// What happens to IMEI / serial units when stock is received, sold or taken back.
// Every step is atomic on its own unit, and every step returns what it needs so the caller can undo it
// if a later step fails (there are no database transactions in this app).

const mongoose = require('mongoose');
const SerialUnit = require('../models/SerialUnit');
const { httpError } = require('./httpError');

const STATUS_TEXT = { in_stock: 'already in stock', sold: 'already sold', written_off: 'written off' };

function dayText(date) {
  return date ? new Date(date).toISOString().slice(0, 10) : '';
}

// The fields that say "this unit is with a customer"; removed again when it comes back.
const SOLD_FIELDS = ['sale', 'saleGroup', 'customer', 'customerName', 'soldAt', 'soldBy', 'warrantyMonths', 'warrantyEndsAt'];
const clearSold = () => Object.fromEntries(SOLD_FIELDS.map((f) => [f, '']));

// Before receiving stock: none of these numbers may exist already (read-only, so nothing needs undoing).
async function assertSerialsNew(businessId, serials) {
  if (serials.length === 0) return;
  const found = await SerialUnit.find({ business: businessId, serial: { $in: serials } });
  if (found.length > 0) {
    const u = found[0];
    throw httpError(409, `${u.serial} is ${STATUS_TEXT[u.status] || 'already recorded'}. Each IMEI / serial number can be received only once.`);
  }
}

// Documents for units received on one purchase line (not saved yet). Ids are made here so the caller can remove them again.
function receivedUnitDocs({ businessId, line, serials, purchaseId, supplierName, date, cost }) {
  return serials.map((serial) => ({
    _id: new mongoose.Types.ObjectId(),
    business: businessId,
    product: line.product._id,
    variant: line.variant ? line.variant._id : undefined,
    variantLabel: line.variantLabel || undefined,
    serial,
    status: 'in_stock',
    purchase: purchaseId,
    supplierName: supplierName || undefined,
    receivedAt: date,
    costPrice: cost,
    events: [{ type: 'received', at: date, note: supplierName || undefined, ref: purchaseId }],
  }));
}

// Takes the given serial numbers for a sale. Each one must be in stock under this product (and colour / size).
// A number the shop has never recorded is accepted and recorded as sold (stock bought before serials were tracked).
// Returns [{ id, created, prev }] for undoing.
async function claimForSale({ businessId, product, variant, variantText, serials, saleId, saleGroup, customer, customerName, soldAt, soldBy, warrantyMonths, warrantyEndsAt, claimed }) {
  for (const serial of serials) {
    const sold = {
      status: 'sold',
      sale: saleId,
      saleGroup: saleGroup || undefined,
      customer: customer || undefined,
      customerName: customerName || undefined,
      soldAt,
      soldBy,
      warrantyMonths,
      warrantyEndsAt: warrantyEndsAt || undefined,
    };
    const event = { type: 'sold', at: soldAt, note: customerName || undefined, ref: saleId };
    const filter = { business: businessId, serial, product: product._id, status: 'in_stock' };
    if (variant) filter.variant = variant._id;

    const prev = await SerialUnit.findOneAndUpdate(filter, { $set: sold, $push: { events: event } });
    if (prev) {
      claimed.push({ id: prev._id, created: false });
      continue;
    }

    const existing = await SerialUnit.findOne({ business: businessId, serial });
    if (!existing) {
      try {
        const unit = await SerialUnit.create({
          business: businessId,
          product: product._id,
          variant: variant ? variant._id : undefined,
          variantLabel: variantText || undefined,
          serial,
          ...sold,
          events: [event],
        });
        claimed.push({ id: unit._id, created: true });
        continue;
      } catch (err) {
        if (err && err.code === 11000) throw httpError(409, `${serial} was just recorded by someone else. Check it and try again.`);
        throw err;
      }
    }
    if (String(existing.product) !== String(product._id)) throw httpError(400, `${serial} is recorded under a different product, not ${product.name}.`);
    if (variant && String(existing.variant || '') !== String(variant._id)) throw httpError(400, `${serial} is recorded under a different colour / size.`);
    if (existing.status === 'sold') {
      const who = existing.customerName ? ` to ${existing.customerName}` : '';
      throw httpError(409, `${serial} was already sold on ${dayText(existing.soldAt)}${who}. If it came back, record the return first.`);
    }
    if (existing.status === 'written_off') throw httpError(409, `${serial} was written off and cannot be sold.`);
    throw httpError(409, `${serial} was just taken by another sale. Try again.`);
  }
}

// Puts claimed units back (undo of claimForSale).
async function undoClaim(businessId, claimed) {
  for (const c of claimed) {
    if (c.created) await SerialUnit.deleteMany({ _id: c.id, business: businessId }).catch(() => {});
    else {
      await SerialUnit.updateOne(
        { _id: c.id, business: businessId },
        { $set: { status: 'in_stock' }, $unset: clearSold(), $pop: { events: 1 } }
      ).catch(() => {});
    }
  }
}

// A customer brings units back: they leave the customer (the warranty record ends) and either go back on the
// shelf or are written off. Returns the units as they were, for undoing.
async function releaseForReturn({ businessId, saleLineId, serials, restock, customerName, at, released }) {
  for (const serial of serials) {
    const set = { status: restock ? 'in_stock' : 'written_off' };
    const event = { type: restock ? 'returned' : 'written_off', at, note: customerName || undefined, ref: saleLineId };
    const prev = await SerialUnit.findOneAndUpdate(
      { business: businessId, serial, status: 'sold', sale: saleLineId },
      { $set: set, $unset: clearSold(), $push: { events: event } }
    );
    // a unit that is not found simply has no record to update; the sale line is still corrected
    if (prev) released.push(prev.toObject ? prev.toObject() : prev);
  }
}

// Undo of releaseForReturn.
async function undoRelease(businessId, released) {
  for (const p of released) {
    const set = { status: 'sold' };
    for (const f of SOLD_FIELDS) if (p[f] !== undefined && p[f] !== null) set[f] = p[f];
    await SerialUnit.updateOne({ _id: p._id, business: businessId }, { $set: set, $pop: { events: 1 } }).catch(() => {});
  }
}

module.exports = { assertSerialsNew, receivedUnitDocs, claimForSale, undoClaim, releaseForReturn, undoRelease, STATUS_TEXT };
