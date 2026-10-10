const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Business = require('../models/Business');
const { isSuperAdminEmail } = require('../utils/superAdmin');
const { can } = require('../utils/permissions');

async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Not authenticated' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.userId);
    if (!user || !user.isActive) return res.status(401).json({ message: 'Not authenticated' });
    // a login from before the password was reset by email is no longer good (iat is in whole seconds)
    if (user.passwordChangedAt && payload.iat < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    // a business the LogBase super admin has suspended is shut out of everything (the owner of LogBase is never locked out)
    const business = await Business.findById(user.business).select('isActive suspendedReason');
    if (business && business.isActive === false && !isSuperAdminEmail(user.email)) {
      return res.status(403).json({
        message: business.suspendedReason
          ? `This business has been suspended: ${business.suspendedReason}`
          : 'This business has been suspended. Contact LogBase support.',
        code: 'BUSINESS_SUSPENDED',
      });
    }

    req.user = user;
    req.businessId = user.business;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    next();
  };
}

// Lets a request through when the user has AT LEAST ONE of the listed permissions.
// The owner always passes. Staffs have the permissions the owner ticked for them.
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!can(req.user, ...permissions)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    next();
  };
}

// Only the LogBase super admin(s): the people whose email is listed in SUPER_ADMIN_EMAILS on the server.
// This is checked on the server for every admin request, so hiding the admin pages in the browser is not what protects them.
function requireSuperAdmin(req, res, next) {
  if (!req.user || !isSuperAdminEmail(req.user.email)) {
    return res.status(403).json({ message: 'Not authorized' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requirePermission, requireSuperAdmin };