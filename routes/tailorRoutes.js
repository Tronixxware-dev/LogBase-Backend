const express = require('express');
const c = require('../controllers/tailorController');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { jobUpload } = require('../config/cloudinary');

const router = express.Router();

router.use(requireAuth);

// Looking at tailor orders: the same people who can see sales. Taking orders and working on them needs "Record sales".
// Everyone who works on orders sees all of them (a cutter has to finish an order someone else took).
const read = requirePermission('recordSales', 'viewAllSales', 'viewInsights');
const write = requirePermission('recordSales');
const owner = requireRole('owner');

// the price list of garments and the measurement book come before the orders (their addresses are not order ids)
router.get('/overview', read, c.overview);
router.get('/styles', read, c.listStyles);
router.post('/styles', owner, c.createStyle);
router.patch('/styles/:id', owner, c.updateStyle);
router.delete('/styles/:id', owner, c.deleteStyle);
router.get('/measurements', read, c.listMeasurements);
router.put('/measurements', write, c.saveMeasurement);
router.delete('/measurements/:id', write, c.deleteMeasurement);

router.get('/', read, c.listOrders);
router.post('/', write, c.createOrder);
router.get('/:id', read, c.getOrder);
router.patch('/:id', write, c.updateOrder);
router.post('/:id/status', write, c.changeStatus);
router.post('/:id/payments', write, c.addPayment);
router.post('/:id/pieces', write, c.addPiece);
router.patch('/:id/pieces/:pieceId', write, c.updatePiece);
router.delete('/:id/pieces/:pieceId', write, c.removePiece);
router.post('/:id/pieces/:pieceId/done', write, c.setPieceDone);
router.post('/:id/materials', write, c.addMaterial);
router.delete('/:id/materials/:materialId', write, c.removeMaterial);
router.post('/:id/fittings', write, c.addFitting);
router.patch('/:id/fittings/:fittingId', write, c.updateFitting);
router.delete('/:id/fittings/:fittingId', write, c.removeFitting);
router.post('/:id/photos', write, jobUpload.array('images', 6), c.uploadPhotos);
router.delete('/:id/photos/:photoId', write, c.deletePhoto);
router.delete('/:id', owner, c.deleteOrder);

module.exports = router;
