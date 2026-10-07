const express = require('express');
const { importProducts, importCustomers } = require('../controllers/importController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Importing adds many records (and cost prices) at once, so only the administrator may do it.
router.use(requireAuth, requireRole('owner'));
router.post('/products', importProducts);
router.post('/customers', importCustomers);

module.exports = router;
