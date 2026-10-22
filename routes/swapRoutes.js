const express = require('express');
const { listSwaps } = require('../controllers/swapController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Same people as the sales list. A swap is recorded with POST /api/sales (see saleController); there is nothing to edit afterwards.
router.get('/', requirePermission('recordSales', 'viewAllSales', 'viewInsights'), listSwaps);

module.exports = router;
