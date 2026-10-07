const jwt = require('jsonwebtoken');
const User = require('../models/User');
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

module.exports = { requireAuth, requireRole, requirePermission };