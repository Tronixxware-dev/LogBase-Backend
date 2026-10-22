const express = require('express');
const { getSettings, updateOrganization, updatePreferences, updatePolicies, uploadLogo, deleteLogo } = require('../controllers/settingsController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logoUpload } = require('../config/cloudinary');

const router = express.Router();

router.use(requireAuth);

// Everyone reads the settings (receipts and slips need the business identity); only the administrator changes them.
router.get('/', getSettings);
router.put('/organization', requireRole('owner'), updateOrganization);
router.put('/preferences', requireRole('owner'), updatePreferences);
router.put('/approval-policies', requireRole('owner'), updatePolicies);
// the role check comes BEFORE the upload, so a staff never sends a file to Cloudinary
router.post('/logo', requireRole('owner'), logoUpload.single('logo'), uploadLogo);
router.delete('/logo', requireRole('owner'), deleteLogo);

module.exports = router;
