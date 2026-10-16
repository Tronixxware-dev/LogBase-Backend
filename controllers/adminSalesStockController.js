// The "Sales & Stock" page of the LogBase admin panel: what every business on LogBase has sold and what is on
// their shelves, added together. It is built for screen recordings and posts, so it never returns a business name,
// an owner's name, a staff member's name or a customer's name: only totals, categories and product names.
//
//   GET /api/admin/sales-stock?days=30        (days: 7, 30 or 90)
//
// Only the LogBase super admin can call it (routes/adminRoutes.js checks that for every admin route).

const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Business = require('../models/Business');

const DAY = 24 * 60 * 60 * 1000;
const TIME_ZONE = 'Africa/Lagos'; // Nigeria has no daylight saving: always UTC+1
const RANGES = [7, 30, 90];
const RECENT_SALES = 12;
const CATEGORY_ROWS = 6; // the biggest ones are listed, the rest become "Other"

// "2026-10-16" for each of the last `count` days, today last (Nigerian time)
function dayKeys(count, now = new Date()) {
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * DAY);
    keys.push(d.toLocaleDateString('en-CA', { timeZone: TIME_ZONE }));
  }
  return keys;
}

// "mobile phones" -> "Mobile phones" (categories are compared in lower case, so "Phones" and "phones" are one)
function categoryLabel(key) {
  const text = String(key || '').trim();
  if (!text) return 'Uncategorised';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// the biggest `limit` rows, with everything else added up into one "Other" row
function withOther(rows, limit, makeOther) {
  if (rows.length <= limit + 1) return rows;
  const rest = rows.slice(limit);
  return [...rows.slice(0, limit), makeOther(rest)];
}

async function salesStock(req, res, next) {
  try {
    const requested = parseInt(req.query.days, 10);
    const days = RANGES.includes(requested) ? requested : 30;

    const now = new Date();
    const keys = dayKeys(days, now);
    const since = new Date(`${keys[0]}T00:00:00+01:00`); // the start of the first day, in Nigerian time
    const previousSince = new Date(since.getTime() - days * DAY);
    // a line whose goods all came back is not a sale any more
    const live = { quantity: { $gt: 0 } };
    const inPeriod = { ...live, date: { $gte: since } };

    const [dailyRows, previousRows, methodRows, soldCategoryRows, stockRows, recentRows, activeBusinesses, businessCount] =
      await Promise.all([
        // one row per day: first the lines are joined into sales (a multi-item sale shares a saleGroup), then added up
        Sale.aggregate([
          { $match: inPeriod },
          {
            $group: {
              _id: {
                day: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: TIME_ZONE } },
                sale: { $ifNull: ['$saleGroup', '$_id'] },
              },
              total: { $sum: '$totalAmount' },
              units: { $sum: '$quantity' },
              paid: { $sum: '$amountPaid' },
            },
          },
          {
            $group: {
              _id: '$_id.day',
              count: { $sum: 1 },
              total: { $sum: '$total' },
              units: { $sum: '$units' },
              paid: { $sum: '$paid' },
            },
          },
        ]),

        // the period just before this one, to show whether sales are going up or down
        Sale.aggregate([
          { $match: { ...live, date: { $gte: previousSince, $lt: since } } },
          { $group: { _id: null, total: { $sum: '$totalAmount' } } },
        ]),

        Sale.aggregate([
          { $match: inPeriod },
          { $group: { _id: '$paymentMethod', total: { $sum: '$totalAmount' } } },
          { $sort: { total: -1 } },
        ]),

        // what sold, by product category
        Sale.aggregate([
          { $match: inPeriod },
          { $group: { _id: '$product', units: { $sum: '$quantity' }, total: { $sum: '$totalAmount' } } },
          { $lookup: { from: Product.collection.name, localField: '_id', foreignField: '_id', as: 'product' } },
          {
            $project: {
              units: 1,
              total: 1,
              category: { $toLower: { $trim: { input: { $ifNull: [{ $arrayElemAt: ['$product.category', 0] }, ''] } } } },
            },
          },
          { $group: { _id: '$category', units: { $sum: '$units' }, total: { $sum: '$total' } } },
          { $sort: { units: -1 } },
        ]),

        // what is on the shelves right now (products that were deleted are kept with isActive: false, so they are left out)
        Product.aggregate([
          { $match: { isActive: true } },
          {
            $project: {
              category: { $toLower: { $trim: { input: { $ifNull: ['$category', ''] } } } },
              quantity: { $ifNull: ['$quantity', 0] },
              reorderThreshold: { $ifNull: ['$reorderThreshold', 0] },
              // worth at the selling price; a colour / size can have its own price
              value: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                  {
                    $reduce: {
                      input: '$variants',
                      initialValue: 0,
                      in: {
                        $add: [
                          '$$value',
                          { $multiply: [{ $ifNull: ['$$this.quantity', 0] }, { $ifNull: ['$$this.sellingPrice', '$sellingPrice'] }] },
                        ],
                      },
                    },
                  },
                  { $multiply: [{ $ifNull: ['$quantity', 0] }, { $ifNull: ['$sellingPrice', 0] }] },
                ],
              },
            },
          },
          {
            $facet: {
              totals: [
                {
                  $group: {
                    _id: null,
                    products: { $sum: 1 },
                    units: { $sum: '$quantity' },
                    value: { $sum: '$value' },
                    out: { $sum: { $cond: [{ $lte: ['$quantity', 0] }, 1, 0] } },
                    low: {
                      $sum: {
                        $cond: [{ $and: [{ $gt: ['$quantity', 0] }, { $lte: ['$quantity', '$reorderThreshold'] }] }, 1, 0],
                      },
                    },
                  },
                },
              ],
              categories: [
                { $group: { _id: '$category', units: { $sum: '$quantity' }, products: { $sum: 1 } } },
                { $sort: { units: -1 } },
              ],
            },
          },
        ]),

        // the latest sales: the product and the money only (no business, seller or customer)
        Sale.find(live)
          .sort({ date: -1, createdAt: -1 })
          .limit(RECENT_SALES)
          .select('product variantLabel quantity unitPrice totalAmount paymentStatus date createdAt')
          .populate('product', 'name images')
          .lean(),

        Sale.distinct('business', inPeriod),
        Business.countDocuments({ isActive: { $ne: false } }),
      ]);

    /* ---- sales ---- */
    const dayMap = new Map(dailyRows.map((r) => [r._id, r]));
    const byDay = keys.map((day) => {
      const row = dayMap.get(day) || {};
      return { day, count: num(row.count), total: num(row.total), units: num(row.units), paid: num(row.paid) };
    });
    const revenue = byDay.reduce((s, d) => s + d.total, 0);
    const collected = byDay.reduce((s, d) => s + d.paid, 0);
    const salesCount = byDay.reduce((s, d) => s + d.count, 0);
    const soldUnits = byDay.reduce((s, d) => s + d.units, 0);

    /* ---- stock ---- */
    const stockFacet = stockRows[0] || {};
    const totals = (stockFacet.totals && stockFacet.totals[0]) || {};
    const stockTotals = {
      products: num(totals.products),
      units: num(totals.units),
      value: num(totals.value),
      out: num(totals.out),
      low: num(totals.low),
    };
    stockTotals.ok = Math.max(0, stockTotals.products - stockTotals.out - stockTotals.low);

    const stockCategories = (stockFacet.categories || []).map((c) => ({
      key: c._id,
      label: categoryLabel(c._id),
      units: num(c.units),
      products: num(c.products),
    }));
    const soldCategories = soldCategoryRows.map((c) => ({
      key: c._id,
      label: categoryLabel(c._id),
      units: num(c.units),
      total: num(c.total),
    }));

    // how long each category's stock will last at the pace it sold over the period (shortest first)
    const soldByKey = new Map(soldCategories.map((c) => [c.key, c.units]));
    const cover = stockCategories
      .filter((c) => (soldByKey.get(c.key) || 0) > 0)
      .map((c) => {
        const perDay = soldByKey.get(c.key) / days;
        return { label: c.label, units: c.units, perDay, daysLeft: c.units / perDay };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 5);

    res.json({
      days,
      sales: {
        revenue,
        previousRevenue: num((previousRows[0] || {}).total),
        count: salesCount,
        units: soldUnits,
        collected,
        owed: Math.max(0, revenue - collected),
        businessesSelling: activeBusinesses.length,
      },
      businesses: businessCount,
      byDay,
      methods: methodRows.map((m) => ({ method: m._id || 'other', total: num(m.total) })),
      stock: {
        ...stockTotals,
        categories: withOther(stockCategories, CATEGORY_ROWS, (rest) => ({
          key: '__other',
          label: 'Other',
          units: rest.reduce((s, c) => s + c.units, 0),
          products: rest.reduce((s, c) => s + c.products, 0),
        })),
      },
      soldCategories: withOther(soldCategories, CATEGORY_ROWS, (rest) => ({
        key: '__other',
        label: 'Other',
        units: rest.reduce((s, c) => s + c.units, 0),
        total: rest.reduce((s, c) => s + c.total, 0),
      })),
      cover,
      recent: recentRows.map((s) => {
        const images = (s.product && s.product.images) || [];
        const image = images.find((img) => img.isCover) || images[0];
        return {
          id: String(s._id),
          product: (s.product && s.product.name) || 'Deleted product',
          cover: image ? image.url : '',
          variant: s.variantLabel || '',
          quantity: num(s.quantity),
          unitPrice: num(s.unitPrice),
          total: num(s.totalAmount),
          status: s.paymentStatus || 'paid',
          date: s.date || s.createdAt,
        };
      }),
      generatedAt: now,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { salesStock };
