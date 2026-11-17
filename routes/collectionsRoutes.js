const express = require('express');
const { collected, history } = require('../controllers/collectionsController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Money taken on laundry orders, tailor orders and repair jobs, for any dates.
// Anyone who works the register may open it (a worker sees only the money they took themselves).
const readIt = requirePermission('recordSales', 'viewAllSales', 'viewInsights');
router.get('/', readIt, collected);
// every order, including the ones already collected / delivered (the permanent history)
router.get('/orders', readIt, history);

module.exports = router;
