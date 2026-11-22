const express = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const admin = require('../controllers/adminController');
const adminSalesStock = require('../controllers/adminSalesStockController');
const referrals = require('../controllers/adminReferralController');
const agents = require('../controllers/adminAgentController');

const router = express.Router();

// Everything here is for the LogBase super admin only (the emails in SUPER_ADMIN_EMAILS).
router.use(requireAuth, requireSuperAdmin);

router.get('/overview', admin.overview);
router.get('/sales-stock', adminSalesStock.salesStock);

router.get('/businesses', admin.listBusinesses);
router.get('/businesses/:id', admin.getBusiness);
router.get('/businesses/:id/data/:kind', admin.businessData);
router.post('/businesses/:id/suspend', admin.setSuspended);
router.post('/businesses/:id/extend-trial', admin.extendTrial);
router.post('/businesses/:id/grant-plan', admin.grantPlan);
router.post('/businesses/:id/end-plan', admin.endPlan);

router.get('/users', admin.listUsers);
router.post('/users/:id/send-reset', admin.sendReset);
router.patch('/users/:id', admin.setUserActive);
router.post('/users/:id/email', admin.changeUserEmail);

// Sales Agents (the fixed paths come before /agents/:id)
router.get('/agents', agents.listAgents);
router.post('/agents', agents.createAgent);
router.get('/agents/weekly', agents.weekly);
router.post('/agents/weekly', agents.creditWeekly);
router.get('/agents/:id', agents.getAgent);
router.patch('/agents/:id', agents.updateAgent);
router.post('/agents/:id/payout', agents.payAgent);
router.post('/agents/:id/invite', agents.inviteAgent);
router.post('/agents/:id/adjust', agents.adjustAgent);

router.get('/referrers', referrals.listReferrers);
router.post('/referrers', referrals.createReferrer);
router.get('/referrers/people', referrals.listPeople);
router.get('/referrers/:id', referrals.getReferrer);
router.patch('/referrers/:id', referrals.updateReferrer);
router.post('/referrers/:id/payout', referrals.payReferrer);

router.get('/payments', admin.listPayments);
router.get('/activity', admin.listActivity);
router.get('/log', admin.listAdminLog);

router.get('/email/audiences', admin.audiences);
router.post('/email', admin.sendAnnouncement);

module.exports = router;
