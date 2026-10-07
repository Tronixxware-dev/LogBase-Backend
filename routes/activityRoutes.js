const express = require('express');
const { listActivity } = require('../controllers/activityController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireFeature } = require('../utils/billing');

const router = express.Router();

// The activity log shows who did what, so only the administrator may read it (and only on the Business plan).
router.use(requireAuth, requireRole('owner'), requireFeature('activityLog', 'The activity log'));
router.get('/', listActivity);

module.exports = router;
