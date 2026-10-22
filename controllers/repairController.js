const Repair = require('../models/Repair');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const { httpError } = require('../utils/httpError');
const { variantLabel } = require('../utils/variants');
const { round2 } = require('../utils/money');
const { can, canSeeCosts } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');
const { notifyOwners } = require('../utils/notifications');
const { createNumbered } = require('../utils/sequence');
const { resolveShop, takeStock: takeStockFrom, putStock, quantityInShop, applyShopFilter } = require('../utils/shopStock');
const {
  clean,
  cleanLong,
  money,
  parseDay,
  readMoney,
  readMethod,
  paymentEntry,
  readPaymentKey,
  isIdText,
  balanceOf,
  jobCode,
  numberFromSearch,
  escapeRegex,
} = require('../utils/jobHelpers');

const STATUSES = ['received', 'in_repair', 'ready', 'collected'];
const STATUS_LABELS = { received: 'Received', in_repair: 'In repair', ready: 'Ready for collection', collected: 'Collected' };
const OPEN_STATUSES = ['received', 'in_repair', 'ready'];
const LIST_LIMIT = 300;
const MAX_PARTS = 50;

const code = (repair) => jobCode('R', repair.number);

// The job as it is sent to the app: with its balance, and without what the parts cost for anyone but the administrator.
function view(req, repair) {
  const out = typeof repair.toObject === 'function' ? repair.toObject() : { ...repair };
  out.code = code(out);
  out.balance = balanceOf(out.quote, out.amountPaid);
  if (canSeeCosts(req.user)) {
    out.partsCost = round2((out.parts || []).reduce((sum, p) => sum + (Number(p.cost) || 0) * p.quantity, 0));
  } else {
    out.parts = (out.parts || []).map((p) => {
      const copy = { ...p };
      delete copy.cost;
      return copy;
    });
  }
  return out;
}

function readClientId(body) {
  if (body.clientId == null || body.clientId === '') return null;
  if (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) throw httpError(400, 'The job id is not valid');
  return body.clientId;
}

// The unit cost of a part that comes from stock (only ever shown to the administrator).
function unitCostOf(product, variant) {
  if (variant && variant.costPrice != null) return Number(variant.costPrice) || 0;
  return Number(product.costPrice) || 0;
}

// Takes spare parts out of the stock of one store (atomic: two jobs cannot take the last one).
async function takeStock(businessId, product, variant, qty, shop) {
  const what = variant ? `${product.name} (${variantLabel(variant)})` : product.name;
  await takeStockFrom({
    businessId,
    product,
    variant,
    qty,
    shop,
    requireActive: true,
    notEnough: `Not enough stock for ${what}. Someone may have just used the last ones.`,
  });
}

// Puts spare parts back on the shelf of the store they came out of (a part removed from a job).
async function putStockBack(businessId, part) {
  if (!part.product) return;
  await putStock({ businessId, productId: part.product, variantId: part.variant || null, qty: part.quantity, shopId: part.shop || null }).catch(() => {});
}

async function findCustomer(req, id) {
  if (!isIdText(id)) throw httpError(400, "The customer's phone number is required to take in a repair");
  const customer = await Customer.findOne({ _id: id, business: req.businessId });
  if (!customer) throw httpError(404, 'Customer not found');
  if (!clean(customer.phone)) throw httpError(400, 'This customer has no phone number. Add their phone number on the Customers page first.');
  return customer;
}

async function loadRepair(req) {
  const repair = await Repair.findOne({ _id: req.params.id, business: req.businessId });
  if (!repair) throw httpError(404, 'Repair job not found');
  return repair;
}

function assertOpen(repair) {
  if (repair.status === 'collected') throw httpError(400, 'This job has been collected, so it can no longer be changed.');
}

// GET /api/repairs?status=ready&search=ada
async function listRepairs(req, res, next) {
  try {
    const filter = { business: req.businessId };
    // ?shop=<store id> (or "main") shows only the jobs taken in that store; leave it out for every store
    await applyShopFilter(req, filter);
    const scope = { business: req.businessId };
    if (filter.shop !== undefined) scope.shop = filter.shop;
    if (req.query.status === 'open') {
      filter.status = { $in: OPEN_STATUSES }; // everything still in the shop
    } else if (req.query.status !== undefined && req.query.status !== '' && req.query.status !== 'all') {
      if (!STATUSES.includes(req.query.status)) throw httpError(400, 'Unknown status');
      filter.status = req.query.status;
    }

    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      const or = [{ customerName: rx }, { customerPhone: rx }, { device: rx }, { imei: rx }, { fault: rx }];
      const number = numberFromSearch(search, 'R');
      if (number !== null) or.push({ number });
      filter.$or = or;
    }

    const rows = await Repair.find(filter).sort({ receivedAt: -1, number: -1 }).limit(LIST_LIMIT + 1);
    const truncated = rows.length > LIST_LIMIT;

    // how many jobs are in each state, and what is still owed (for the whole business, not just this search)
    const seesMoney = can(req.user, 'viewInsights');
    const all = await Repair.find(scope)
      .select(seesMoney ? 'status quote amountPaid payments' : 'status quote amountPaid')
      .lean();
    const counts = { received: 0, in_repair: 0, ready: 0, collected: 0 };
    let owed = 0;
    let takenThisMonth = 0;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    for (const j of all) {
      if (j.status in counts) counts[j.status] += 1;
      if (OPEN_STATUSES.includes(j.status)) owed += Math.max((j.quote || 0) - (j.amountPaid || 0), 0);
      if (seesMoney) {
        for (const p of j.payments || []) {
          if (p.at && new Date(p.at) >= monthStart) takenThisMonth += p.amount || 0;
        }
      }
    }

    const out = { repairs: rows.slice(0, LIST_LIMIT).map((r) => view(req, r)), counts, truncated };

    // money figures: only for people who may see insights
    if (seesMoney) out.summary = { owed: round2(owed), receivedThisMonth: round2(takenThisMonth) };

    res.json(out);
  } catch (err) {
    next(err);
  }
}

// GET /api/repairs/:id
async function getRepair(req, res, next) {
  try {
    res.json({ repair: view(req, await loadRepair(req)) });
  } catch (err) {
    next(err);
  }
}

// POST /api/repairs
// body: { customer, device, imei?, accessories?, fault, quote?, deposit?, depositMethod?, technician?, promisedDate?, notes?, clientId? }
async function createRepair(req, res, next) {
  let clientId = null;
  try {
    const body = req.body || {};

    // the same job sent twice (a double tap, a lost answer) is saved once
    clientId = readClientId(body);
    if (clientId) {
      const existing = await Repair.findOne({ business: req.businessId, clientId });
      if (existing) {
        if (String(existing.recordedBy) !== String(req.user._id)) throw httpError(409, 'This job id was already used.');
        return res.status(200).json({ duplicate: true, repair: view(req, existing) });
      }
    }

    const customer = await findCustomer(req, body.customer);

    const device = clean(body.device, 100);
    if (!device) throw httpError(400, 'Enter the device (for example: Samsung A14)');
    const fault = clean(body.fault, 500);
    if (!fault) throw httpError(400, 'Describe the fault');

    const quote = readMoney(body.quote, 'The quote', { fallback: 0 });
    const deposit = readMoney(body.deposit, 'The deposit', { fallback: 0 });
    if (quote > 0 && deposit > quote) throw httpError(400, 'The deposit is more than the quote');
    const method = readMethod(body.depositMethod);
    const promisedDate = parseDay(body.promisedDate, 'The promised date');

    const now = new Date();
    const takenIn = await resolveShop(req);
    const repair = await createNumbered(Repair, req.businessId, 'number', () => ({
      shop: takenIn.id || undefined,
      customer: customer._id,
      customerName: customer.name,
      customerPhone: customer.phone,
      device,
      imei: clean(body.imei, 40) || undefined,
      accessories: clean(body.accessories, 200) || undefined,
      fault,
      quote,
      payments: deposit > 0 ? [paymentEntry(req, { amount: deposit, method, kind: 'deposit' })] : [],
      amountPaid: deposit,
      status: 'received',
      history: [{ status: 'received', at: now, byName: req.user.name }],
      technician: clean(body.technician, 80) || undefined,
      notes: cleanLong(body.notes, 1000) || undefined,
      receivedAt: now,
      promisedDate: promisedDate || undefined,
      clientId: clientId || undefined,
      recordedBy: req.user._id,
      recordedByName: req.user.name,
    }));

    logActivity(req, {
      action: 'repair.create',
      summary: `Took in ${device} from ${customer.name} for repair (${code(repair)})${quote > 0 ? `, quote ${money(quote)}` : ''}${deposit > 0 ? `, deposit ${money(deposit)}` : ''}.`,
      entityType: 'Repair',
      entityId: repair._id,
      meta: { number: repair.number, quote, deposit },
    });

    res.status(201).json({ repair: view(req, repair) });
  } catch (err) {
    // two copies of the same job arrived together and the other one was saved first
    if (clientId && err && err.code === 11000 && err.keyPattern && err.keyPattern.clientId) {
      try {
        const existing = await Repair.findOne({ business: req.businessId, clientId });
        if (existing) return res.status(200).json({ duplicate: true, repair: view(req, existing) });
      } catch (lookupErr) {
        // fall through to the original error
      }
    }
    next(err);
  }
}

// PATCH /api/repairs/:id   body: any of { device, imei, accessories, fault, quote, technician, promisedDate, notes }
async function updateRepair(req, res, next) {
  try {
    const repair = await loadRepair(req);
    assertOpen(repair);
    const body = req.body || {};

    const set = {};
    const unset = {};
    const changes = [];
    const text = (field, max, label, required) => {
      if (body[field] === undefined) return;
      const value = clean(body[field], max);
      if (required && !value) throw httpError(400, `${label} cannot be empty`);
      if (value) set[field] = value;
      else unset[field] = '';
      changes.push(label.toLowerCase());
    };
    text('device', 100, 'The device', true);
    text('fault', 500, 'The fault', true);
    text('imei', 40, 'IMEI');
    text('accessories', 200, 'Accessories');
    text('technician', 80, 'Technician');
    if (body.notes !== undefined) {
      const notes = cleanLong(body.notes, 1000);
      if (notes) set.notes = notes;
      else unset.notes = '';
      changes.push('notes');
    }
    if (body.promisedDate !== undefined) {
      const day = parseDay(body.promisedDate, 'The promised date');
      if (day) set.promisedDate = day;
      else unset.promisedDate = '';
      changes.push('promised date');
    }

    const filter = { _id: repair._id, business: req.businessId, status: { $ne: 'collected' } };
    let newQuote = null;
    if (body.quote !== undefined) {
      newQuote = readMoney(body.quote, 'The quote', { fallback: 0 });
      // the price cannot go below what the customer has already paid
      if (newQuote < repair.amountPaid) throw httpError(400, `The customer has already paid ${money(repair.amountPaid)}, so the quote cannot be lower than that.`);
      filter.amountPaid = { $lte: newQuote };
      set.quote = newQuote;
      changes.push(`quote (${money(newQuote)})`);
    }

    if (changes.length === 0) return res.json({ repair: view(req, repair) });

    const update = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const updated = await Repair.findOneAndUpdate(filter, update, { new: true });
    if (!updated) throw httpError(409, 'This job was just changed by someone else. Reload it and try again.');

    logActivity(req, {
      action: 'repair.update',
      summary: `Changed repair ${code(updated)}: ${changes.join(', ')}.`,
      entityType: 'Repair',
      entityId: updated._id,
    });
    res.json({ repair: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// POST /api/repairs/:id/status   body: { status, note? }
async function changeStatus(req, res, next) {
  try {
    const next_ = req.body && req.body.status;
    if (!STATUSES.includes(next_)) throw httpError(400, 'Choose a status');

    const repair = await loadRepair(req);
    assertOpen(repair);
    if (repair.status === next_) throw httpError(400, `This job is already "${STATUS_LABELS[next_]}".`);

    if (next_ === 'collected') {
      const balance = balanceOf(repair.quote, repair.amountPaid);
      if (balance > 0) throw httpError(400, `The customer still owes ${money(balance)}. Record the payment first, then hand over the device.`);
      if (balance < 0) throw httpError(400, 'Set the price of the job (the quote) before handing over the device.');
      // no price and no money: only if the person confirms the job is free of charge (a mistake must not hand a device over for nothing)
      if (repair.quote <= 0 && repair.amountPaid <= 0 && (!req.body || req.body.free !== true)) {
        throw httpError(400, 'No price has been set for this job. Set the price first, or confirm that the job is free of charge.');
      }
    }

    const now = new Date();
    const set = { status: next_ };
    const unset = {};
    if (next_ === 'ready') set.readyAt = now;
    else if (next_ === 'collected') set.collectedAt = now;
    else unset.readyAt = '';

    const update = {
      $set: set,
      $push: { history: { status: next_, at: now, byName: req.user.name, note: clean(req.body.note, 200) || undefined } },
    };
    if (Object.keys(unset).length > 0) update.$unset = unset;

    // only if nobody changed the job in the meantime
    const updated = await Repair.findOneAndUpdate(
      { _id: repair._id, business: req.businessId, status: repair.status, amountPaid: repair.amountPaid, quote: repair.quote },
      update,
      { new: true }
    );
    if (!updated) throw httpError(409, 'This job was just changed by someone else. Reload it and try again.');

    logActivity(req, {
      action: 'repair.status',
      summary: `Repair ${code(updated)} (${updated.device}, ${updated.customerName}) is now "${STATUS_LABELS[next_]}".`,
      entityType: 'Repair',
      entityId: updated._id,
      meta: { status: next_ },
    });
    if (next_ === 'ready') {
      notifyOwners(
        req.businessId,
        { type: 'jobReady', title: `Repair ${code(updated)} is ready`, body: `${updated.customerName}'s ${updated.device} is ready for pick-up.`, link: `/dashboard/repairs/${updated._id}` },
        { exceptUserId: req.user._id }
      );
    }
    res.json({ repair: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// POST /api/repairs/:id/payments   body: { amount, method?, note? }
async function addPayment(req, res, next) {
  try {
    const body = req.body || {};
    const amount = readMoney(body.amount, 'The amount', { min: 0.01 });
    const method = readMethod(body.method);

    const paymentKey = readPaymentKey(body);

    const repair = await loadRepair(req);
    // the same payment sent again (a double tap, a lost answer) is not taken twice
    if (paymentKey && (repair.payments || []).some((p) => p.key === paymentKey)) {
      return res.status(200).json({ duplicate: true, repair: view(req, repair) });
    }
    assertOpen(repair);
    const balance = balanceOf(repair.quote, repair.amountPaid);
    // with a price set, the customer cannot pay more than is left
    if (repair.quote > 0 && amount > balance) throw httpError(400, balance > 0 ? `That is more than the balance of ${money(balance)}.` : 'This job is already paid in full.');

    const updated = await Repair.findOneAndUpdate(
      { _id: repair._id, business: req.businessId, status: { $ne: 'collected' }, amountPaid: repair.amountPaid, quote: repair.quote },
      {
        $push: { payments: paymentEntry(req, { amount, method, note: body.note, kind: 'payment', key: paymentKey }) },
        $inc: { amountPaid: amount },
      },
      { new: true }
    );
    if (!updated) throw httpError(409, 'Another payment was just recorded on this job. Check the balance and try again.');

    // keep the stored total exactly the sum of the payments (no 0.0000001 left over)
    // (only if nothing else was added in the meantime: a newer payment tidies up after itself)
    const exact = round2(updated.payments.reduce((sum, p) => sum + p.amount, 0));
    if (exact !== updated.amountPaid) {
      const tidy = await Repair.findOneAndUpdate({ _id: updated._id, business: req.businessId, amountPaid: updated.amountPaid }, { $set: { amountPaid: exact } }, { new: true });
      if (tidy) updated.amountPaid = tidy.amountPaid;
    }

    logActivity(req, {
      action: 'repair.payment',
      summary: `Took ${money(amount)} on repair ${code(updated)} from ${updated.customerName}${balanceOf(updated.quote, updated.amountPaid) > 0 ? `, ${money(balanceOf(updated.quote, updated.amountPaid))} still to pay` : ''}.`,
      entityType: 'Repair',
      entityId: updated._id,
      meta: { amount, method },
    });
    res.status(201).json({ repair: view(req, updated) });
  } catch (err) {
    next(err);
  }
}

// POST /api/repairs/:id/parts   body: { product?, variant?, name?, quantity, cost? }
// A part from stock reduces the stock; a part typed in by name (bought outside, for example) does not.
async function addPart(req, res, next) {
  let taken = null; // stock already taken, put back if the part cannot be saved
  try {
    const body = req.body || {};
    const qty = Number(body.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw httpError(400, 'The quantity must be a whole number of 1 or more');

    const repair = await loadRepair(req);
    assertOpen(repair);
    if (repair.parts.length >= MAX_PARTS) throw httpError(400, `A job can have at most ${MAX_PARTS} parts.`);

    let part;
    if (body.product) {
      if (!isIdText(body.product) || (body.variant && !isIdText(body.variant))) throw httpError(400, 'The part could not be read');
      const product = await Product.findOne({ _id: body.product, business: req.businessId, isActive: true });
      if (!product) throw httpError(404, 'Part not found in stock');
      if (product.tracksSerials) throw httpError(400, `${product.name} is tracked by IMEI / serial number, so it cannot be used as a spare part here.`);

      let variant = null;
      if (product.variants.length > 0) {
        if (!body.variant) throw httpError(400, `Choose which colour / size of ${product.name} was used`);
        variant = product.variants.id(body.variant);
        if (!variant) throw httpError(404, 'Colour / size not found');
      } else if (body.variant) {
        throw httpError(400, `${product.name} has no colours / sizes`);
      }

      // the part comes out of the store the person is working in
      const shop = await resolveShop(req, body.shop, { strict: true });
      const available = await quantityInShop(req.businessId, product, variant, shop);
      if (available < qty) throw httpError(400, `Not enough stock for ${product.name}${variant ? ` (${variantLabel(variant)})` : ''}. Only ${available} left.`);

      await takeStock(req.businessId, product, variant, qty, shop);
      taken = { product: product._id, variant: variant ? variant._id : undefined, quantity: qty, shop: shop.id || undefined };
      part = {
        shop: shop.id || undefined,
        name: variant ? `${product.name} (${variantLabel(variant)})` : product.name,
        quantity: qty,
        cost: unitCostOf(product, variant),
        product: product._id,
        variant: variant ? variant._id : undefined,
      };
    } else {
      const name = clean(body.name, 120);
      if (!name) throw httpError(400, 'Enter the name of the part, or choose one from stock');
      part = {
        name,
        quantity: qty,
        // what a part cost is for the administrator to say
        cost: canSeeCosts(req.user) ? readMoney(body.cost, 'The cost', { fallback: 0 }) : 0,
      };
    }
    part.addedAt = new Date();
    part.addedByName = req.user.name;

    const updated = await Repair.findOneAndUpdate(
      { _id: repair._id, business: req.businessId, status: { $ne: 'collected' }, [`parts.${MAX_PARTS - 1}`]: { $exists: false } },
      { $push: { parts: part } },
      { new: true }
    );
    if (!updated) throw httpError(409, 'This job was just changed (or collected). Reload it and try again.');
    taken = null;

    logActivity(req, {
      action: 'repair.part',
      summary: `Used ${qty} × ${part.name} on repair ${code(updated)}${part.product ? ' (taken from stock)' : ''}.`,
      entityType: 'Repair',
      entityId: updated._id,
      meta: { part: part.name, quantity: qty },
    });
    res.status(201).json({ repair: view(req, updated) });
  } catch (err) {
    if (taken) await putStockBack(req.businessId, taken);
    next(err);
  }
}

// DELETE /api/repairs/:id/parts/:partId   (a part added by mistake: stock taken for it goes back)
async function removePart(req, res, next) {
  try {
    const repair = await loadRepair(req);
    assertOpen(repair);
    const part = repair.parts.id(req.params.partId);
    if (!part) throw httpError(404, 'Part not found on this job');

    const before = await Repair.findOneAndUpdate(
      { _id: repair._id, business: req.businessId, status: { $ne: 'collected' }, 'parts._id': part._id },
      { $pull: { parts: { _id: part._id } } }
    );
    if (!before) throw httpError(409, 'This job was just changed (or collected). Reload it and try again.');
    await putStockBack(req.businessId, part);

    logActivity(req, {
      action: 'repair.part',
      summary: `Removed ${part.quantity} × ${part.name} from repair ${code(repair)}${part.product ? ' (put back in stock)' : ''}.`,
      entityType: 'Repair',
      entityId: repair._id,
    });
    res.json({ repair: view(req, await loadRepair(req)) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/repairs/:id   (administrator only)
// For a job entered by mistake: only while no money has been taken on it and it has not been collected.
async function deleteRepair(req, res, next) {
  try {
    const removed = await Repair.findOneAndDelete({
      _id: req.params.id,
      business: req.businessId,
      status: { $ne: 'collected' },
      'payments.0': { $exists: false },
    });
    if (!removed) {
      const repair = await Repair.findOne({ _id: req.params.id, business: req.businessId });
      if (!repair) throw httpError(404, 'Repair job not found');
      throw httpError(400, repair.status === 'collected' ? 'A collected job cannot be deleted.' : 'Money has been taken on this job, so it cannot be deleted.');
    }
    for (const part of removed.parts) await putStockBack(req.businessId, part);

    logActivity(req, {
      action: 'repair.delete',
      summary: `Deleted repair ${code(removed)} (${removed.device}, ${removed.customerName}).`,
      entityType: 'Repair',
      entityId: removed._id,
    });
    res.json({ message: 'Repair job deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listRepairs, getRepair, createRepair, updateRepair, changeStatus, addPayment, addPart, removePart, deleteRepair, STATUSES };
