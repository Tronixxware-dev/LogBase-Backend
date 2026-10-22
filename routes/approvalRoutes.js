const express = require('express');
const { listApprovals, getApproval, approveApproval, declineApproval, cancelApproval } = require('../controllers/approvalController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// The administrator sees every request; a staff sees only their own (the controller applies that filter).
router.get('/', listApprovals);
router.get('/:id', getApproval);
router.post('/:id/approve', requireRole('owner'), approveApproval);
router.post('/:id/decline', requireRole('owner'), declineApproval);
// a staff takes back their own request that is still waiting
router.post('/:id/cancel', cancelApproval);

module.exports = router;
