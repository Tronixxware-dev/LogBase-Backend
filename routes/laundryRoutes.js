const express = require('express');
const {
  overview,
  listItems,
  createItem,
  updateItem,
  deleteItem,
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  changeStatus,
  addPayment,
  deleteOrder,
} = require('../controllers/laundryController');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Looking at the register: the same people who can see sales. Taking in and updating orders needs "Record sales".
// Everyone who works on the register sees all orders (whoever is at the counter hands back what a colleague took in).
const readLaundry = requirePermission('recordSales', 'viewAllSales', 'viewInsights');
const writeLaundry = requirePermission('recordSales');

// The list of clothing items and prices: everyone who works on the register can read it, only the administrator changes it.
// (These come before /:id so "items" is not taken for an order id.)
router.get('/items', readLaundry, listItems);
router.post('/items', requireRole('owner'), createItem);
router.put('/items/:id', requireRole('owner'), updateItem);
router.delete('/items/:id', requireRole('owner'), deleteItem);

// today at a glance, the charts and the orders that need attention (before /:id)
router.get('/overview', readLaundry, overview);

router.get('/', readLaundry, listOrders);
router.post('/', writeLaundry, createOrder);
router.get('/:id', readLaundry, getOrder);
router.patch('/:id', writeLaundry, updateOrder);
router.post('/:id/status', writeLaundry, changeStatus);
router.post('/:id/payments', writeLaundry, addPayment);
// an order entered by mistake (only before any money is taken): administrator only
router.delete('/:id', requireRole('owner'), deleteOrder);

module.exports = router;
