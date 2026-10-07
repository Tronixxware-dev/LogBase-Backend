const express = require('express');
const { lookup, available } = require('../controllers/serialController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Anyone who sells, processes returns or looks after stock may look a unit up (the controller hides what they may not see).
const mayLook = requirePermission('recordSales', 'viewAllSales', 'viewInsights', 'viewStock', 'managePurchases', 'processReturns');
router.get('/lookup', mayLook, lookup);
router.get('/available', mayLook, available);

module.exports = router;
