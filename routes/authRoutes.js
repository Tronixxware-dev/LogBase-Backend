const express = require('express');
const {
  registerBusiness,
  inviteStaff,
  listStaff,
  updateStaff,
  login,
  getMe,
  updateMe,
  changePassword,
  lockedForStaff,
  uploadMyPhoto,
  deleteMyPhoto,
  uploadMyCover,
  deleteMyCover,
  uploadStaffPhoto,
  deleteStaffPhoto,
  uploadStaffCover,
  deleteStaffCover,
  listTeam,
} = require('../controllers/authController');
const { forgotPassword, resetPassword } = require('../controllers/passwordResetController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { avatarUpload, coverUpload } = require('../config/cloudinary');
const { rateLimit } = require('../utils/rateLimit');

const router = express.Router();

// Per address: sign-ups are rare, so 10 an hour is plenty; the password e-mail routes are also limited per account
// (login has its own wrong-password limits inside the controller).
router.post('/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many sign-ups from this connection. Please try again later.' }), registerBusiness);
router.post('/login', login);
// Forgot password: no login needed (the person cannot log in), the emailed link is the proof
router.post('/forgot-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), forgotPassword);
router.post('/reset-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), resetPassword);
router.get('/me', requireAuth, getMe);
router.patch('/me', requireAuth, updateMe);
router.post('/change-password', requireAuth, changePassword);

// Your own profile photo and cover picture. A staff can add each one once; after that only the administrator can
// change or remove it. The lock check comes BEFORE the upload, so a locked staff never sends a file to Cloudinary.
router.post('/me/photo', requireAuth, lockedForStaff('photo'), avatarUpload.single('photo'), uploadMyPhoto);
router.delete('/me/photo', requireAuth, lockedForStaff('photo'), deleteMyPhoto);
router.post('/me/cover', requireAuth, lockedForStaff('cover'), coverUpload.single('cover'), uploadMyCover);
router.delete('/me/cover', requireAuth, lockedForStaff('cover'), deleteMyCover);

router.get('/team', requireAuth, listTeam);

// Staff accounts are created and managed by the administrator only.
router.post('/invite-staff', requireAuth, requireRole('owner'), inviteStaff);
router.get('/staff', requireAuth, requireRole('owner'), listStaff);
router.patch('/staff/:id', requireAuth, requireRole('owner'), updateStaff);
router.post('/staff/:id/photo', requireAuth, requireRole('owner'), avatarUpload.single('photo'), uploadStaffPhoto);
router.delete('/staff/:id/photo', requireAuth, requireRole('owner'), deleteStaffPhoto);
router.post('/staff/:id/cover', requireAuth, requireRole('owner'), coverUpload.single('cover'), uploadStaffCover);
router.delete('/staff/:id/cover', requireAuth, requireRole('owner'), deleteStaffCover);

module.exports = router;
