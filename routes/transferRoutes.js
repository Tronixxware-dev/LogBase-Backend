const express = require('express');
const { listTransfers, getTransfer, createTransfer, acceptTransfer, declineTransfer, cancelTransfer } = require('../controllers/transferController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Moving stock between stores needs the "Adjust stock" permission (the administrator always has it).
router.post('/', requirePermission('adjustStock'), createTransfer);
router.post('/:id/accept', requirePermission('adjustStock'), acceptTransfer);
router.post('/:id/decline', requirePermission('adjustStock'), declineTransfer);
router.post('/:id/cancel', requirePermission('adjustStock'), cancelTransfer);
// Reading them: whoever adjusts stock, manages products or purchases, sees stock or the insights.
router.get('/', requirePermission('adjustStock', 'manageProducts', 'managePurchases', 'viewStock', 'viewInsights'), listTransfers);
router.get('/:id', requirePermission('adjustStock', 'manageProducts', 'managePurchases', 'viewStock', 'viewInsights'), getTransfer);

module.exports = router;
