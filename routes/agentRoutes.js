const express = require('express');
const { myAgent, saveLog } = require('../controllers/agentController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Any signed-in person may ask; only someone the admin linked to a Sales Agent record gets anything back.
router.get('/me', requireAuth, myAgent);
router.put('/log', requireAuth, saveLog);

module.exports = router;
