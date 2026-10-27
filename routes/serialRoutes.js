const express = require('express');
const { lookup, available, listForProduct, addForProduct, updateUnit, removeUnit } = require('../controllers/serialController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Anyone who sells, processes returns or looks after stock may look a unit up (the controller hides what they may not see).
const mayLook = requirePermission('recordSales', 'viewAllSales', 'viewInsights', 'viewStock', 'managePurchases', 'processReturns');
router.get('/lookup', mayLook, lookup);
router.get('/available', mayLook, available);

// Seeing, adding, correcting and removing the numbers of a product is part of managing that product.
const manage = requirePermission('manageProducts');
router.get('/product/:id', manage, listForProduct);
router.post('/product/:id', manage, addForProduct);
router.put('/:id', manage, updateUnit);
router.delete('/:id', manage, removeUnit);

module.exports = router;
