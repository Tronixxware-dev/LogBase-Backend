const Sale = require('../models/Sale');
const { can } = require('../utils/permissions');
const { salesForUser } = require('../utils/staffView');
const { withSellerPhotos } = require('../utils/sellerPhotos');
const { applyShopFilter } = require('../utils/shopStock');

const LIST_LIMIT = 500;

// GET /api/swaps
// The sales that were item swaps (a customer handed in an old item and took a new one), newest first.
// Recording a swap goes through POST /api/sales (with a `tradeIn`), so a swap is an ordinary sale with the old item attached.
// Like the sales list: "See all sales" / "See insights" see every swap, anyone else only the ones they recorded.
async function listSwaps(req, res, next) {
  try {
    const filter = { business: req.businessId, 'tradeIn.description': { $exists: true } };
    if (!can(req.user, 'viewAllSales', 'viewInsights')) filter.recordedBy = req.user._id;
    await applyShopFilter(req, filter);

    const swaps = await Sale.find(filter)
      .populate('product', 'name sku images')
      .populate('customer', 'name phone')
      .sort({ date: -1, createdAt: -1 })
      .limit(LIST_LIMIT);

    res.json({ swaps: salesForUser(req, await withSellerPhotos(req.businessId, swaps)) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listSwaps };
