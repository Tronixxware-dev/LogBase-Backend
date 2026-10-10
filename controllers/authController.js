const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Business = require('../models/Business');
const User = require('../models/User');
const { cloudinary } = require('../config/cloudinary');
const mailer = require('../utils/mailer');
const { TRIAL_DAYS } = require('../config/plans');
const { httpError } = require('../utils/httpError');
const { logActivity } = require('../utils/audit');
const { assertCanAddStaff } = require('../utils/billing');
const { checkPassword } = require('../utils/passwordPolicy');
const { loginGuard, changePasswordGuard, clientIp, lockedMessage: tooManyAttempts } = require('../utils/rateLimit');
const {
  permissionsOf,
  cleanPermissions,
  DEFAULT_STAFF_PERMISSIONS,
} = require('../utils/permissions');

function signToken(user) {
  return jwt.sign({ userId: user._id, businessId: user.business }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
}

function sanitizeUser(user, businessName) {
  const out = {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    jobTitle: user.jobTitle || '',
    phone: user.phone || '',
    photoUrl: (user.photo && user.photo.url) || '',
    coverUrl: (user.cover && user.cover.url) || '',
    // what this person may do; the owner has everything
    permissions: permissionsOf(user),
    business: user.business,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
  if (businessName) out.businessName = businessName;
  return out;
}

async function businessNameOf(businessId) {
  const business = await Business.findById(businessId).select('name');
  return business ? business.name : undefined;
}

async function registerBusiness(req, res, next) {
  try {
    const { businessName, businessEmail, ownerName, ownerEmail, password } = req.body;

    if (!businessName || !businessEmail || !ownerName || !ownerEmail || !password) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const weak = checkPassword(password, { email: String(ownerEmail), name: String(ownerName) });
    if (weak) return res.status(400).json({ message: weak });

    const existingBusiness = await Business.findOne({ email: businessEmail.toLowerCase() });
    if (existingBusiness) {
      return res.status(409).json({ message: 'A business with that email already exists' });
    }

    const business = await Business.create({ name: businessName, email: businessEmail });

    const passwordHash = await bcrypt.hash(password, 10);
    const owner = await User.create({
      business: business._id,
      name: ownerName,
      email: ownerEmail,
      passwordHash,
      role: 'owner',
    });

    // Welcome email. Never waited for and never able to stop the signup, even if sending fails.
    if (mailer.isConfigured()) {
      const link = `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/dashboard`;
      mailer
        .sendEmail({ to: owner.email, ...mailer.welcomeEmail({ name: owner.name, businessName: business.name, trialDays: TRIAL_DAYS, link }) })
        .catch((err) => console.error('Welcome email failed:', err.message));
    }

    const token = signToken(owner);
    res.status(201).json({ token, user: sanitizeUser(owner, business.name), business });
  } catch (err) {
    next(err);
  }
}

function cleanTitle(value) {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (title.length > 40) throw httpError(400, 'The role name can be at most 40 characters');
  return title;
}

// Owner only: creates a staff account. The staff signs in with this email and password.
async function inviteStaff(req, res, next) {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const jobTitle = cleanTitle(req.body.jobTitle);
    const permissions =
      req.body.permissions === undefined
        ? [...DEFAULT_STAFF_PERMISSIONS]
        : cleanPermissions(req.body.permissions);

    if (!name || !email || !password) throw httpError(400, 'Name, email and password are required');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'Enter a valid email address');
    const weak = checkPassword(password, { email, name });
    if (weak) throw httpError(400, weak);

    const taken = await User.findOne({ email });
    if (taken) throw httpError(409, 'Someone already uses that email address. Use a different one.');

    await assertCanAddStaff(req.businessId);

    const passwordHash = await bcrypt.hash(password, 10);
    const staff = await User.create({
      business: req.businessId,
      name,
      email,
      passwordHash,
      role: 'staff',
      jobTitle,
      permissions,
    });

    logActivity(req, { action: 'staff.invite', summary: `Added staff ${staff.name}`, entityType: 'User', entityId: staff._id });
    res.status(201).json({ user: sanitizeUser(staff) });
  } catch (err) {
    next(err);
  }
}

// Owner only: every staff in this business, including deactivated ones.
async function listStaff(req, res, next) {
  try {
    const staff = await User.find({ business: req.businessId, role: 'staff' }).sort({ name: 1 });
    res.json({ staff: staff.map((u) => sanitizeUser(u)) });
  } catch (err) {
    next(err);
  }
}

// Owner only: rename a staff, change their role name and permissions, reset their password,
// or switch their account off / on.
async function updateStaff(req, res, next) {
  try {
    // only staffs of this business, never the owner
    const staff = await User.findOne({ _id: req.params.id, business: req.businessId, role: 'staff' });
    if (!staff) throw httpError(404, 'Staff not found');

    const { name, password, isActive, jobTitle, permissions } = req.body;

    if (jobTitle !== undefined) staff.jobTitle = cleanTitle(jobTitle);
    if (permissions !== undefined) staff.permissions = cleanPermissions(permissions);

    if (name !== undefined) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) throw httpError(400, 'Name cannot be empty');
      staff.name = trimmed;
    }

    if (password !== undefined && password !== '') {
      const weak = checkPassword(password, { email: staff.email, name: staff.name });
      if (weak) throw httpError(400, weak);
      staff.passwordHash = await bcrypt.hash(password, 10);
      // logins from before the new password stop working, and a lock from too many wrong guesses is lifted
      staff.passwordChangedAt = new Date();
      loginGuard.clearEmail(staff.email);
    }

    if (isActive !== undefined) {
      // switching a staff back on takes up a staff place again
      if (Boolean(isActive) && !staff.isActive) await assertCanAddStaff(req.businessId);
      staff.isActive = Boolean(isActive);
    }

    await staff.save();
    const changes = [];
    if (permissions !== undefined) changes.push('permissions');
    if (jobTitle !== undefined) changes.push('role');
    if (name !== undefined) changes.push('name');
    if (password !== undefined && password !== '') changes.push('password');
    if (isActive !== undefined) changes.push(staff.isActive ? 'account switched on' : 'account switched off');
    if (changes.length > 0) {
      logActivity(req, {
        action: 'staff.update',
        summary: `Changed ${staff.name}: ${changes.join(', ')}`,
        entityType: 'User',
        entityId: staff._id,
      });
    }
    res.json({ user: sanitizeUser(staff) });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const ip = clientIp(req);

    // too many wrong passwords lately: refuse before doing any work (even a correct password waits)
    const waitMs = loginGuard.check(cleanEmail, ip);
    if (waitMs > 0) {
      res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
      return res.status(429).json({ message: tooManyAttempts(waitMs) });
    }

    const user = await User.findOne({ email: cleanEmail });
    // an email with no account is counted like a wrong password, so the limits reveal nothing
    const match = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!match) {
      const result = loginGuard.fail(cleanEmail, ip);
      if (result.lockedNow && user && user.isActive) {
        logActivity(
          { user, businessId: user.business },
          {
            action: 'staff.login_locked',
            summary: `Too many wrong passwords were tried on ${user.name}'s account. Logging in is paused for a few minutes.`,
            entityType: 'User',
            entityId: user._id,
            meta: { ip, limit: result.lockedNow },
          }
        );
      }
      if (result.retryAfterMs > 0) res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    loginGuard.success(cleanEmail, ip);

    // checked after the password so the message does not reveal which emails exist
    if (!user.isActive) {
      return res.status(403).json({ message: 'This account has been switched off. Ask the administrator of the business.' });
    }

    const token = signToken(user);
    res.json({ token, user: sanitizeUser(user, await businessNameOf(user.business)) });
  } catch (err) {
    next(err);
  }
}

async function getMe(req, res, next) {
  try {
    res.json({ user: sanitizeUser(req.user, await businessNameOf(req.user.business)) });
  } catch (err) {
    next(err);
  }
}

// Everyone: change your own name and phone number. The owner can also rename the business.
// (Email, role and permissions are not changed here: the email is the sign-in, the rest is the owner's call.)
async function updateMe(req, res, next) {
  try {
    const { name, phone, businessName } = req.body;
    const me = req.user;

    if (name !== undefined) {
      const trimmed = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
      if (!trimmed) throw httpError(400, 'Name cannot be empty');
      if (trimmed.length > 60) throw httpError(400, 'The name can be at most 60 characters');
      me.name = trimmed;
    }

    if (phone !== undefined) {
      const trimmed = typeof phone === 'string' ? phone.trim() : '';
      if (trimmed.length > 30) throw httpError(400, 'The phone number is too long');
      me.phone = trimmed;
    }

    if (businessName !== undefined) {
      if (me.role !== 'owner') throw httpError(403, 'Only the administrator can change the business name');
      const trimmed = typeof businessName === 'string' ? businessName.replace(/\s+/g, ' ').trim() : '';
      if (!trimmed) throw httpError(400, 'The business name cannot be empty');
      if (trimmed.length > 80) throw httpError(400, 'The business name can be at most 80 characters');
      await Business.findByIdAndUpdate(me.business, { name: trimmed });
    }

    await me.save();
    res.json({ user: sanitizeUser(me, await businessNameOf(me.business)) });
  } catch (err) {
    next(err);
  }
}

// Everyone: change your own password. The current password is asked for so a borrowed, signed-in phone
// cannot be used to lock the real person out.
async function changePassword(req, res, next) {
  try {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

    if (!currentPassword || !newPassword) throw httpError(400, 'Enter your current password and a new one');
    const weak = checkPassword(newPassword, { label: 'new password', email: req.user.email, name: req.user.name });
    if (weak) throw httpError(400, weak);

    // only a few tries at the current password: a stolen or borrowed session must not be able to guess it
    const waitMs = changePasswordGuard.check(req.user._id);
    if (waitMs > 0) {
      res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
      return res.status(429).json({ message: tooManyAttempts(waitMs) });
    }

    const match = await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!match) {
      changePasswordGuard.fail(req.user._id);
      throw httpError(400, 'Your current password is not correct');
    }
    changePasswordGuard.success(req.user._id);
    if (currentPassword === newPassword) throw httpError(400, 'Choose a password different from the current one');

    req.user.passwordHash = await bcrypt.hash(newPassword, 10);
    // every other signed-in phone or browser is logged out; this one gets a fresh token and carries on
    req.user.passwordChangedAt = new Date();
    await req.user.save();
    loginGuard.clearEmail(req.user.email);
    logActivity(req, { action: 'staff.password_changed', summary: `${req.user.name} changed their password.`, entityType: 'User', entityId: req.user._id });
    res.json({ message: 'Password changed', token: signToken(req.user) });
  } catch (err) {
    next(err);
  }
}

// Profile pictures: "photo" (the round one) and "cover" (the wide one behind the top of the profile page).
// Both work the same way. The upload to Cloudinary has already happened by the time a handler runs.
//   - the administrator can set, replace or remove their own and any staff's
//   - a staff can add their own once; after that only the administrator can change or remove it
const PICTURE_NAMES = { photo: 'photo', cover: 'cover picture' };

function hasPicture(person, field) {
  return Boolean(person[field] && person[field].url);
}

function lockedMessage(field) {
  return `Only the administrator can change your ${PICTURE_NAMES[field]}.`;
}

// Runs BEFORE the upload, so a staff who is locked out never sends a file to Cloudinary at all.
function lockedForStaff(field) {
  return (req, res, next) => {
    if (req.user.role !== 'owner' && hasPicture(req.user, field)) {
      return res.status(403).json({ message: lockedMessage(field) });
    }
    next();
  };
}

// Saves an already-uploaded picture (req.file) on `person` and deletes the one it replaces.
async function savePicture(person, field, file) {
  const oldPublicId = person[field] && person[field].publicId;
  person[field] = { url: file.path, publicId: file.filename };
  try {
    await person.save();
  } catch (err) {
    await cloudinary.uploader.destroy(file.filename).catch(() => {}); // do not keep a picture nobody points at
    throw err;
  }
  if (oldPublicId) await cloudinary.uploader.destroy(oldPublicId).catch(() => {});
}

async function clearPicture(person, field) {
  const oldPublicId = person[field] && person[field].publicId;
  person[field] = undefined;
  await person.save();
  if (oldPublicId) await cloudinary.uploader.destroy(oldPublicId).catch(() => {});
}

// Everyone: set your own picture (a staff only while they have none).
function uploadMine(field) {
  return async (req, res, next) => {
    try {
      // checked again after the upload: two quick requests could both have passed the check before it
      if (req.user.role !== 'owner' && hasPicture(req.user, field)) {
        if (req.file) await cloudinary.uploader.destroy(req.file.filename).catch(() => {});
        throw httpError(403, lockedMessage(field));
      }
      if (!req.file) throw httpError(400, 'Choose a picture to upload');
      await savePicture(req.user, field, req.file);
      res.status(201).json({ user: sanitizeUser(req.user, await businessNameOf(req.user.business)) });
    } catch (err) {
      next(err);
    }
  };
}

// Only the administrator: removing your own picture (a staff cannot, the administrator does it for them).
function deleteMine(field) {
  return async (req, res, next) => {
    try {
      if (req.user.role !== 'owner') throw httpError(403, lockedMessage(field));
      await clearPicture(req.user, field);
      res.json({ user: sanitizeUser(req.user, await businessNameOf(req.user.business)) });
    } catch (err) {
      next(err);
    }
  };
}

// Administrator only: the staff of this business, never the administrator or anyone from another business.
async function findMyStaff(req) {
  const staff = await User.findOne({ _id: req.params.id, business: req.businessId, role: 'staff' });
  if (!staff) throw httpError(404, 'Staff not found');
  return staff;
}

// Administrator only: set (or replace) a staff's picture.
function uploadForStaff(field) {
  return async (req, res, next) => {
    try {
      // checked first, so a picture for someone who is not yours to change is deleted again, not kept
      let staff;
      try {
        staff = await findMyStaff(req);
      } catch (err) {
        if (req.file) await cloudinary.uploader.destroy(req.file.filename).catch(() => {});
        throw err;
      }
      if (!req.file) throw httpError(400, 'Choose a picture to upload');
      await savePicture(staff, field, req.file);
      res.status(201).json({ user: sanitizeUser(staff) });
    } catch (err) {
      next(err);
    }
  };
}

// Administrator only: remove a staff's picture.
function deleteForStaff(field) {
  return async (req, res, next) => {
    try {
      const staff = await findMyStaff(req);
      await clearPicture(staff, field);
      res.json({ user: sanitizeUser(staff) });
    } catch (err) {
      next(err);
    }
  };
}

const uploadMyPhoto = uploadMine('photo');
const deleteMyPhoto = deleteMine('photo');
const uploadMyCover = uploadMine('cover');
const deleteMyCover = deleteMine('cover');
const uploadStaffPhoto = uploadForStaff('photo');
const deleteStaffPhoto = deleteForStaff('photo');
const uploadStaffCover = uploadForStaff('cover');
const deleteStaffCover = deleteForStaff('cover');

// Everyone in the business (owner + staff). Used for the "Sold by" suggestions on a sale.
// Only the owner needs it, so staffs get an empty list instead of their colleagues' details.
async function listTeam(req, res, next) {
  try {
    if (req.user.role !== 'owner') return res.json({ team: [sanitizeUser(req.user)] });
    const users = await User.find({ business: req.businessId, isActive: true }).sort({ name: 1 });
    res.json({ team: users.map((u) => sanitizeUser(u)) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
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
};
