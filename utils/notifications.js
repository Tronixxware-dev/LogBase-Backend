// Alerts for the bell in the top bar. notify...() never throws and nothing waits for it: if an alert cannot be saved,
// the sale, return or payment that caused it must still go through.

const Notification = require('../models/Notification');
const User = require('../models/User');
const mailer = require('./mailer');

// The kinds of alert a person can switch on or off. `owner: true` = only the administrator is ever sent these.
const NOTIFICATION_TYPES = [
  { key: 'approvals', label: 'Approval requests and answers', hint: 'The administrator: someone asks for approval. Staff: their request was approved or declined.', owner: false },
  { key: 'lowStock', label: 'Low stock', hint: 'A product runs out or drops to its low-stock level', owner: true },
  { key: 'creditSale', label: 'Sales on credit', hint: 'A staff records a sale the customer has not fully paid', owner: true },
  { key: 'customerPayment', label: 'Customer payments', hint: 'A staff records a payment from a customer', owner: true },
  { key: 'returns', label: 'Returns', hint: 'A staff takes an item back from a customer', owner: true },
  { key: 'stockAdjustments', label: 'Stock changes', hint: 'A staff records damaged, lost or found stock, or a stock count', owner: true },
  { key: 'transfers', label: 'Stock transfers', hint: 'Stock is sent to another store and waits to be received', owner: true },
  { key: 'jobReady', label: 'Jobs ready', hint: 'A repair job or laundry order is marked ready for pick-up', owner: true },
];
const TYPE_KEYS = NOTIFICATION_TYPES.map((t) => t.key);

function typesFor(user) {
  return NOTIFICATION_TYPES.filter((t) => user && (user.role === 'owner' || !t.owner));
}

// What a person has switched on: every kind of alert unless they turned it off. `email` is off unless they turned it on.
function prefsOf(user) {
  const saved = (user && user.notificationPrefs) || {};
  const out = { email: saved.email === true };
  for (const key of TYPE_KEYS) out[key] = saved[key] !== false;
  return out;
}

function wants(user, type) {
  return prefsOf(user)[type] === true;
}

// The emails go only for the two kinds that need quick attention, and only to people who asked for email.
const EMAIL_TYPES = ['approvals', 'lowStock'];

async function emailAlert(user, { title, body, link }) {
  try {
    if (!mailer.isConfigured() || !user.email) return;
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const href = link ? `${base}${link}` : base;
    const e = mailer.escapeHtml;
    await mailer.sendEmail({
      to: user.email,
      subject: title,
      text: `${title}\n${body || ''}\n\n${href}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827"><h2 style="font-size:17px;margin:0 0 8px">${e(title)}</h2><p style="margin:0 0 14px">${e(body || '')}</p><p><a href="${e(href)}" style="color:#0d9488;font-weight:bold">Open LogBase</a></p></div>`,
    });
  } catch (err) {
    console.error('Alert email failed:', err.message);
  }
}

// Sends one alert to the given users (documents). People who switched that kind off are skipped.
async function notifyUsers(businessId, users, { type, title, body, link }) {
  try {
    if (!businessId || !type || !title) return;
    const chosen = (users || []).filter((u) => u && wants(u, type));
    if (chosen.length === 0) return;
    await Notification.insertMany(
      chosen.map((u) => ({ business: businessId, user: u._id, type, title: String(title).slice(0, 140), body: body ? String(body).slice(0, 300) : undefined, link }))
    );
    if (EMAIL_TYPES.includes(type)) {
      for (const u of chosen) if (prefsOf(u).email) emailAlert(u, { title, body, link });
    }
  } catch (err) {
    console.error('Notification failed:', err.message);
  }
}

// Alert the administrator(s) of a business, except the person who did the thing themselves.
function notifyOwners(businessId, payload, { exceptUserId } = {}) {
  return (async () => {
    try {
      const owners = await User.find({ business: businessId, role: 'owner', isActive: true });
      await notifyUsers(
        businessId,
        owners.filter((o) => !exceptUserId || String(o._id) !== String(exceptUserId)),
        payload
      );
    } catch (err) {
      console.error('Notification failed:', err.message);
    }
  })();
}

function notifyUserId(businessId, userId, payload) {
  return (async () => {
    try {
      const user = await User.findOne({ _id: userId, business: businessId, isActive: true });
      if (user) await notifyUsers(businessId, [user], payload);
    } catch (err) {
      console.error('Notification failed:', err.message);
    }
  })();
}

// After stock went down: tells the administrator when a product ran out, or fell to its low-stock level (only on the way down, never again while it stays low).
// `before` and `after` are the product's total count. `level` is the product's own low-stock level.
function checkLowStock(businessId, { productId, name, before, after, level }) {
  try {
    const lvl = Number(level) || 0;
    const ranOut = before > 0 && after <= 0;
    const fellLow = lvl > 0 && before > lvl && after <= lvl && after > 0;
    if (!ranOut && !fellLow) return Promise.resolve();
    return notifyOwners(businessId, {
      type: 'lowStock',
      title: ranOut ? `${name} is out of stock` : `${name} is running low`,
      body: ranOut ? 'None left. Restock it to keep selling.' : `Only ${after} left (low-stock level ${lvl}).`,
      link: productId ? `/dashboard/products/${productId}` : '/dashboard/inventory',
    });
  } catch (err) {
    return Promise.resolve();
  }
}

module.exports = { NOTIFICATION_TYPES, TYPE_KEYS, typesFor, prefsOf, wants, notifyUsers, notifyOwners, notifyUserId, checkLowStock };
