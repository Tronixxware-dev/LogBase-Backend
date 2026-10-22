const mongoose = require('mongoose');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const SerialUnit = require('../models/SerialUnit');
const Transfer = require('../models/Transfer');
const { httpError } = require('../utils/httpError');
const { variantLabel } = require('../utils/variants');
const { cleanSerialList } = require('../utils/serials');
const { logActivity } = require('../utils/audit');
const { notifyOwners } = require('../utils/notifications');
const { createNumbered } = require('../utils/sequence');
const { resolveShop, isIdText, moveToTransit, receiveFromTransit, returnFromTransit, decRowGuarded, incRow, quantityInShop } = require('../utils/shopStock');

const LIST_LIMIT = 300;
const STATUS_WORDS = { pending: 'waiting', accepted: 'accepted', declined: 'declined', cancelled: 'cancelled' };

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const tag = (n) => `T-${String(n).padStart(4, '0')}`;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readClientId(body) {
  if (body.clientId == null || body.clientId === '') return null;
  if (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) throw httpError(400, 'The transfer id is not valid');
  return body.clientId;
}

function out(t) {
  return typeof t.toObject === 'function' ? t.toObject() : { ...t };
}

// The serial units of the main store have no `shop` at all; the others carry their store's id.
const shopMatch = (shopId) => (shopId ? shopId : null);

async function loadTransfer(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Transfer not found');
  const transfer = await Transfer.findOne({ _id: req.params.id, business: req.businessId });
  if (!transfer) throw httpError(404, 'Transfer not found');
  return transfer;
}

// Where the stock sits: null for the main store, otherwise the store's id.
async function shopKeyOf(businessId, shopId) {
  const shop = await Shop.findOne({ _id: shopId, business: businessId });
  if (!shop) throw httpError(409, 'One of the stores of this transfer no longer exists.');
  return shop.isMain ? null : shop._id;
}

// Moves the tracked units of a transfer (by IMEI / serial number) from one place to another. A place is a store's id,
// null for the main store, or the transfer's id while the stock is on its way. Only units that really are at `from`
// and in stock move. Returns how many moved.
async function moveSerials({ businessId, productId, serials, from, to, note, transitRef }) {
  if (serials.length === 0) return 0;
  const set = {};
  const update = { $push: { events: { type: 'transferred', at: new Date(), note: note || undefined, ref: transitRef } } };
  if (to) set.shop = to;
  else update.$unset = { shop: '' };
  if (Object.keys(set).length > 0) update.$set = set;
  const result = await SerialUnit.updateMany(
    { business: businessId, product: productId, serial: { $in: serials }, status: 'in_stock', shop: shopMatch(from) },
    update
  );
  return result.modifiedCount ?? result.nModified ?? 0;
}

/* ---------- list / read ---------- */

// GET /api/transfers?direction=incoming|outgoing&status=pending|accepted|declined|cancelled&search=T-0004
// "incoming" and "outgoing" are from the point of view of the store the person is working in.
async function listTransfers(req, res, next) {
  try {
    const shop = await resolveShop(req, undefined);
    const filter = { business: req.businessId };
    const here = shop.doc._id;

    if (req.query.direction === 'incoming') filter.toShop = here;
    else if (req.query.direction === 'outgoing') filter.fromShop = here;
    else filter.$or = [{ toShop: here }, { fromShop: here }];

    const status = req.query.status;
    if (status !== undefined && status !== '' && status !== 'all') {
      if (!STATUS_WORDS[status]) throw httpError(400, 'Unknown status');
      filter.status = status;
    }

    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    if (search) {
      const m = /^t?-?0*(\d{1,9})$/i.exec(search);
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      const or = [{ 'lines.productName': rx }, { fromName: rx }, { toName: rx }];
      if (m) or.push({ number: Number(m[1]) });
      // keep the store condition and add the search next to it
      const storeCondition = filter.$or ? { $or: filter.$or } : null;
      delete filter.$or;
      filter.$and = [...(storeCondition ? [storeCondition] : []), { $or: or }];
    }

    const rows = await Transfer.find(filter).sort({ createdAt: -1, number: -1 }).limit(LIST_LIMIT);
    const waitingForUs = await Transfer.countDocuments({ business: req.businessId, status: 'pending', toShop: here });
    res.json({ transfers: rows.map(out), shop: { _id: shop.doc._id, name: shop.name }, waitingForUs });
  } catch (err) {
    next(err);
  }
}

// GET /api/transfers/:id
async function getTransfer(req, res, next) {
  try {
    res.json({ transfer: out(await loadTransfer(req)) });
  } catch (err) {
    next(err);
  }
}

/* ---------- create ---------- */

// POST /api/transfers
// body: { toShop, fromShop? (the store you are working in), items: [{ product, variant?, quantity, serials? }], note?, clientId? }
// The stock leaves the sending store now and joins the receiving store when it is accepted.
async function createTransfer(req, res, next) {
  const moved = []; // lines already taken out of the sending store (undone if anything fails)
  const serialMoves = []; // tracked units already put on the way
  let transferId = null;
  let created = false;
  let from = null;

  try {
    const body = req.body || {};
    const clientId = readClientId(body);
    if (clientId) {
      const existing = await Transfer.findOne({ business: req.businessId, clientId });
      if (existing) return res.status(200).json({ duplicate: true, transfer: out(existing) });
    }

    from = await resolveShop(req, body.fromShop, { strict: true });
    if (!isIdText(String(body.toShop || ''))) throw httpError(400, 'Choose the store the stock is going to');
    const toDoc = await Shop.findOne({ _id: body.toShop, business: req.businessId });
    if (!toDoc || toDoc.isActive === false) throw httpError(400, 'The receiving store is not available. Choose another store.');
    if (String(toDoc._id) === String(from.doc._id)) throw httpError(400, 'Choose a different store: the stock is already in this one.');

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) throw httpError(400, 'Add at least one item to transfer');
    if (rawItems.length > 50) throw httpError(400, 'A transfer can have at most 50 items.');
    const note = clean(body.note).slice(0, 300);

    const lines = [];
    const seen = new Set();
    for (let i = 0; i < rawItems.length; i += 1) {
      const raw = rawItems[i] || {};
      const label = `Item ${i + 1}`;
      const qty = Number(raw.quantity);
      if (!isIdText(String(raw.product || '')) || !Number.isFinite(qty) || qty <= 0) throw httpError(400, `${label}: choose the product and a quantity above 0`);
      const product = await Product.findOne({ _id: raw.product, business: req.businessId, isActive: true });
      if (!product) throw httpError(404, `${label}: product not found`);

      let variant = null;
      if (product.variants.length > 0) {
        if (!raw.variant) throw httpError(400, `${label}: choose which colour / size of ${product.name}`);
        variant = product.variants.id(raw.variant);
        if (!variant) throw httpError(404, `${label}: colour / size not found`);
      } else if (raw.variant) {
        throw httpError(400, `${label}: ${product.name} has no colours / sizes`);
      }

      const key = `${product._id}|${variant ? variant._id : ''}`;
      if (seen.has(key)) throw httpError(400, `${variant ? `${product.name} (${variantLabel(variant)})` : product.name} is listed twice. Add its quantities together in one item.`);
      seen.add(key);

      let serials = [];
      if (product.tracksSerials) {
        if (!Number.isInteger(qty)) throw httpError(400, `${label}: a tracked product moves in whole units`);
        // The pieces are what count. Naming their IMEI / serial numbers is optional: name only the ones you want to follow.
        serials = cleanSerialList(raw.serials, label);
        if (serials.length > qty) throw httpError(400, `${label}: you are moving ${qty} of ${product.name} but named ${serials.length} IMEI / serial numbers. Raise the pieces or remove some numbers.`);
      } else if (raw.serials && cleanSerialList(raw.serials, label).length > 0) {
        throw httpError(400, `${label}: ${product.name} is not tracked by IMEI / serial number`);
      }
      lines.push({ product, variant, qty, serials });
    }

    // the named units must be in stock in the sending store
    const fromKey = from.id;
    for (const line of lines) {
      if (line.serials.length === 0) continue;
      const found = await SerialUnit.find({ business: req.businessId, product: line.product._id, serial: { $in: line.serials } });
      const byNumber = new Map(found.map((u) => [u.serial, u]));
      for (const serial of line.serials) {
        const unit = byNumber.get(serial);
        if (!unit) throw httpError(400, `${serial} is not recorded for ${line.product.name}. Check the number.`);
        if (unit.status !== 'in_stock') throw httpError(409, `${serial} is not in stock (${unit.status === 'sold' ? 'it was sold' : 'it was written off'}).`);
        if (String(unit.shop || '') !== String(fromKey || '')) throw httpError(409, `${serial} is not in ${from.name}. It is in another store or already on its way.`);
        if (line.variant && String(unit.variant || '') !== String(line.variant._id)) throw httpError(400, `${serial} belongs to a different colour / size.`);
      }
    }

    // Pieces that were not named: the store may hold units nobody recorded an IMEI for, and those just move as a count.
    // When it holds fewer of those than are needed, the oldest recorded units follow, so no record is left behind.
    for (const line of lines) {
      if (!line.product.tracksSerials || line.serials.length >= line.qty) continue;
      const have = await quantityInShop(req.businessId, line.product, line.variant, from);
      const filter = { business: req.businessId, product: line.product._id, status: 'in_stock', shop: shopMatch(fromKey) };
      if (line.variant) filter.variant = line.variant._id;
      const recorded = await SerialUnit.countDocuments(filter);
      const unrecorded = Math.max(0, have - recorded);
      const extra = Math.min(Math.max(0, line.qty - line.serials.length - unrecorded), recorded - line.serials.length);
      if (extra <= 0) continue;
      const picked = await SerialUnit.find({ ...filter, serial: { $nin: line.serials } })
        .sort({ createdAt: 1, _id: 1 })
        .limit(extra);
      line.serials = [...line.serials, ...picked.map((u) => u.serial)];
    }

    transferId = new mongoose.Types.ObjectId();

    // take the stock out of the sending store (atomic per item)
    for (const line of lines) {
      const ok = await moveToTransit({
        businessId: req.businessId,
        productId: line.product._id,
        variantId: line.variant ? line.variant._id : null,
        qty: line.qty,
        fromShopId: fromKey,
        transitId: transferId,
      });
      if (!ok) {
        const what = line.variant ? `${line.product.name} (${variantLabel(line.variant)})` : line.product.name;
        throw httpError(400, `${from.name} does not have ${line.qty} of ${what} to send.`);
      }
      moved.push(line);
    }

    for (const line of lines) {
      if (line.serials.length === 0) continue;
      const count = await moveSerials({
        businessId: req.businessId,
        productId: line.product._id,
        serials: line.serials,
        from: fromKey,
        to: transferId,
        note: `To ${toDoc.name}`,
        transitRef: transferId,
      });
      serialMoves.push(line);
      if (count !== line.serials.length) throw httpError(409, `Some of those IMEI / serial numbers were just taken by someone else. Check them and try again.`);
    }

    let transfer;
    try {
      transfer = await createNumbered(Transfer, req.businessId, 'number', (number) => ({
        _id: transferId,
        number,
        fromShop: from.doc._id,
        fromName: from.name,
        toShop: toDoc._id,
        toName: toDoc.name,
        status: 'pending',
        lines: lines.map((l) => ({
          product: l.product._id,
          productName: l.product.name,
          variant: l.variant ? l.variant._id : undefined,
          variantLabel: l.variant ? variantLabel(l.variant) : undefined,
          quantity: l.qty,
          serials: l.serials,
        })),
        note: note || undefined,
        createdBy: req.user._id,
        createdByName: req.user.name,
        clientId: clientId || undefined,
      }));
    } catch (err) {
      // the same transfer arrived twice at once and the other copy won: give back what this copy took and return the winner
      if (clientId && err && err.code === 11000) {
        await undoCreate(req, { moved, serialMoves, transferId, from });
        moved.length = 0;
        serialMoves.length = 0;
        const winner = await Transfer.findOne({ business: req.businessId, clientId });
        if (winner) return res.status(200).json({ duplicate: true, transfer: out(winner) });
      }
      throw err;
    }
    created = true;

    const what = lines.length === 1 ? `${lines[0].qty} × ${lines[0].product.name}` : `${lines.length} items`;
    logActivity(req, {
      action: 'transfer.create',
      summary: `Sent ${tag(transfer.number)} from ${from.name} to ${toDoc.name}: ${what}`,
      entityType: 'Transfer',
      entityId: transfer._id,
      meta: { items: lines.length, units: lines.reduce((s, l) => s + l.qty, 0) },
    });
    notifyOwners(
      req.businessId,
      { type: 'transfers', title: `${tag(transfer.number)} is on its way to ${toDoc.name}`, body: `${what} sent from ${from.name}. It waits to be received.`, link: `/dashboard/transfers/${transfer._id}` },
      { exceptUserId: req.user._id }
    );
    res.status(201).json({ transfer: out(transfer) });
  } catch (err) {
    if (!created && transferId) await undoCreate(req, { moved, serialMoves, transferId, from });
    next(err);
  }
}

// Puts everything a half-made transfer took back where it was.
async function undoCreate(req, { moved, serialMoves, transferId, from }) {
  const fromKey = from ? from.id : null;
  for (const line of serialMoves) {
    await moveSerialsBack(req.businessId, line, transferId, fromKey).catch(() => {});
  }
  for (const line of moved) {
    await returnFromTransit({
      businessId: req.businessId,
      productId: line.product._id,
      variantId: line.variant ? line.variant._id : null,
      qty: line.qty,
      fromShopId: fromKey,
      transitId: transferId,
    }).catch(() => {});
  }
}

async function moveSerialsBack(businessId, line, transferId, fromKey) {
  await moveSerials({
    businessId,
    productId: line.product._id,
    serials: line.serials,
    from: transferId,
    to: fromKey,
    note: 'Transfer undone',
    transitRef: transferId,
  });
}

/* ---------- accept / decline / cancel ---------- */

// Takes the transfer out of "pending" in one atomic step, so it can only be answered once.
async function claim(req, status, extra) {
  const base = await loadTransfer(req);
  const claimed = await Transfer.findOneAndUpdate(
    { _id: base._id, business: req.businessId, status: 'pending' },
    { $set: { status, respondedBy: req.user._id, respondedByName: req.user.name, respondedAt: new Date(), ...extra } },
    { new: true }
  );
  if (!claimed) {
    const now = await Transfer.findOne({ _id: base._id, business: req.businessId });
    throw httpError(409, `This transfer was already ${now ? STATUS_WORDS[now.status] || now.status : 'answered'}.`);
  }
  return claimed;
}

async function releaseClaim(req, transfer) {
  await Transfer.updateOne(
    { _id: transfer._id, business: req.businessId },
    { $set: { status: 'pending' }, $unset: { respondedBy: '', respondedByName: '', respondedAt: '', reason: '' } }
  ).catch(() => {});
}

// POST /api/transfers/:id/accept : the stock joins the receiving store
async function acceptTransfer(req, res, next) {
  let transfer = null;
  const done = [];
  try {
    transfer = await claim(req, 'accepted', {});
    const toKey = await shopKeyOf(req.businessId, transfer.toShop);

    for (const line of transfer.lines) {
      const ok = await receiveFromTransit({
        businessId: req.businessId,
        productId: line.product,
        variantId: line.variant || null,
        qty: line.quantity,
        toShopId: toKey,
        transitId: transfer._id,
      });
      if (!ok) throw httpError(500, 'The stock of this transfer could not be found. Nothing was changed.');
      done.push(line);
    }
    for (const line of transfer.lines) {
      if (!line.serials || line.serials.length === 0) continue;
      await moveSerials({
        businessId: req.businessId,
        productId: line.product,
        serials: line.serials,
        from: transfer._id,
        to: toKey,
        note: `From ${transfer.fromName}`,
        transitRef: transfer._id,
      });
    }

    logActivity(req, {
      action: 'transfer.accept',
      summary: `Accepted ${tag(transfer.number)} from ${transfer.fromName} into ${transfer.toName}`,
      entityType: 'Transfer',
      entityId: transfer._id,
    });
    res.json({ transfer: out(transfer) });
  } catch (err) {
    if (transfer) {
      // put the lines already received back on their way, then reopen the transfer
      const toKey = await shopKeyOf(req.businessId, transfer.toShop).catch(() => null);
      for (const line of done) {
        await moveBackToTransit(req.businessId, transfer, line, toKey).catch(() => {});
      }
      await releaseClaim(req, transfer);
    }
    next(err);
  }
}

async function moveBackToTransit(businessId, transfer, line, toKey) {
  if (toKey) await decRowGuarded(businessId, line.product, line.variant || null, toKey, line.quantity);
  await incRow(businessId, line.product, line.variant || null, transfer._id, line.quantity);
}

// Sends the stock of a declined or cancelled transfer back to the sending store.
async function sendBack(req, transfer) {
  const fromKey = await shopKeyOf(req.businessId, transfer.fromShop);
  for (const line of transfer.lines) {
    const ok = await returnFromTransit({
      businessId: req.businessId,
      productId: line.product,
      variantId: line.variant || null,
      qty: line.quantity,
      fromShopId: fromKey,
      transitId: transfer._id,
    });
    if (!ok) throw httpError(500, 'The stock of this transfer could not be found. Nothing was changed.');
  }
  for (const line of transfer.lines) {
    if (!line.serials || line.serials.length === 0) continue;
    await moveSerials({
      businessId: req.businessId,
      productId: line.product,
      serials: line.serials,
      from: transfer._id,
      to: fromKey,
      note: 'Transfer returned',
      transitRef: transfer._id,
    });
  }
}

async function closeTransfer(req, res, next, { status, action, wording }) {
  let transfer = null;
  try {
    const reason = clean((req.body || {}).reason).slice(0, 300);
    if (status === 'declined' && !reason) throw httpError(400, 'Say why you are declining this transfer');

    if (status === 'cancelled') {
      const existing = await loadTransfer(req);
      const mine = String(existing.createdBy || '') === String(req.user._id);
      if (!mine && req.user.role !== 'owner') throw httpError(403, 'Only the person who sent this transfer, or the administrator, can cancel it.');
    }

    transfer = await claim(req, status, reason ? { reason } : {});
    try {
      await sendBack(req, transfer);
    } catch (err) {
      await releaseClaim(req, transfer);
      transfer = null;
      throw err;
    }
    logActivity(req, {
      action,
      summary: `${wording} ${tag(transfer.number)} (${transfer.fromName} to ${transfer.toName})${reason ? `: ${reason}` : ''}`,
      entityType: 'Transfer',
      entityId: transfer._id,
    });
    res.json({ transfer: out(transfer) });
  } catch (err) {
    next(err);
  }
}

// POST /api/transfers/:id/decline  { reason }
function declineTransfer(req, res, next) {
  return closeTransfer(req, res, next, { status: 'declined', action: 'transfer.decline', wording: 'Declined' });
}

// POST /api/transfers/:id/cancel  { reason? }  : the sender takes it back
function cancelTransfer(req, res, next) {
  return closeTransfer(req, res, next, { status: 'cancelled', action: 'transfer.cancel', wording: 'Cancelled' });
}

module.exports = { listTransfers, getTransfer, createTransfer, acceptTransfer, declineTransfer, cancelTransfer };
