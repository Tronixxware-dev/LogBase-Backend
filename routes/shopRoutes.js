const express = require('express');
const { listShops, createShop, updateShop } = require('../controllers/shopController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Everyone signed in sees the list (they need it to choose the store they work in); only the administrator changes it.
router.get('/', listShops);
router.post('/', requireRole('owner'), createShop);
router.patch('/:id', requireRole('owner'), updateShop);

module.exports = router;
