const express = require('express');
const { listRoles, createRole, updateRole, deleteRole } = require('../controllers/roleController');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Roles are made and managed by the owner only.
router.use(requireAuth, requireRole('owner'));

router.get('/', listRoles);
router.post('/', createRole);
router.put('/:id', updateRole);
router.delete('/:id', deleteRole);

module.exports = router;
