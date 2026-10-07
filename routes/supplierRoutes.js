const express = require('express');
const {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  recordPayment,
  getStatement,
} = require('../controllers/supplierController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Suppliers, what is owed to them and what was paid are for the administrator only.
// No permission a staff can be given opens any of this.
router.use(requireAuth, requireRole('owner'));

router.get('/', listSuppliers);
router.get('/:id', getSupplier);
router.post('/', createSupplier);
router.put('/:id', updateSupplier);
router.get('/:id/statement', getStatement);
router.post('/:id/payments', recordPayment);

module.exports = router;
