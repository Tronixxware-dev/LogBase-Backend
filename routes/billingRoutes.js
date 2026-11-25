const express = require('express');
const { getBilling, checkout, verify, webhook, setAutoRenew, removeCard, googleVerify, googleNotifications } = require('../controllers/billingController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Paystack calls this one itself, so it has no login. It is protected by Paystack's signature instead.
router.post('/webhook', webhook);

// Google Play's notifications about renewals and cancellations; protected by the secret in the address.
router.post('/google/notify/:token', googleNotifications);

// Everything else is for the administrator only.
router.use(requireAuth, requireRole('owner'));
router.get('/', getBilling);
router.post('/checkout', checkout);
router.post('/verify', verify);
router.post('/google/verify', googleVerify);
router.put('/auto-renew', setAutoRenew);
router.delete('/card', removeCard);

module.exports = router;
