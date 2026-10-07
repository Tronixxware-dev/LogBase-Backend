const express = require('express');
const { listPurchases, getPurchase, createPurchase, assignSupplier } = require('../controllers/purchaseController');
const { requireAuth, requirePermission, requireRole } = require('../middleware/auth');
const { purchaseUpload } = require('../config/cloudinary');

const router = express.Router();

router.use(requireAuth);

// The list also feeds the Overview insights, so it is open to "See insights" as well.
router.get('/', requirePermission('managePurchases', 'viewInsights'), listPurchases);

// The photos are sent together with the purchase (multipart) and are saved with it.
// There is no route to edit, delete or add photos to a purchase afterwards: a recorded purchase is final.
router.post('/', requirePermission('managePurchases'), purchaseUpload.array('images', 8), createPurchase);

router.get('/:id', requirePermission('managePurchases'), getPurchase);

// Only the administrator adds a supplier to a purchase (a staff records goods without one).
router.put('/:id/supplier', requireRole('owner'), assignSupplier);

module.exports = router;
