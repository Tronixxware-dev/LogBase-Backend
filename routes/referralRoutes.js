const express = require('express');
const { myReferrals } = require('../controllers/referralController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Any signed-in person may ask; only someone the admin linked to a referral code gets anything back.
router.get('/me', requireAuth, myReferrals);

module.exports = router;
