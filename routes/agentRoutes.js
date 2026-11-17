const express = require('express');
const { myAgent, saveLog, inviteInfo, acceptInvite } = require('../controllers/agentController');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../utils/rateLimit');

const router = express.Router();

// The "your application is accepted" e-mail link: no login yet, the long random token in the link is the proof
router.get('/invite/:token', rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }), inviteInfo);
router.post('/invite/:token', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), acceptInvite);

// Any signed-in person may ask; only someone the admin linked to a Sales Agent record gets anything back.
router.get('/me', requireAuth, myAgent);
router.put('/log', requireAuth, saveLog);

module.exports = router;
