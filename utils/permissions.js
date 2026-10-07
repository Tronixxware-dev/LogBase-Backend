// What a staff may do is decided by a list of permissions the owner ticks for each staff.
// The owner always has every permission. Keep this list in step with logbase-frontend/lib/permissions.js.

const { httpError } = require('./httpError');

const PERMISSIONS = [
  { key: 'recordSales', label: 'Record sales', hint: 'Sell items and see the sales they recorded themselves' },
  { key: 'viewAllSales', label: 'See all sales', hint: 'The full sales list, including sales recorded by others' },
  { key: 'viewCustomers', label: 'See customers', hint: 'The Customers page (name, phone, address)' },
  { key: 'addCustomers', label: 'Add customers', hint: 'Save new customers' },
  { key: 'manageCustomers', label: 'Manage customers', hint: 'See what customers owe and their history, record their payments' },
  { key: 'viewStock', label: 'See stock', hint: 'The Products page, without cost prices' },
  { key: 'manageProducts', label: 'Manage products', hint: 'Add, edit and delete products and categories (never sees cost prices)' },
  { key: 'managePurchases', label: 'Purchases', hint: 'Record goods received and see purchases (never sees costs or suppliers)' },
  { key: 'processReturns', label: 'Process returns', hint: 'Take back sold items and refund customers' },
  { key: 'adjustStock', label: 'Adjust stock', hint: 'Record damaged, lost or found items and stock counts' },
  { key: 'viewInsights', label: 'See insights', hint: 'The Overview with revenue and activity (never sees costs or profit)' },
];

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Customers used to be called buyers. Staffs and roles saved before the rename still hold the old names,
// so they are translated here (the one-time migration script rewrites them in the database too).
const LEGACY_PERMISSIONS = {
  viewBuyers: 'viewCustomers',
  addBuyers: 'addCustomers',
  manageBuyers: 'manageCustomers',
};

// A list of permission names with any old names swapped for the new ones (no duplicates).
function upgradePermissions(list) {
  if (!Array.isArray(list)) return list;
  return [...new Set(list.map((p) => LEGACY_PERMISSIONS[p] || p))];
}

// What a new staff gets unless the owner chooses otherwise (also used for staffs created before permissions existed).
const DEFAULT_STAFF_PERMISSIONS = ['recordSales', 'viewCustomers', 'addCustomers', 'viewStock'];

function isOwnerUser(user) {
  return Boolean(user) && user.role === 'owner';
}

// The permissions a user effectively has.
function permissionsOf(user) {
  if (isOwnerUser(user)) return [...PERMISSION_KEYS];
  if (user && Array.isArray(user.permissions)) {
    return upgradePermissions(user.permissions).filter((p) => PERMISSION_KEYS.includes(p));
  }
  return [...DEFAULT_STAFF_PERMISSIONS];
}

// true when the user has at least one of the listed permissions
function can(user, ...wanted) {
  if (isOwnerUser(user)) return true;
  const have = permissionsOf(user);
  return wanted.some((p) => have.includes(p));
}

// Only the owner sees what things cost the business (cost prices, purchase costs, delivery fees, profit).
// No permission a staff can be given changes this.
function canSeeCosts(user) {
  return isOwnerUser(user);
}

// Checks a list sent by the owner. Unknown names are an error (a typo should not silently grant nothing).
function cleanPermissions(input) {
  if (!Array.isArray(input)) throw httpError(400, 'permissions must be a list');
  input = upgradePermissions(input);
  const unknown = input.filter((p) => !PERMISSION_KEYS.includes(p));
  if (unknown.length > 0) throw httpError(400, `Unknown permission: ${unknown.join(', ')}`);
  return PERMISSION_KEYS.filter((p) => input.includes(p)); // in a fixed order, no duplicates
}

module.exports = {
  PERMISSIONS,
  PERMISSION_KEYS,
  DEFAULT_STAFF_PERMISSIONS,
  permissionsOf,
  can,
  canSeeCosts,
  cleanPermissions,
  upgradePermissions,
};
