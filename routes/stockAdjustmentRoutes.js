const express = require('express');
const { createAdjustment, listAdjustments } = require('../controllers/stockAdjustmentController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Changing stock by hand needs the "Adjust stock" permission (the administrator always has it).
router.post('/', requirePermission('adjustStock'), createAdjustment);
// Reading the history: anyone who adjusts stock, manages products or purchases, or sees the insights.
router.get('/', requirePermission('adjustStock', 'manageProducts', 'managePurchases', 'viewInsights'), listAdjustments);

module.exports = router;
