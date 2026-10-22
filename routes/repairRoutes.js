const express = require('express');
const {
  listRepairs,
  getRepair,
  createRepair,
  updateRepair,
  changeStatus,
  addPayment,
  addPart,
  removePart,
  deleteRepair,
} = require('../controllers/repairController');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Looking at repair jobs: the same people who can see sales. Taking in and updating jobs needs "Record sales".
// Everyone who works on jobs sees all of them (a technician has to finish a job someone else took in).
const readRepairs = requirePermission('recordSales', 'viewAllSales', 'viewInsights');
const writeRepairs = requirePermission('recordSales');

router.get('/', readRepairs, listRepairs);
router.post('/', writeRepairs, createRepair);
router.get('/:id', readRepairs, getRepair);
router.patch('/:id', writeRepairs, updateRepair);
router.post('/:id/status', writeRepairs, changeStatus);
router.post('/:id/payments', writeRepairs, addPayment);
router.post('/:id/parts', writeRepairs, addPart);
router.delete('/:id/parts/:partId', writeRepairs, removePart);
// a job entered by mistake (only before any money is taken): administrator only
router.delete('/:id', requireRole('owner'), deleteRepair);

module.exports = router;
