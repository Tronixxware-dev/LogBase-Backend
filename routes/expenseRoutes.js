const express = require('express');
const { createExpense, listExpenses, deleteExpense } = require('../controllers/expenseController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Expenses show what the business spends, so only the administrator may see or change them.
router.use(requireAuth, requireRole('owner'));
router.get('/', listExpenses);
router.post('/', createExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
