const express = require('express');
const { listNotifications, readAll, readOne, getPreferences, updatePreferences } = require('../controllers/notificationController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', listNotifications);
router.post('/read-all', readAll);
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);
router.post('/:id/read', readOne);

module.exports = router;
