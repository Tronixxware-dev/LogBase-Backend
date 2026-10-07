const Sale = require('../models/Sale');
const SaleReturn = require('../models/SaleReturn');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const { httpError } = require('../utils/httpError');
const { variantLabel } = require('../utils/variants');
const { round2, splitReturn } = require('../utils/money');
const { can } = require('../utils/permissions');
const { returnForUser, returnsForUser, salesForUser } = require('../utils/staffView');
const { logActivity } = require('../utils/audit');
const { withSellerPhotos } = require('../utils/sellerPhotos');
const { cleanSerialList } = require('../utils/serials');
const { releaseForReturn, undoRelease } = require('../utils/serialUnits');

const REASONS = ['defective', 'wrong_item', 'changed_mind', 'other'];
const REFUND_METHODS = ['cash', 'transfer', 'credit'];
const REASON_LABELS = {
  defective: 'Faulty or damaged',
  wrong_item: 'Wrong item',
  changed_mind: 'Changed their mind',
  other: 'Other reason',
};

function seesAllSales(req) {
  return can(req.user, 'viewAllSales', 'viewInsights');
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function money(n) {
  return `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function nameOf(line, product) {
  const base = (product && product.name) || 'item';
  return line.variantLabel ? `${base} (${line.variantLabel})` : base;
}

// What each unit of this product / colour cost the business (only ever shown to the administrator).
function unitCostOf(product, variantId) {
  if (!product) return 0;
  if (variantId && Array.isArray(product.variants)) {
    const v = product.variants.id ? product.variants.id(variantId) : product.variants.find((x) => String(x._id) === String(variantId));
    if (v && v.costPrice != null) return Number(v.costPrice) || 0;
  }
  return Number(product.costPrice) || 0;
}

// Puts returned units back on the shelf (atomic, on the product and on its colour / size).
// Returns false when the product or colour no longer exists, so nothing could be put back.
async function putBack(businessId, line, qty) {
  const filter = { _id: line.product, business: businessId };
  const inc = { quantity: qty };
  if (line.variant) {
    filter['variants._id'] = line.variant;
    inc['variants.$.quantity'] = qty;
  }
  const result = await Product.updateOne(filter, { $inc: inc });
  return (result.matchedCount ?? result.n ?? 0) > 0;
}

async function takeBack(businessId, line, qty) {
  const filter = { _id: line.product, business: businessId };
  const inc = { quantity: -qty };
  if (line.variant) {
    filter.variants = { $elemMatch: { _id: line.variant, quantity: { $gte: qty } } };
    inc['variants.$.quantity'] = -qty;
  } else {
    filter.quantity = { $gte: qty };
  }
  await Product.updateOne(filter, { $inc: inc });
}

// POST /api/returns
// body: { items: [{ sale: <sale line id>, quantity }], restock, refundMethod, reason, note }
// Takes units back from one or more lines of the same customer's sales. For every line:
//   - the sale line shrinks (quantity, total, amount paid), so every report is automatically net of returns;
//   - money the customer still owed on it is cancelled first, only the rest has to be given back;
//   - the units go back on the shelf (unless `restock` is false: then their cost is counted as a loss).
// If any step fails, everything already done is undone.
async function createReturn(req, res, next) {
  const applied = []; // sale lines already changed (to undo)
  const restocked = []; // shelves already topped up (to undo)
  const released = []; // IMEI / serial units already freed (to undo)
  let balanceChange = 0;
  let customerId = null;

  try {
    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) throw httpError(400, 'Choose what is being returned');
    if (rawItems.length > 50) throw httpError(400, 'A return can have at most 50 items.');

    const reason = body.reason === undefined || body.reason === '' ? 'other' : body.reason;
    if (!REASONS.includes(reason)) throw httpError(400, 'Choose a reason for the return');
    const restock = !(body.restock === false || body.restock === 'false');
    const note = clean(body.note).slice(0, 500);

    // quantities
    const wanted = new Map(); // sale id -> { qty, serials }
    for (const raw of rawItems) {
      const id = raw && raw.sale ? String(raw.sale) : '';
      const qty = Number(raw && raw.quantity);
      if (!id || !Number.isFinite(qty) || qty <= 0) throw httpError(400, 'Each returned item needs a sale line and a quantity above 0');
      if (wanted.has(id)) throw httpError(400, 'The same item is listed twice. Add its quantities together.');
      wanted.set(id, { qty, serials: cleanSerialList(raw.serials, 'Returned item') });
    }

    // the lines (a person who may only see their own sales may only return those)
    const filter = { _id: { $in: Array.from(wanted.keys()) }, business: req.businessId };
    if (!seesAllSales(req)) filter.recordedBy = req.user._id;
    const lines = await Sale.find(filter);
    if (lines.length !== wanted.size) throw httpError(404, 'Sale not found');

    // one customer per return (a sale group always has one)
    const customerIds = new Set(lines.map((l) => (l.customer ? String(l.customer) : '')));
    if (customerIds.size > 1) throw httpError(400, 'Items from different customers cannot be returned together');
    customerId = lines[0].customer || null;
    const customer = customerId ? await Customer.findOne({ _id: customerId, business: req.businessId }) : null;

    const products = await Product.find({ _id: { $in: lines.map((l) => l.product) }, business: req.businessId });
    const productById = new Map(products.map((p) => [String(p._id), p]));

    // the maths for each line
    const plan = lines.map((line) => {
      const { qty, serials: asked } = wanted.get(String(line._id));
      const product = productById.get(String(line.product));
      if (qty > line.quantity) {
        throw httpError(
          400,
          line.quantity > 0
            ? `Only ${line.quantity} of ${nameOf(line, product)} can still be returned.`
            : `${nameOf(line, product)} has already been returned.`
        );
      }

      // Items sold with IMEI / serial numbers: say which of them are coming back
      const sold = Array.isArray(line.serials) ? line.serials : [];
      let serials = [];
      if (sold.length > 0) {
        if (asked.length === 0) {
          if (qty !== sold.length) throw httpError(400, `Choose which of the ${sold.length} IMEI / serial numbers of ${nameOf(line, product)} are coming back.`);
          serials = [...sold];
        } else {
          if (asked.length !== qty) throw httpError(400, `You are returning ${qty} of ${nameOf(line, product)} but chose ${asked.length} IMEI / serial numbers.`);
          const bad = asked.find((s) => !sold.includes(s));
          if (bad) throw httpError(400, `${bad} was not sold on this line, so it cannot be returned here.`);
          serials = asked;
        }
      } else if (asked.length > 0) {
        throw httpError(400, `${nameOf(line, product)} was sold without IMEI / serial numbers.`);
      }
      return { line, qty, product, serials, ...splitReturn(line, qty) };
    });

    const totalValue = round2(plan.reduce((s, p) => s + p.value, 0));
    const owedReduction = round2(plan.reduce((s, p) => s + p.owedReduction, 0));
    const refundAmount = round2(plan.reduce((s, p) => s + p.refund, 0));

    // how the refund is given. Nothing to give back = no method needed.
    let refundMethod = 'none';
    if (refundAmount > 0) {
      refundMethod = body.refundMethod === undefined || body.refundMethod === '' ? 'cash' : body.refundMethod;
      if (!REFUND_METHODS.includes(refundMethod)) throw httpError(400, 'Choose how the refund is given: cash, transfer or store credit');
      if (refundMethod === 'credit' && !customer) throw httpError(400, 'Store credit needs a customer on the sale');
    }
    const storeCredit = refundMethod === 'credit' ? refundAmount : 0;
    const balanceEffect = round2(owedReduction + storeCredit);

    // 1. shrink the sale lines. The filter holds the numbers we calculated from, so if anyone changed
    //    the line in the meantime nothing is updated and we stop instead of getting the money wrong.
    for (const p of plan) {
      const { line } = p;
      const before = {
        quantity: line.quantity,
        totalAmount: line.totalAmount,
        amountPaid: line.amountPaid,
        paymentStatus: line.paymentStatus,
        returnedQuantity: line.returnedQuantity || 0,
        returnedAmount: line.returnedAmount || 0,
        refundedAmount: line.refundedAmount || 0,
        serials: [...(line.serials || [])],
        returnedSerials: [...(line.returnedSerials || [])],
      };
      const updated = await Sale.findOneAndUpdate(
        {
          _id: line._id,
          business: req.businessId,
          quantity: before.quantity,
          totalAmount: before.totalAmount,
          amountPaid: before.amountPaid,
        },
        {
          $set: {
            quantity: p.newQuantity,
            totalAmount: p.newTotal,
            amountPaid: p.newPaid,
            paymentStatus: p.paymentStatus,
            returnedQuantity: round2(before.returnedQuantity + p.qty),
            returnedAmount: round2(before.returnedAmount + p.value),
            refundedAmount: round2(before.refundedAmount + p.refund),
            serials: before.serials.filter((s) => !p.serials.includes(s)),
            returnedSerials: [...before.returnedSerials, ...p.serials],
          },
        },
        { new: true }
      );
      if (!updated) throw httpError(409, 'This sale was just changed by someone else. Reload the page and try again.');
      applied.push({ id: line._id, before });
      p.updated = updated;
    }

    // 2. put the units back on the shelf
    for (const p of plan) {
      p.restocked = false;
      if (restock) {
        p.restocked = await putBack(req.businessId, p.line, p.qty);
        if (p.restocked) restocked.push({ line: p.line, qty: p.qty });
      }
      p.writtenOffCost = p.restocked ? 0 : round2(p.qty * unitCostOf(p.product, p.line.variant));
      // the tracked units leave the customer: back on the shelf, or written off with the rest
      if (p.serials.length > 0) {
        await releaseForReturn({
          businessId: req.businessId,
          saleLineId: p.line._id,
          serials: p.serials,
          restock: p.restocked,
          customerName: p.line.customerName || (customer && customer.name) || '',
          at: new Date(),
          released,
        });
      }
    }

    // 3. the customer's balance
    balanceChange = -balanceEffect;
    if (customer && balanceChange !== 0) {
      await Customer.updateOne({ _id: customer._id, business: req.businessId }, { $inc: { balance: balanceChange } });
    } else {
      balanceChange = 0;
    }

    // 4. the record of the return
    const writtenOffCost = round2(plan.reduce((s, p) => s + p.writtenOffCost, 0));
    const ret = await SaleReturn.create({
      business: req.businessId,
      sales: plan.map((p) => p.line._id),
      customer: customer ? customer._id : undefined,
      customerName: (plan[0].line.customerName || (customer && customer.name) || '').trim(),
      items: plan.map((p) => ({
        sale: p.line._id,
        saleGroup: p.line.saleGroup || undefined,
        product: p.line.product,
        productName: (p.product && p.product.name) || '',
        variant: p.line.variant || undefined,
        variantLabel: p.line.variantLabel || undefined,
        quantity: p.qty,
        serials: p.serials,
        unitPrice: p.line.unitPrice,
        value: p.value,
        owedReduction: p.owedReduction,
        refund: p.refund,
        restocked: p.restocked,
        writtenOffCost: p.writtenOffCost,
      })),
      totalValue,
      owedReduction,
      refundAmount,
      refundMethod,
      balanceEffect,
      reason,
      note,
      restock,
      writtenOffCost,
      processedBy: req.user._id,
      processedByName: req.user.name,
    });
    applied.length = 0; // saved, nothing to undo
    restocked.length = 0;
    released.length = 0;
    balanceChange = 0;

    const units = plan.reduce((s, p) => s + p.qty, 0);
    const what = plan.length === 1 ? nameOf(plan[0].line, plan[0].product) : `${plan.length} items`;
    const refundText =
      refundAmount > 0
        ? ` ${money(refundAmount)} ${refundMethod === 'credit' ? 'kept as store credit' : 'refunded'}.`
        : '';
    const forName = ret.customerName ? ` from ${ret.customerName}` : '';
    logActivity(req, {
      action: 'return.create',
      summary: `Took back ${units} × ${what}${forName} (worth ${money(totalValue)}).${refundText}`.trim(),
      entityType: 'SaleReturn',
      entityId: ret._id,
      meta: { totalValue, refundAmount, refundMethod, owedReduction, reason, restock },
    });

    res.status(201).json({
      return: returnForUser(req, ret),
      sales: salesForUser(req, await withSellerPhotos(req.businessId, plan.map((p) => p.updated))),
    });
  } catch (err) {
    // put everything back the way it was
    await undoRelease(req.businessId, released.reverse());
    for (const r of restocked.reverse()) await takeBack(req.businessId, r.line, r.qty).catch(() => {});
    for (const a of applied.reverse()) {
      await Sale.updateOne({ _id: a.id, business: req.businessId }, { $set: a.before }).catch(() => {});
    }
    if (customerId && balanceChange !== 0) {
      await Customer.updateOne({ _id: customerId, business: req.businessId }, { $inc: { balance: -balanceChange } }).catch(() => {});
    }
    next(err);
  }
}

// GET /api/returns?sale=<line id>&customer=<id>
// People who see every sale see every return; anyone else only the returns they processed themselves.
async function listReturns(req, res, next) {
  try {
    const filter = { business: req.businessId };
    if (!seesAllSales(req)) filter.processedBy = req.user._id;
    if (req.query.sale) filter.sales = String(req.query.sale);
    if (req.query.customer) filter.customer = String(req.query.customer);

    const returns = await SaleReturn.find(filter).sort({ date: -1, createdAt: -1 }).limit(500);
    res.json({ returns: returnsForUser(req, returns) });
  } catch (err) {
    next(err);
  }
}

module.exports = { createReturn, listReturns, REASONS, REASON_LABELS, REFUND_METHODS };
