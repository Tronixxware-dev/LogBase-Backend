const express = require('express');
const {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  recordPayment,
  getStatement,
} = require('../controllers/customerController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Looking customers up (and adding new ones) is part of recording a sale, so "Record sales" is enough for that.
// What customers owe, their history, and recording their payments need "Manage customers" (see customerController).
router.get('/', requirePermission('viewCustomers', 'addCustomers', 'manageCustomers', 'recordSales'), listCustomers);
router.get('/:id', requirePermission('viewCustomers', 'addCustomers', 'manageCustomers', 'recordSales'), getCustomer);
router.post('/', requirePermission('addCustomers', 'manageCustomers', 'recordSales'), createCustomer);

router.put('/:id', requirePermission('manageCustomers'), updateCustomer);
router.get('/:id/statement', requirePermission('manageCustomers'), getStatement);
router.post('/:id/payments', requirePermission('manageCustomers'), recordPayment);

module.exports = router;
