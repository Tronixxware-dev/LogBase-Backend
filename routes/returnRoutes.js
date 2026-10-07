const express = require('express');
const { createReturn, listReturns } = require('../controllers/returnController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Taking an item back needs the "Process returns" permission (the administrator always has it).
router.post('/', requirePermission('processReturns'), createReturn);
// Reading them: whoever can process returns or see sales (the controller narrows it to their own when needed).
router.get('/', requirePermission('processReturns', 'viewAllSales', 'viewInsights'), listReturns);

module.exports = router;
