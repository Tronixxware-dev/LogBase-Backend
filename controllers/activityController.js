const AuditLog = require('../models/AuditLog');
const { ACTIVITY_CATEGORIES } = require('../utils/audit');

const PAGE_SIZE = 50;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/activity?category=sale&user=<id>&search=ada&before=<iso date>&limit=50
// Administrator only (see the route). Newest first. `before` is the createdAt of the last entry already
// loaded; the answer's `nextBefore` is what to send to get the following page (null when there is no more).
async function listActivity(req, res, next) {
  try {
    const filter = { business: req.businessId };

    const category = typeof req.query.category === 'string' ? req.query.category : '';
    if (category && ACTIVITY_CATEGORIES.some((c) => c.key === category)) {
      filter.action = { $regex: `^${escapeRegex(category)}\\.` };
    }
    if (req.query.user) filter.user = String(req.query.user);

    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
    if (search) filter.summary = { $regex: escapeRegex(search), $options: 'i' };

    if (req.query.before) {
      const before = new Date(String(req.query.before));
      if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PAGE_SIZE, 1), 100);
    const rows = await AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    const items = rows.slice(0, limit);
    const nextBefore = rows.length > limit ? items[items.length - 1].createdAt : null;
    res.json({ items, nextBefore, categories: ACTIVITY_CATEGORIES });
  } catch (err) {
    next(err);
  }
}

module.exports = { listActivity };
