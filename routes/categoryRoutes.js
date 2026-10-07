const express = require('express');
const {
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
} = require('../controllers/categoryController');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Categories belong with products: they need the "Manage products" permission.
router.use(requireAuth, requirePermission('manageProducts'));

router.get('/', listCategories);
router.post('/', createCategory);
router.put('/:id', renameCategory);
router.delete('/:id', deleteCategory);

module.exports = router;
