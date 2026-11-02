const express = require('express');
const { listWorkers, getWorker, createWorker, updateWorker, deleteWorker, addEntry, deleteEntry } = require('../controllers/workerController');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Staff who take in orders may see who the workers are (to pick one for a job). What a worker earns,
// is paid or owed, and every change to the list, is for the administrator only.
router.get('/', requirePermission('recordSales', 'viewAllSales', 'viewInsights'), listWorkers);
router.post('/', requireRole('owner'), createWorker);
router.get('/:id', requireRole('owner'), getWorker);
router.patch('/:id', requireRole('owner'), updateWorker);
router.delete('/:id', requireRole('owner'), deleteWorker);
router.post('/:id/entries', requireRole('owner'), addEntry);
router.delete('/:id/entries/:entryId', requireRole('owner'), deleteEntry);

module.exports = router;
