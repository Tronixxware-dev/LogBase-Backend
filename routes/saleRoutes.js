const express = require('express');
const { listSales, getSale, createSale } = require('../controllers/saleController');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { saleUpload } = require('../config/cloudinary');

const router = express.Router();

router.use(requireAuth);

// "See all sales" and "See insights" get every sale. Someone who can only record sales gets just their own
// (the controller applies that filter).
const readSales = requirePermission('recordSales', 'viewAllSales', 'viewInsights');
router.get('/', readSales, listSales);

// The photos are sent together with the sale (multipart) and are saved with it.
// There is no route to edit, delete or add photos to a sale afterwards: a recorded sale is final.
router.post('/', requirePermission('recordSales'), saleUpload.array('images', 8), createSale);

router.get('/:id', readSales, getSale);

module.exports = router;
