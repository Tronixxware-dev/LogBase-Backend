const express = require('express');
const {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  addVariant,
  updateVariant,
  deleteVariant,
  uploadImages,
  deleteImage,
} = require('../controllers/productController');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { upload } = require('../config/cloudinary');

const router = express.Router();

router.use(requireAuth);

// Anyone who sells, checks stock, buys stock or reads the insights needs to look at products.
// Cost prices are only included for people allowed to see them (see utils/staffView.js).
router.get('/', requirePermission('recordSales', 'viewStock', 'manageProducts', 'managePurchases', 'viewInsights', 'adjustStock'), listProducts);
router.get('/:id', requirePermission('recordSales', 'viewStock', 'manageProducts', 'managePurchases', 'viewInsights', 'adjustStock'), getProduct);

// Changing products needs the "Manage products" permission (the owner always has it).
const manage = requirePermission('manageProducts');
router.post('/', manage, createProduct);
router.put('/:id', manage, updateProduct);
router.delete('/:id', manage, deleteProduct);

router.post('/:id/variants', manage, addVariant);
router.put('/:id/variants/:variantId', manage, updateVariant);
router.delete('/:id/variants/:variantId', manage, deleteVariant);

router.post('/:id/images', manage, upload.array('images', 6), uploadImages);
router.delete('/:id/images/:publicId', manage, deleteImage);

module.exports = router;
