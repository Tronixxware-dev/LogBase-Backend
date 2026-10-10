const express = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const admin = require('../controllers/adminController');

const router = express.Router();

// Everything here is for the LogBase super admin only (the emails in SUPER_ADMIN_EMAILS).
router.use(requireAuth, requireSuperAdmin);

router.get('/overview', admin.overview);

router.get('/businesses', admin.listBusinesses);
router.get('/businesses/:id', admin.getBusiness);
router.get('/businesses/:id/data/:kind', admin.businessData);
router.post('/businesses/:id/suspend', admin.setSuspended);
router.post('/businesses/:id/extend-trial', admin.extendTrial);
router.post('/businesses/:id/grant-plan', admin.grantPlan);
router.post('/businesses/:id/end-plan', admin.endPlan);

router.post('/users/:id/send-reset', admin.sendReset);
router.patch('/users/:id', admin.setUserActive);

router.get('/payments', admin.listPayments);
router.get('/activity', admin.listActivity);
router.get('/log', admin.listAdminLog);

router.get('/email/audiences', admin.audiences);
router.post('/email', admin.sendAnnouncement);

module.exports = router;
