const LaundryOrder = require('../models/LaundryOrder');
const LaundryItem = require('../models/LaundryItem');
const Customer = require('../models/Customer');
const Business = require('../models/Business');
const { httpError } = require('../utils/httpError');
const { round2 } = require('../utils/money');
const { can } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');
const { loadPreferences } = require('../utils/settings');
const { notifyOwners } = require('../utils/notifications');
const { createNumbered } = require('../utils/sequence');
const { applyWorkingShop, shopForNewRecord } = require('../utils/shopStock');
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

const STATUSES = ['received', 'processing', 'ready', 'out_for_delivery', 'collected'];
const STATUS_LABELS = {
  received: 'Received',
  processing: 'Being washed',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  collected: 'Collected / delivered',
};
const OPEN_STATUSES = ['received', 'processing', 'ready', 'out_for_delivery'];
const HANDOVERS = ['pickup', 'delivery'];
const TIME_ZONE = 'Africa/Lagos'; // the day an order or a payment belongs to (the same zone the other reports use)

// What can be done to a piece of clothing. "Wash" uses the item's normal price; the others use the item's own price for that service.
const SERVICES = [
  { key: 'wash', label: 'Wash' },
  { key: 'wash_iron', label: 'Wash & iron' },
  { key: 'iron', label: 'Iron only' },
  { key: 'dry_clean', label: 'Dry clean' },
];
const SERVICE_KEYS = SERVICES.map((s) => s.key);
const DEFAULT_EXPRESS_PERCENT = 50;
const MAX_EXPRESS_PERCENT = 300;
const LIST_LIMIT = 300;
const MAX_LINES = 60;

// The standard list of clothing types (the rows of the paper log book). Prices are left for the owner to set.
const DEFAULT_ITEMS = [
  'Native',
  'Jean',
  'Short Jean',
  'Short',
  'Round neck',
  'Sweat shirt',
  'Polo',
  'Shirt',
  'Short shirt',
  'Cardigan',
  'Agbada',
  'Suit',
  'Gown',
  'Jalabia',
  'Socks',
  'Cap',
  'Head warmer',
  'Face towel',
  'Handkerchief',
  'Duvet',
  'Bedspread',
  'Complete duvet',
];

const code = (order) => jobCode('L', order.number);
const keyOf = (name) => clean(name, 60).toLowerCase();

function view(order) {
  const out = typeof order.toObject === 'function' ? order.toObject() : { ...order };
  out.code = code(out);
  out.balance = balanceOf(out.totalAmount, out.amountPaid);
  return out;
}

function readClientId(body) {
  if (body.clientId == null || body.clientId === '') return null;
  if (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) throw httpError(400, 'The order id is not valid');
  return body.clientId;
}

async function findCustomer(req, id) {
  if (!isIdText(id)) throw httpError(400, "The customer's phone number is required to record an order");
  const customer = await Customer.findOne({ _id: id, business: req.businessId });
  if (!customer) throw httpError(404, 'Customer not found');
  if (!clean(customer.phone)) throw httpError(400, 'This customer has no phone number. Add their phone number on the Customers page first.');
  return customer;
}

async function loadOrder(req) {
  const order = await LaundryOrder.findOne({ _id: req.params.id, business: req.businessId });
  if (!order) throw httpError(404, 'Laundry order not found');
  return order;
}

function assertOpen(order) {
  if (order.status === 'collected') throw httpError(400, 'This order has been collected / delivered, so it can no longer be changed.');
}

// The price of one piece for a service (0 = the owner has not set it yet)
function priceFor(item, service) {
  if (!item) return 0;
  if (service === 'wash') return item.price || 0;
  return (item.prices && item.prices[service]) || 0;
}

// Express and discount, as sent by the app. `current` is the order being changed (nothing is lost when the app sends only part of it).
function readPricingOptions(body, current, defaultPercent = DEFAULT_EXPRESS_PERCENT) {
  const cur = current || {};
  let express = cur.express === true;
  let expressPercent = Number(cur.expressPercent) || 0;
  if (body.express !== undefined) express = body.express === true || body.express === 'true';
  if (body.expressPercent !== undefined && body.expressPercent !== null && body.expressPercent !== '') {
    const n = Number(body.expressPercent);
    if (!Number.isFinite(n) || n < 0 || n > MAX_EXPRESS_PERCENT) throw httpError(400, `The express charge must be between 0 and ${MAX_EXPRESS_PERCENT} percent`);
    expressPercent = round2(n);
  }
  if (express && !expressPercent) expressPercent = defaultPercent;
  if (!express) expressPercent = 0;

  let discountType = cur.discountType || undefined;
  let discountValue = Number(cur.discountValue) || 0;
  if (body.discountType !== undefined || body.discountValue !== undefined) {
    const type = body.discountType !== undefined ? body.discountType : discountType;
    const raw = body.discountValue !== undefined ? body.discountValue : discountValue;
    if (!type || raw === '' || raw === null || Number(raw) === 0) {
      discountType = undefined;
      discountValue = 0;
    } else {
      if (type !== 'amount' && type !== 'percent') throw httpError(400, 'Choose a discount in money or in percent');
      discountValue = readMoney(raw, 'The discount', { min: 0 });
      if (type === 'percent' && discountValue > 100) throw httpError(400, 'A discount cannot be more than 100 percent');
      discountType = discountValue > 0 ? type : undefined;
    }
  }
  return { express, expressPercent, discountType, discountValue };
}

// What the register adds up to: pieces, subtotal, express charge, discount, delivery fee and the total.
function totalsOf(lines, deliveryFee, options = {}) {
  const totalItems = lines.reduce((sum, l) => sum + l.quantity, 0);
  const subtotal = round2(lines.reduce((sum, l) => sum + l.quantity * l.price, 0));
  const express = options.express === true;
  const expressPercent = express ? Number(options.expressPercent) || 0 : 0;
  const expressFee = express ? round2((subtotal * expressPercent) / 100) : 0;
  const base = round2(subtotal + expressFee);
  const discountType = options.discountType || undefined;
  const discountValue = discountType ? Number(options.discountValue) || 0 : 0;
  let discount = 0;
  if (discountType === 'percent') discount = round2((base * discountValue) / 100);
  else if (discountType === 'amount') discount = discountValue;
  if (discount > base) throw httpError(400, `The discount (${money(discount)}) is more than the order (${money(base)})`);
  return {
    totalItems,
    subtotal,
    express,
    expressPercent,
    expressFee,
    discountType,
    discountValue,
    discount,
    deliveryFee,
    totalAmount: round2(base - discount + deliveryFee),
  };
}

// Writes totals into an update: values that are empty are removed rather than saved as "undefined".
function putTotals(set, unset, totals) {
  for (const [key, value] of Object.entries(totals)) {
    if (value === undefined) unset[key] = '';
    else set[key] = value;
  }
}

// Reads the rows of the register. Each row: { item?, itemName?, quantity, colour?, stain?, price?, dateIn?, dateOut?, remarks? }.
// A row that names an item from the list takes its name (and its usual price when none is typed).
async function readLines(req, rawLines, defaults) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw httpError(400, 'Add at least one item');
  if (rawLines.length > MAX_LINES) throw httpError(400, `An order can have at most ${MAX_LINES} rows.`);

  const ids = rawLines.map((l) => l && l.item).filter((id) => id !== undefined && id !== null && id !== '');
  if (!ids.every(isIdText)) throw httpError(400, 'An item in the list could not be read');
  const items = ids.length > 0 ? await LaundryItem.find({ _id: { $in: ids }, business: req.businessId }) : [];
  const byId = new Map(items.map((i) => [String(i._id), i]));

  return rawLines.map((raw, index) => {
    const row = raw || {};
    const where = `Row ${index + 1}`;
    let item = null;
    if (row.item) {
      item = byId.get(String(row.item));
      if (!item) throw httpError(404, `${where}: that item is not in your list`);
    }
    // a name sent with the row is kept (so an old order keeps the name it was written with, even if the item was renamed later)
    const itemName = clean(row.itemName, 60) || (item ? item.name : '');
    if (!itemName) throw httpError(400, `${where}: choose the type of clothing`);

    const quantity = Number(row.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw httpError(400, `${where}: the quantity must be a whole number of 1 or more`);

    const service = row.service === undefined || row.service === null || row.service === '' ? 'wash' : row.service;
    if (!SERVICE_KEYS.includes(service)) throw httpError(400, `${where}: choose wash, wash & iron, iron only or dry clean`);
    const price = readMoney(row.price, `${where}: the price`, { fallback: priceFor(item, service) });
    const dateIn = parseDay(row.dateIn, `${where}: the date in`) || defaults.dateIn;
    const dateOut = parseDay(row.dateOut, `${where}: the date out`) || defaults.dateOut || undefined;

    return {
      item: item ? item._id : undefined,
      itemName,
      quantity,
      service,
      colour: clean(row.colour, 80) || undefined,
      stain: clean(row.stain, 120) || undefined,
      price,
      dateIn,
      dateOut,
      remarks: clean(row.remarks, 120) || undefined,
    };
  });
}

function readHandover(value) {
  const handover = value === undefined || value === null || value === '' ? 'pickup' : value;
  if (!HANDOVERS.includes(handover)) throw httpError(400, 'Choose pick up or delivery');
  return handover;
}

// Pick-up or delivery, as sent by the app, worked out against the order (nothing sent = nothing changed).
// Returns what to save, the delivery fee and the handover the order will have.
function planDelivery(body, order) {
  const keys = ['handover', 'deliveryAddress', 'deliveryFee', 'riderName', 'riderPhone'];
  const touches = keys.some((k) => body[k] !== undefined);
  const set = {};
  const unset = {};
  let handover = order.handover || 'pickup';
  let deliveryFee = order.deliveryFee || 0;
  if (!touches) return { touches, set, unset, handover, deliveryFee };

  handover = body.handover !== undefined ? readHandover(body.handover) : handover;
  // an order that is for pick up and stays so has no delivery details to change
  if (handover === 'pickup' && (order.handover || 'pickup') === 'pickup') return { touches: false, set, unset, handover, deliveryFee: 0 };
  if (handover === 'delivery') {
    const address = body.deliveryAddress !== undefined ? clean(body.deliveryAddress, 200) : order.deliveryAddress || '';
    if (!address) throw httpError(400, 'Enter the address to deliver to');
    deliveryFee = body.deliveryFee !== undefined ? readMoney(body.deliveryFee, 'The delivery fee', { fallback: 0 }) : deliveryFee;
    set.deliveryAddress = address;
    const rider = body.riderName !== undefined ? clean(body.riderName, 60) : order.riderName || '';
    const riderPhone = body.riderPhone !== undefined ? clean(body.riderPhone, 30) : order.riderPhone || '';
    if (rider) set.riderName = rider;
    else unset.riderName = '';
    if (riderPhone) set.riderPhone = riderPhone;
    else unset.riderPhone = '';
  } else {
    if (order.status === 'out_for_delivery') throw httpError(400, 'This order is already out for delivery. Move it back to Ready before changing it to pick up.');
    deliveryFee = 0;
    unset.deliveryAddress = '';
    unset.riderName = '';
    unset.riderPhone = '';
  }
  set.handover = handover;
  set.deliveryFee = deliveryFee;
  return { touches, set, unset, handover, deliveryFee };
}

/* ------------------------------------------------------------------ */
/* The list of clothing items and prices                              */
/* ------------------------------------------------------------------ */

// The first time a laundromat opens its list it gets the standard clothing types. Only one request can do this (the flag is
// claimed atomically), and it happens once: deleting every item later does not bring them back.
async function seedItemsIfNeeded(businessId) {
  const claimed = await Business.findOneAndUpdate({ _id: businessId, laundryItemsSeeded: { $ne: true } }, { $set: { laundryItemsSeeded: true } });
  if (!claimed) return;
  const docs = DEFAULT_ITEMS.map((name, index) => ({ business: businessId, name, key: keyOf(name), price: 0, sortOrder: index + 1 }));
  try {
    await LaundryItem.insertMany(docs, { ordered: false });
  } catch (err) {
    // items that are already there are fine; anything else is a real problem
    if (!(err && (err.code === 11000 || (err.writeErrors && err.writeErrors.every((e) => e.code === 11000))))) {
      await Business.updateOne({ _id: businessId }, { $set: { laundryItemsSeeded: false } }).catch(() => {});
      throw err;
    }
  }
}

// The prices for the other services, { wash_iron?, iron?, dry_clean? }. A service that is left out keeps its current price.
function readServicePrices(raw, current) {
  const out = {};
  for (const key of SERVICE_KEYS) {
    if (key === 'wash') continue;
    const given = raw && typeof raw === 'object' ? raw[key] : undefined;
    out[key] = given === undefined ? Number(current[key]) || 0 : readMoney(given, `The ${key.replace('_', ' ')} price`, { fallback: 0 });
  }
  return out;
}

// GET /api/laundry/items
async function listItems(req, res, next) {
  try {
    await seedItemsIfNeeded(req.businessId);
    const items = await LaundryItem.find({ business: req.businessId }).sort({ sortOrder: 1, name: 1 });
    res.json({ items, services: SERVICES });
  } catch (err) {
    next(err);
  }
}

// POST /api/laundry/items   body: { name, price? }   (administrator only)
async function createItem(req, res, next) {
  try {
    const body = req.body || {};
    const name = clean(body.name, 60);
    if (!name) throw httpError(400, 'Enter the name of the clothing item');
    const price = readMoney(body.price, 'The price', { fallback: 0 });
    const prices = readServicePrices(body.prices, {});

    await seedItemsIfNeeded(req.businessId);
    const last = await LaundryItem.findOne({ business: req.businessId }).sort({ sortOrder: -1 }).select('sortOrder').lean();
    try {
      const item = await LaundryItem.create({ business: req.businessId, name, key: keyOf(name), price, prices, sortOrder: (last ? last.sortOrder : 0) + 1 });
      res.status(201).json({ item });
    } catch (err) {
      if (err && err.code === 11000) throw httpError(409, `${name} is already in your list.`);
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// PUT /api/laundry/items/:id   body: { name?, price? }   (administrator only)
// Old orders keep the name and price they were made with.
async function updateItem(req, res, next) {
  try {
    const body = req.body || {};
    const item = await LaundryItem.findOne({ _id: req.params.id, business: req.businessId });
    if (!item) throw httpError(404, 'Item not found');

    if (body.name !== undefined) {
      const name = clean(body.name, 60);
      if (!name) throw httpError(400, 'The name cannot be empty');
      item.name = name;
      item.key = keyOf(name);
    }
    if (body.price !== undefined) item.price = readMoney(body.price, 'The price', { fallback: 0 });
    if (body.prices !== undefined) item.prices = readServicePrices(body.prices, item.prices ? item.prices.toObject?.() || item.prices : {});

    try {
      await item.save();
    } catch (err) {
      if (err && err.code === 11000) throw httpError(409, `${item.name} is already in your list.`);
      throw err;
    }
    res.json({ item });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/laundry/items/:id   (administrator only)
async function deleteItem(req, res, next) {
  try {
    const item = await LaundryItem.findOneAndDelete({ _id: req.params.id, business: req.businessId });
    if (!item) throw httpError(404, 'Item not found');
    res.json({ message: 'Item removed from your list' });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Orders                                                             */
/* ------------------------------------------------------------------ */

// GET /api/laundry?status=ready&search=ada
async function listOrders(req, res, next) {
  try {
    const filter = { business: req.businessId };
    // the orders of the store being worked in
    await applyWorkingShop(req, filter);
    if (req.query.status === 'open') {
      filter.status = { $in: OPEN_STATUSES }; // everything still in the shop
    } else if (req.query.status !== undefined && req.query.status !== '' && req.query.status !== 'all') {
      if (!STATUSES.includes(req.query.status)) throw httpError(400, 'Unknown status');
      filter.status = req.query.status;
    }

    if (req.query.handover !== undefined && req.query.handover !== '' && req.query.handover !== 'all') {
      if (!HANDOVERS.includes(req.query.handover)) throw httpError(400, 'Unknown handover');
      // (orders saved before delivery existed have no handover and are pick-ups)
      filter.handover = req.query.handover === 'pickup' ? { $ne: 'delivery' } : 'delivery';
    }

    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      const or = [{ customerName: rx }, { customerPhone: rx }, { deliveryAddress: rx }, { riderName: rx }, { 'lines.itemName': rx }, { 'lines.colour': rx }];
      const number = numberFromSearch(search, 'L');
      if (number !== null) or.push({ number });
      filter.$or = or;
    }

    const rows = await LaundryOrder.find(filter).sort({ dateIn: -1, number: -1 }).limit(LIST_LIMIT + 1);
    const truncated = rows.length > LIST_LIMIT;

    // how many orders are in each state, what is still owed and how many pieces are in the shop (whole business)
    const seesMoney = can(req.user, 'viewInsights');
    const all = await LaundryOrder.find({ business: req.businessId, ...(filter.shop !== undefined ? { shop: filter.shop } : {}) })
      .select(seesMoney ? 'status totalItems totalAmount amountPaid payments handover deliveryFee collectedAt' : 'status totalItems totalAmount amountPaid handover')
      .lean();
    const counts = { received: 0, processing: 0, ready: 0, out_for_delivery: 0, collected: 0 };
    // the delivery orders by where they are: still being washed, ready to go, out with a rider, delivered
    const deliveries = { washing: 0, ready: 0, out: 0, delivered: 0 };
    let feesThisMonth = 0;
    let owed = 0;
    let itemsInShop = 0;
    let takenThisMonth = 0;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    for (const o of all) {
      if (o.status in counts) counts[o.status] += 1;
      if (o.handover === 'delivery') {
        if (o.status === 'received' || o.status === 'processing') deliveries.washing += 1;
        else if (o.status === 'ready') deliveries.ready += 1;
        else if (o.status === 'out_for_delivery') deliveries.out += 1;
        else if (o.status === 'collected') {
          deliveries.delivered += 1;
          if (seesMoney && o.collectedAt && new Date(o.collectedAt) >= monthStart) feesThisMonth += o.deliveryFee || 0;
        }
      }
      if (OPEN_STATUSES.includes(o.status)) {
        owed += Math.max((o.totalAmount || 0) - (o.amountPaid || 0), 0);
        itemsInShop += o.totalItems || 0;
      }
      if (seesMoney) {
        for (const p of o.payments || []) {
          if (p.at && new Date(p.at) >= monthStart) takenThisMonth += p.amount || 0;
        }
      }
    }

    const out = { orders: rows.slice(0, LIST_LIMIT).map(view), counts, deliveries, itemsInShop, truncated };

    if (seesMoney) out.summary = { owed: round2(owed), receivedThisMonth: round2(takenThisMonth), deliveryFeesThisMonth: round2(feesThisMonth) };

    res.json(out);
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Overview                                                           */
/* ------------------------------------------------------------------ */

const OVERVIEW_DAYS = 30;
const WAITING_DAYS_PICKUP = 2; // a ready order nobody has collected for this many days needs a nudge
const WAITING_DAYS_DELIVERY = 1;

// "2026-10-21": the calendar day a moment belongs to in the business's time zone
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
// whole days between two day keys (b minus a)
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// GET /api/laundry/overview
// Today at a glance, the last 30 days, and the orders that need a person's attention. Money is sent only to those who see insights.
async function overview(req, res, next) {
  try {
    const seesMoney = can(req.user, 'viewInsights');
    const now = new Date();
    const today = dayKey(now);
    const since = new Date(now.getTime() - (OVERVIEW_DAYS + 5) * 86400000);

    // every order still in the shop, plus anything touched in the last month (new, changed or paid)
    const scope = { business: req.businessId };
    await applyWorkingShop(req, scope);
    const orders = await LaundryOrder.find({
      ...scope,
      $or: [{ status: { $in: OPEN_STATUSES } }, { updatedAt: { $gte: since } }, { dateIn: { $gte: since } }],
    })
      .select('number customerName customerPhone status handover lines totalItems totalAmount amountPaid payments dateIn deliveryDate readyAt outAt collectedAt express riderName')
      .lean();

    const keys = [];
    for (let i = OVERVIEW_DAYS - 1; i >= 0; i -= 1) keys.push(dayKey(new Date(now.getTime() - i * 86400000)));
    const daily = new Map(keys.map((k) => [k, { date: k, orders: 0, collected: 0 }]));
    const itemTotals = new Map();
    const byStatus = { received: 0, processing: 0, ready: 0, out_for_delivery: 0, collected: 0 };

    const tiles = {
      receivedToday: 0,
      dueToday: 0,
      overdue: 0,
      readyPickup: 0,
      readyDelivery: 0,
      outForDelivery: 0,
      inShop: 0,
      piecesInShop: 0,
      expressOpen: 0,
    };
    let owed = 0;
    let collectedToday = 0;
    const attention = [];

    for (const o of orders) {
      const open = OPEN_STATUSES.includes(o.status);
      const delivery = o.handover === 'delivery';
      const balance = round2(Math.max((o.totalAmount || 0) - (o.amountPaid || 0), 0));
      const inKey = o.dateIn ? dayKey(o.dateIn) : null;

      if (open) {
        byStatus[o.status] += 1;
        tiles.inShop += 1;
        tiles.piecesInShop += o.totalItems || 0;
        owed += balance;
        if (o.express) tiles.expressOpen += 1;
      } else if (o.collectedAt && new Date(o.collectedAt) >= new Date(now.getTime() - OVERVIEW_DAYS * 86400000)) {
        byStatus.collected += 1;
      }

      if (inKey === today) tiles.receivedToday += 1;
      if (inKey && daily.has(inKey)) {
        daily.get(inKey).orders += 1;
        for (const l of o.lines || []) {
          const name = String(l.itemName || '').trim();
          if (!name) continue;
          const k = name.toLowerCase();
          const row = itemTotals.get(k) || { name, pieces: 0 };
          row.pieces += l.quantity || 0;
          itemTotals.set(k, row);
        }
      }

      if (seesMoney) {
        for (const p of o.payments || []) {
          if (!p.at) continue;
          const k = dayKey(p.at);
          if (daily.has(k)) daily.get(k).collected = round2(daily.get(k).collected + (p.amount || 0));
          if (k === today) collectedToday += p.amount || 0;
        }
      }

      if (!open) continue;
      const promised = o.deliveryDate ? dayKey(o.deliveryDate) : null;
      const base = { id: String(o._id), code: jobCode('L', o.number), customerName: o.customerName, customerPhone: o.customerPhone, status: o.status, handover: delivery ? 'delivery' : 'pickup', balance: seesMoney ? balance : undefined };

      if (o.status === 'received' || o.status === 'processing') {
        if (promised === today) tiles.dueToday += 1;
        if (promised && promised < today) {
          tiles.overdue += 1;
          const days = daysBetween(promised, today);
          attention.push({ ...base, kind: 'overdue', days, reason: `Promised ${days} day${days === 1 ? '' : 's'} ago and still ${o.status === 'received' ? 'not started' : 'being washed'}` });
        }
      } else if (o.status === 'ready') {
        if (delivery) tiles.readyDelivery += 1;
        else tiles.readyPickup += 1;
        const waited = o.readyAt ? daysBetween(dayKey(o.readyAt), today) : 0;
        if (waited >= (delivery ? WAITING_DAYS_DELIVERY : WAITING_DAYS_PICKUP)) {
          attention.push({
            ...base,
            kind: 'waiting',
            days: waited,
            reason: delivery ? `Ready to deliver for ${waited} day${waited === 1 ? '' : 's'}, not sent out yet` : `Ready for ${waited} days and not collected`,
          });
        }
      } else if (o.status === 'out_for_delivery') {
        tiles.outForDelivery += 1;
        const out = o.outAt ? daysBetween(dayKey(o.outAt), today) : 0;
        if (out >= 1) attention.push({ ...base, kind: 'delivery', days: out, reason: `Out for delivery${o.riderName ? ` with ${o.riderName}` : ''} since ${out} day${out === 1 ? '' : 's'} ago` });
      }
    }

    attention.sort((a, b) => b.days - a.days);
    const busiestItems = [...itemTotals.values()].sort((a, b) => b.pieces - a.pieces || a.name.localeCompare(b.name)).slice(0, 8);

    const out = {
      today,
      tiles,
      byStatus,
      daily: keys.map((k) => daily.get(k)),
      busiestItems,
      attention: attention.slice(0, 15),
      attentionCount: attention.length,
      seesMoney,
    };
    if (seesMoney) {
      out.money = { collectedToday: round2(collectedToday), owed: round2(owed) };
    } else {
      for (const d of out.daily) delete d.collected;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
}

// GET /api/laundry/:id
async function getOrder(req, res, next) {
  try {
    const order = view(await loadOrder(req));
    // what the customer's record says, so the order page can offer their address for a delivery and show their notes
    const customer = await Customer.findOne({ _id: order.customer, business: req.businessId }).select('address notes').lean();
    if (customer) {
      order.customerAddress = customer.address || undefined;
      order.customerNotes = customer.notes || undefined;
    }
    res.json({ order });
  } catch (err) {
    next(err);
  }
}

// POST /api/laundry
// body: { customer, lines: [...], handover?, deliveryAddress?, deliveryFee?, riderName?, express?, expressPercent?, discountType?, discountValue?, dateIn?, deliveryDate?, notes?, deposit?, depositMethod?, clientId? }
async function createOrder(req, res, next) {
  let clientId = null;
  try {
    const body = req.body || {};

    clientId = readClientId(body);
    if (clientId) {
      const existing = await LaundryOrder.findOne({ business: req.businessId, clientId });
      if (existing) {
        if (String(existing.recordedBy) !== String(req.user._id)) throw httpError(409, 'This order id was already used.');
        return res.status(200).json({ duplicate: true, order: view(existing) });
      }
    }

    const customer = await findCustomer(req, body.customer);
    const now = new Date();
    const dateIn = parseDay(body.dateIn, 'The date in') || now;
    const deliveryDate = parseDay(body.deliveryDate, 'The delivery date');
    if (deliveryDate && deliveryDate.getTime() < dateIn.getTime() - 24 * 60 * 60 * 1000) {
      throw httpError(400, 'The delivery date cannot be before the date the clothes came in');
    }

    const lines = await readLines(req, body.lines, { dateIn, dateOut: deliveryDate });
    const handover = readHandover(body.handover);
    const deliveryAddress = clean(body.deliveryAddress, 200) || clean(customer.address, 200);
    if (handover === 'delivery' && !deliveryAddress) throw httpError(400, 'Enter the address to deliver to');
    const deliveryFee = handover === 'delivery' ? readMoney(body.deliveryFee, 'The delivery fee', { fallback: 0 }) : 0;
    const riderName = handover === 'delivery' ? clean(body.riderName, 60) : '';

    const totals = totalsOf(lines, deliveryFee, readPricingOptions(body, null, (await loadPreferences(req.businessId)).expressPercent));
    if (totals.subtotal <= 0) throw httpError(400, 'This order has no price yet. Set your prices under Items & prices (administrator), or type a price on each row.');
    const deposit = readMoney(body.deposit, 'The deposit', { fallback: 0 });
    if (deposit > totals.totalAmount) throw httpError(400, 'The deposit is more than the total of the order');
    const method = readMethod(body.depositMethod);

    const takenIn = await shopForNewRecord(req);
    const order = await createNumbered(LaundryOrder, req.businessId, 'number', () => ({
      shop: takenIn,
      customer: customer._id,
      customerName: customer.name,
      customerPhone: customer.phone,
      lines,
      ...totals,
      payments: deposit > 0 ? [paymentEntry(req, { amount: deposit, method, kind: 'deposit' })] : [],
      amountPaid: deposit,
      handover,
      deliveryAddress: handover === 'delivery' ? deliveryAddress : undefined,
      riderName: riderName || undefined,
      status: 'received',
      history: [{ status: 'received', at: now, byName: req.user.name }],
      notes: cleanLong(body.notes, 1000) || undefined,
      dateIn,
      deliveryDate: deliveryDate || undefined,
      clientId: clientId || undefined,
      recordedBy: req.user._id,
      recordedByName: req.user.name,
    }));

    logActivity(req, {
      action: 'laundry.create',
      summary: `Took in ${totals.totalItems} item${totals.totalItems === 1 ? '' : 's'} from ${customer.name} (${code(order)}), total ${money(totals.totalAmount)}${deposit > 0 ? `, deposit ${money(deposit)}` : ''}.`,
      entityType: 'LaundryOrder',
      entityId: order._id,
      meta: { number: order.number, items: totals.totalItems, total: totals.totalAmount, deposit },
    });

    res.status(201).json({ order: view(order) });
  } catch (err) {
    if (clientId && err && err.code === 11000 && err.keyPattern && err.keyPattern.clientId) {
      try {
        const existing = await LaundryOrder.findOne({ business: req.businessId, clientId });
        if (existing) return res.status(200).json({ duplicate: true, order: view(existing) });
      } catch (lookupErr) {
        // fall through to the original error
      }
    }
    next(err);
  }
}

// PATCH /api/laundry/:id   body: any of { lines, handover, deliveryAddress, deliveryFee, riderName, riderPhone, express, expressPercent, discountType, discountValue, deliveryDate, notes }
// Changing the rows works out the totals again. The total can never go below what the customer has already paid.
async function updateOrder(req, res, next) {
  try {
    const order = await loadOrder(req);
    assertOpen(order);
    const body = req.body || {};

    const set = {};
    const unset = {};
    const changes = [];

    if (body.deliveryDate !== undefined) {
      const day = parseDay(body.deliveryDate, 'The delivery date');
      if (day) set.deliveryDate = day;
      else unset.deliveryDate = '';
      changes.push('delivery date');
    }
    if (body.notes !== undefined) {
      const notes = cleanLong(body.notes, 1000);
      if (notes) set.notes = notes;
      else unset.notes = '';
      changes.push('notes');
    }

    const plan = planDelivery(body, order);
    if (plan.touches) {
      Object.assign(set, plan.set);
      Object.assign(unset, plan.unset);
      changes.push(plan.handover === 'delivery' ? 'delivery' : 'pick up');
    }

    const touchesPricing = ['express', 'expressPercent', 'discountType', 'discountValue'].some((k) => body[k] !== undefined);
    const options = readPricingOptions(body, order, (await loadPreferences(req.businessId)).expressPercent);
    if (touchesPricing) changes.push('the express / discount');

    let lines = order.lines.map((l) => l.toObject());
    if (body.lines !== undefined) {
      lines = await readLines(req, body.lines, { dateIn: order.dateIn, dateOut: set.deliveryDate || order.deliveryDate });
      set.lines = lines;
      changes.push('the items');
    }

    const filter = { _id: order._id, business: req.businessId, status: { $ne: 'collected' } };
    if (body.lines !== undefined || plan.touches || touchesPricing) {
      const totals = totalsOf(lines, plan.deliveryFee, options);
      if (totals.subtotal <= 0) throw httpError(400, 'The order cannot have a total of nothing. Type a price on the rows.');
      if (totals.totalAmount < order.amountPaid) {
        throw httpError(400, `The customer has already paid ${money(order.amountPaid)}, so the total cannot be lower than that.`);
      }
      putTotals(set, unset, totals);
      filter.amountPaid = { $lte: totals.totalAmount };
    }

    if (changes.length === 0) return res.json({ order: view(order) });

    const update = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const updated = await LaundryOrder.findOneAndUpdate(filter, update, { new: true });
    if (!updated) throw httpError(409, 'This order was just changed by someone else. Reload it and try again.');

    logActivity(req, {
      action: 'laundry.update',
      summary: `Changed laundry order ${code(updated)}: ${changes.join(', ')}${body.lines !== undefined ? ` (total now ${money(updated.totalAmount)})` : ''}.`,
      entityType: 'LaundryOrder',
      entityId: updated._id,
    });
    res.json({ order: view(updated) });
  } catch (err) {
    next(err);
  }
}

// POST /api/laundry/:id/status   body: { status, note?, handover?, deliveryAddress?, deliveryFee?, riderName?, riderPhone? }
// The delivery details can be sent with the status, so "Ready" can also say "deliver it" in one step.
async function changeStatus(req, res, next) {
  try {
    const body = req.body || {};
    const wanted = body.status;
    if (!STATUSES.includes(wanted)) throw httpError(400, 'Choose a status');

    const order = await loadOrder(req);
    assertOpen(order);
    if (order.status === wanted) throw httpError(400, `This order is already "${STATUS_LABELS[wanted]}".`);

    const plan = planDelivery(body, order);
    const lines = order.lines.map((l) => l.toObject());
    const set = { status: wanted };
    const unset = {};
    let totalAmount = order.totalAmount;

    if (plan.touches) {
      Object.assign(set, plan.set);
      Object.assign(unset, plan.unset);
      const totals = totalsOf(lines, plan.deliveryFee, order);
      if (totals.totalAmount < order.amountPaid) {
        throw httpError(400, `The customer has already paid ${money(order.amountPaid)}, so the delivery fee cannot take the total below that.`);
      }
      putTotals(set, unset, totals);
      totalAmount = totals.totalAmount;
    }

    const handover = plan.touches ? plan.handover : order.handover || 'pickup';
    if (wanted === 'out_for_delivery') {
      if (handover !== 'delivery') throw httpError(400, 'Only a delivery order can go out for delivery. Choose delivery for this order first.');
      if (order.status !== 'ready') throw httpError(400, 'Mark the order Ready first, then send it out for delivery.');
      const rider = plan.touches && 'riderName' in plan.set ? plan.set.riderName : plan.touches ? '' : order.riderName;
      if (!rider) throw httpError(400, 'Enter the name of the rider taking this order to the customer.');
    }

    if (wanted === 'collected') {
      const balance = balanceOf(totalAmount, order.amountPaid);
      if (balance > 0) {
        throw httpError(400, `The customer still owes ${money(balance)}. Record the payment first, then ${handover === 'delivery' ? 'mark it delivered' : 'hand over the clothes'}.`);
      }
    }

    const now = new Date();
    if (wanted === 'ready') set.readyAt = now;
    else if (wanted === 'collected') set.collectedAt = now;
    else if (wanted === 'out_for_delivery') set.outAt = now;
    if (wanted === 'received' || wanted === 'processing') unset.readyAt = '';
    if (wanted !== 'out_for_delivery' && wanted !== 'collected') unset.outAt = '';

    const update = {
      $set: set,
      $push: { history: { status: wanted, at: now, byName: req.user.name, note: clean(body.note, 200) || undefined } },
    };
    if (Object.keys(unset).length > 0) update.$unset = unset;

    const filter = { _id: order._id, business: req.businessId, status: order.status, amountPaid: order.amountPaid, totalAmount: order.totalAmount };
    const updated = await LaundryOrder.findOneAndUpdate(filter, update, { new: true });
    if (!updated) throw httpError(409, 'This order was just changed by someone else. Reload it and try again.');

    logActivity(req, {
      action: 'laundry.status',
      summary: `Laundry order ${code(updated)} (${updated.customerName}) is now "${STATUS_LABELS[wanted]}"${wanted === 'out_for_delivery' && updated.riderName ? ` with ${updated.riderName}` : ''}.`,
      entityType: 'LaundryOrder',
      entityId: updated._id,
      meta: { status: wanted },
    });
    if (wanted === 'ready') {
      notifyOwners(
        req.businessId,
        { type: 'jobReady', title: `Laundry order ${code(updated)} is ready`, body: `${updated.customerName}'s clothes are ready for ${updated.handover === 'delivery' ? 'delivery' : 'pick-up'}.`, link: `/dashboard/laundry/${updated._id}` },
        { exceptUserId: req.user._id }
      );
    }
    res.json({ order: view(updated) });
  } catch (err) {
    next(err);
  }
}

// POST /api/laundry/:id/payments   body: { amount, method?, note? }
async function addPayment(req, res, next) {
  try {
    const body = req.body || {};
    const amount = readMoney(body.amount, 'The amount', { min: 0.01 });
    const method = readMethod(body.method);

    const paymentKey = readPaymentKey(body);

    const order = await loadOrder(req);
    // the same payment sent again (a double tap, a lost answer) is not taken twice
    if (paymentKey && (order.payments || []).some((p) => p.key === paymentKey)) {
      return res.status(200).json({ duplicate: true, order: view(order) });
    }
    assertOpen(order);
    const balance = balanceOf(order.totalAmount, order.amountPaid);
    if (amount > balance) throw httpError(400, balance > 0 ? `That is more than the balance of ${money(balance)}.` : 'This order is already paid in full.');

    const updated = await LaundryOrder.findOneAndUpdate(
      { _id: order._id, business: req.businessId, status: { $ne: 'collected' }, amountPaid: order.amountPaid, totalAmount: order.totalAmount },
      {
        $push: { payments: paymentEntry(req, { amount, method, note: body.note, kind: 'payment', key: paymentKey }) },
        $inc: { amountPaid: amount },
      },
      { new: true }
    );
    if (!updated) throw httpError(409, 'Another payment was just recorded on this order. Check the balance and try again.');

    // (only if nothing else was added in the meantime: a newer payment tidies up after itself)
    const exact = round2(updated.payments.reduce((sum, p) => sum + p.amount, 0));
    if (exact !== updated.amountPaid) {
      const tidy = await LaundryOrder.findOneAndUpdate({ _id: updated._id, business: req.businessId, amountPaid: updated.amountPaid }, { $set: { amountPaid: exact } }, { new: true });
      if (tidy) updated.amountPaid = tidy.amountPaid;
    }

    logActivity(req, {
      action: 'laundry.payment',
      summary: `Took ${money(amount)} on laundry order ${code(updated)} from ${updated.customerName}${balanceOf(updated.totalAmount, updated.amountPaid) > 0 ? `, ${money(balanceOf(updated.totalAmount, updated.amountPaid))} still to pay` : ''}.`,
      entityType: 'LaundryOrder',
      entityId: updated._id,
      meta: { amount, method },
    });
    res.status(201).json({ order: view(updated) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/laundry/:id   (administrator only): an order entered by mistake, before any money is taken
async function deleteOrder(req, res, next) {
  try {
    const removed = await LaundryOrder.findOneAndDelete({
      _id: req.params.id,
      business: req.businessId,
      status: { $ne: 'collected' },
      'payments.0': { $exists: false },
    });
    if (!removed) {
      const order = await LaundryOrder.findOne({ _id: req.params.id, business: req.businessId });
      if (!order) throw httpError(404, 'Laundry order not found');
      throw httpError(400, order.status === 'collected' ? 'A collected order cannot be deleted.' : 'Money has been taken on this order, so it cannot be deleted.');
    }

    logActivity(req, {
      action: 'laundry.delete',
      summary: `Deleted laundry order ${code(removed)} (${removed.customerName}).`,
      entityType: 'LaundryOrder',
      entityId: removed._id,
    });
    res.json({ message: 'Laundry order deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  overview,
  listItems,
  createItem,
  updateItem,
  deleteItem,
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  changeStatus,
  addPayment,
  deleteOrder,
  DEFAULT_ITEMS,
  SERVICES,
};
