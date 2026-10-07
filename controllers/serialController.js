const SerialUnit = require('../models/SerialUnit');
const Product = require('../models/Product');
const { httpError } = require('../utils/httpError');
const { can, canSeeCosts } = require('../utils/permissions');
const { warrantyState } = require('../utils/serials');

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One unit as the lookup page shows it. Anyone who can only see their own sales learns nothing about who bought
// a unit somebody else sold, and only the administrator sees what it cost.
function unitView(req, unit, productName) {
  const u = typeof unit.toObject === 'function' ? unit.toObject() : { ...unit };
  const sees = can(req.user, 'viewAllSales', 'viewInsights') || (u.soldBy && String(u.soldBy) === String(req.user._id));
  const warranty = u.status === 'sold' ? { months: u.warrantyMonths || 0, endsAt: u.warrantyEndsAt || null, ...warrantyState(u.warrantyEndsAt) } : null;

  const out = {
    _id: u._id,
    serial: u.serial,
    status: u.status,
    product: { _id: u.product, name: productName || '' },
    variantLabel: u.variantLabel || '',
    supplierName: canSeeCosts(req.user) ? u.supplierName || '' : '',
    receivedAt: u.receivedAt || null,
    soldAt: u.soldAt || null,
    warranty,
    events: (u.events || []).map((e) => ({
      type: e.type,
      at: e.at,
      // a "received" note is the supplier's name, which only the administrator sees
      note: (u.status === 'sold' && !sees) || (e.type === 'received' && !canSeeCosts(req.user)) ? '' : e.note || '',
      ref: sees ? e.ref : undefined,
    })),
  };
  if (canSeeCosts(req.user)) out.costPrice = u.costPrice == null ? null : u.costPrice;
  if (u.status === 'sold' && sees) {
    out.sale = u.sale;
    out.customer = u.customer;
    out.customerName = u.customerName || '';
  }
  return out;
}

// GET /api/serials/lookup?q=356938035643809
// Finds a unit by its full IMEI / serial number, or by any part of it (4 characters or more, e.g. the last digits).
// Answers: what it is, where it came from, whether it is on the shelf, who bought it and whether the warranty still runs.
async function lookup(req, res, next) {
  try {
    const q = String(req.query.q || '').trim().replace(/\s+/g, '').toUpperCase();
    if (q.length < 4) throw httpError(400, 'Type at least 4 characters of the IMEI / serial number');
    if (q.length > 40 || !/^[A-Z0-9\-_./]+$/.test(q)) throw httpError(400, 'That is not a valid IMEI / serial number');

    let units = await SerialUnit.find({ business: req.businessId, serial: q }).limit(1);
    if (units.length === 0) {
      units = await SerialUnit.find({ business: req.businessId, serial: { $regex: escapeRegex(q) } }).sort({ updatedAt: -1 }).limit(20);
    }

    const products = await Product.find({ _id: { $in: units.map((u) => u.product) }, business: req.businessId });
    const nameOf = new Map(products.map((p) => [String(p._id), p.name]));
    res.json({ query: q, units: units.map((u) => unitView(req, u, nameOf.get(String(u.product)))) });
  } catch (err) {
    next(err);
  }
}

// GET /api/serials/available?product=<id>&variant=<id>
// The numbers of the units of a product that are on the shelf, so the sale form can offer them.
async function available(req, res, next) {
  try {
    if (!req.query.product) throw httpError(400, 'Choose a product');
    const filter = { business: req.businessId, product: String(req.query.product), status: 'in_stock' };
    if (req.query.variant) filter.variant = String(req.query.variant);
    const units = await SerialUnit.find(filter).sort({ receivedAt: 1, createdAt: 1 }).limit(1000);
    res.json({ serials: units.map((u) => u.serial) });
  } catch (err) {
    next(err);
  }
}

module.exports = { lookup, available, unitView };
