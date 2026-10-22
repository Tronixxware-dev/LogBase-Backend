// The activity log. logActivity() never throws and is never waited for: if the log cannot be written,
// the thing the person was doing (a sale, a return...) must still go through.

const AuditLog = require('../models/AuditLog');

// Groups shown as filters on the Activity page.
const ACTIVITY_CATEGORIES = [
  { key: 'sale', label: 'Sales' },
  { key: 'return', label: 'Returns' },
  { key: 'stock', label: 'Stock adjustments' },
  { key: 'product', label: 'Products' },
  { key: 'purchase', label: 'Purchases' },
  { key: 'customer', label: 'Customers' },
  { key: 'payment', label: 'Payments' },
  { key: 'expense', label: 'Expenses' },
  { key: 'swap', label: 'Item swaps' },
  { key: 'repair', label: 'Repairs' },
  { key: 'laundry', label: 'Laundry' },
  { key: 'transfer', label: 'Stock transfers' },
  { key: 'store', label: 'Stores' },
  { key: 'staff', label: 'Staff and roles' },
  { key: 'approval', label: 'Approvals' },
  { key: 'settings', label: 'Settings' },
];

function logActivity(req, { action, summary, entityType, entityId, meta }) {
  try {
    if (!req || !req.user || !req.businessId || !action || !summary) return Promise.resolve();
    // something the administrator approved is recorded under the staff who asked, with the approver's name
    if (req.approvedBy) {
      summary = `${summary} (approved by ${req.approvedBy.name})`;
      meta = { ...(meta || {}), approvedBy: req.approvedBy.name };
    }
    // the store the person is working in: the id the app sends with every call (none = the main store)
    const header = req.headers && req.headers['x-shop-id'];
    const shop = typeof header === 'string' && /^[a-f0-9]{24}$/i.test(header) ? header : undefined;
    return Promise.resolve(
      AuditLog.create({
        shop,
        business: req.businessId,
        user: req.user._id,
        userName: req.user.name,
        userRole: req.user.role === 'owner' ? 'Administrator' : 'Staff',
        action,
        summary: String(summary).slice(0, 300),
        entityType,
        entityId,
        meta,
      })
    ).catch((err) => {
      console.error('Activity log failed:', err.message);
    });
  } catch (err) {
    console.error('Activity log failed:', err.message);
    return Promise.resolve();
  }
}

module.exports = { logActivity, ACTIVITY_CATEGORIES };
