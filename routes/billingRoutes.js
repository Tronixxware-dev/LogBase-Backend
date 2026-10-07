const express = require('express');
const { getBilling, checkout, verify, webhook, setAutoRenew, removeCard } = require('../controllers/billingController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Paystack calls this one itself, so it has no login. It is protected by Paystack's signature instead.
router.post('/webhook', webhook);

// Everything else is for the administrator only.
router.use(requireAuth, requireRole('owner'));
router.get('/', getBilling);
router.post('/checkout', checkout);
router.post('/verify', verify);
router.put('/auto-renew', setAutoRenew);
router.delete('/card', removeCard);

module.exports = router;
