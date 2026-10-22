const Notification = require('../models/Notification');
const Approval = require('../models/Approval');
const User = require('../models/User');
const { httpError } = require('../utils/httpError');
const { typesFor, prefsOf, TYPE_KEYS } = require('../utils/notifications');

// Alerts belong to one person: every query is for the signed-in user inside their business.
const mine = (req) => ({ business: req.businessId, user: req.user._id });

// GET /api/notifications?unread=true&limit=30
async function listNotifications(req, res, next) {
  try {
    const filter = mine(req);
    if (req.query.unread === 'true') filter.readAt = { $exists: false };
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    // requests waiting for an answer: all of them for the administrator, a staff's own for a staff (shown as a badge in the menu)
    const waiting = { business: req.businessId, status: { $in: ['pending', 'processing'] }, ...(req.user.role === 'owner' ? {} : { requestedBy: req.user._id }) };
    const [items, unread, pendingApprovals] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit),
      Notification.countDocuments({ ...mine(req), readAt: { $exists: false } }),
      Approval.countDocuments(waiting),
    ]);
    res.json({ notifications: items, unread, pendingApprovals });
  } catch (err) {
    next(err);
  }
}

// POST /api/notifications/read-all
async function readAll(req, res, next) {
  try {
    await Notification.updateMany({ ...mine(req), readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    res.json({ unread: 0 });
  } catch (err) {
    next(err);
  }
}

// POST /api/notifications/:id/read
async function readOne(req, res, next) {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw httpError(404, 'Alert not found');
    const found = await Notification.findOneAndUpdate({ _id: req.params.id, ...mine(req), readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    const unread = await Notification.countDocuments({ ...mine(req), readAt: { $exists: false } });
    res.json({ unread, found: Boolean(found) });
  } catch (err) {
    next(err);
  }
}

function prefsView(user) {
  return { types: typesFor(user).map(({ key, label, hint }) => ({ key, label, hint })), prefs: prefsOf(user) };
}

// GET /api/notifications/preferences
async function getPreferences(req, res, next) {
  try {
    res.json(prefsView(req.user));
  } catch (err) {
    next(err);
  }
}

// PUT /api/notifications/preferences  body: { lowStock: false, email: true, ... }
async function updatePreferences(req, res, next) {
  try {
    const body = req.body || {};
    const allowed = new Set([...typesFor(req.user).map((t) => t.key), 'email']);
    const next_ = { ...(req.user.notificationPrefs || {}) };
    let changed = false;
    for (const key of [...TYPE_KEYS, 'email']) {
      if (body[key] === undefined) continue;
      if (!allowed.has(key)) throw httpError(400, 'That alert is not available to you');
      if (typeof body[key] !== 'boolean') throw httpError(400, 'Each alert must be on or off');
      next_[key] = body[key];
      changed = true;
    }
    if (!changed) throw httpError(400, 'Nothing to change');
    const saved = await User.findByIdAndUpdate(req.user._id, { $set: { notificationPrefs: next_ } }, { new: true });
    res.json(prefsView(saved));
  } catch (err) {
    next(err);
  }
}

module.exports = { listNotifications, readAll, readOne, getPreferences, updatePreferences };
