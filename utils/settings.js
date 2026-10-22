// The business settings: what the administrator can set on the Settings pages, with their defaults and limits.
// Everything the owner types is checked here, so a wrong value is refused with a clear message instead of being saved.

const { httpError } = require('./httpError');

const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'other'];
const MAX_EXPRESS_PERCENT = 300;

const POLICY_DEFAULTS = {
  returns: { enabled: false, minAmount: 0 },
  stockAdjustments: { enabled: false, minUnits: 0 },
  discounts: { enabled: false, maxPercent: 0 },
  creditSales: { enabled: false, minAmount: 0 },
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value) {
  return typeof value === 'string' ? value.replace(/[ \t]+/g, ' ').trim() : '';
}

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true';
}

// The identity and receipt choices, with defaults filled in for businesses that never set them.
function organizationOf(business) {
  const b = business || {};
  const r = b.receipt || {};
  return {
    name: b.name || '',
    email: b.email || '',
    phone: b.phone || '',
    address: b.address || '',
    website: b.website || '',
    taxId: b.taxId || '',
    logoUrl: b.logoUrl || '',
    businessType: b.businessType,
    receipt: {
      showLogo: r.showLogo !== false,
      showAddress: r.showAddress !== false,
      showPhone: r.showPhone !== false,
      showSeller: r.showSeller !== false,
      footer: r.footer || '',
      closing: r.closing || '',
    },
  };
}

function preferencesOf(business) {
  const p = (business && business.preferences) || {};
  return {
    defaultPaymentMethod: PAYMENT_METHODS.includes(p.defaultPaymentMethod) ? p.defaultPaymentMethod : 'cash',
    defaultReorderLevel: Math.max(0, Math.floor(num(p.defaultReorderLevel, 0))),
    expressPercent: p.expressPercent === undefined || p.expressPercent === null ? 50 : Math.min(Math.max(num(p.expressPercent, 50), 0), MAX_EXPRESS_PERCENT),
  };
}

function policiesOf(business) {
  const p = (business && business.approvalPolicies) || {};
  const pick = (key, field) => {
    const d = POLICY_DEFAULTS[key];
    const v = p[key] || {};
    return { enabled: v.enabled === true, [field]: Math.max(0, num(v[field], d[field])) };
  };
  return {
    returns: pick('returns', 'minAmount'),
    stockAdjustments: pick('stockAdjustments', 'minUnits'),
    discounts: pick('discounts', 'maxPercent'),
    creditSales: pick('creditSales', 'minAmount'),
  };
}

// Everything the app needs at sign-in: shown to staff too (receipts and slips need the identity; the policies are read-only for them)
function settingsOf(business) {
  return { organization: organizationOf(business), preferences: preferencesOf(business), approvalPolicies: policiesOf(business) };
}

// ---- checking what the owner sent ----

function limited(value, label, max, { required = false } = {}) {
  const t = text(value);
  if (required && !t) throw httpError(400, `${label} cannot be empty`);
  if (t.length > max) throw httpError(400, `${label} can be at most ${max} characters`);
  return t;
}

// Returns the fields to $set on the business.
function cleanOrganization(body) {
  const set = {};
  if (body.name !== undefined) set.name = limited(body.name, 'The business name', 80, { required: true });
  if (body.phone !== undefined) set.phone = limited(body.phone, 'The phone number', 30);
  if (body.address !== undefined) set.address = limited(body.address, 'The address', 200);
  if (body.website !== undefined) set.website = limited(body.website, 'The website', 120);
  if (body.taxId !== undefined) set.taxId = limited(body.taxId, 'The tax number', 40);
  if (body.receipt !== undefined) {
    const r = body.receipt;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw httpError(400, 'The receipt choices are not valid');
    for (const key of ['showLogo', 'showAddress', 'showPhone', 'showSeller']) {
      if (r[key] !== undefined) set[`receipt.${key}`] = bool(r[key], true);
    }
    if (r.footer !== undefined) set['receipt.footer'] = limited(r.footer, 'The receipt message', 200);
    if (r.closing !== undefined) set['receipt.closing'] = limited(r.closing, 'The closing line', 80);
  }
  if (Object.keys(set).length === 0) throw httpError(400, 'Nothing to change');
  return set;
}

function wholeNumber(value, label, { min = 0, max = 1e9 } = {}) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n) || n < min || n > max) throw httpError(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

function cleanPreferences(body) {
  const set = {};
  if (body.defaultPaymentMethod !== undefined) {
    if (!PAYMENT_METHODS.includes(body.defaultPaymentMethod)) throw httpError(400, 'Choose cash, transfer, card or other');
    set['preferences.defaultPaymentMethod'] = body.defaultPaymentMethod;
  }
  if (body.defaultReorderLevel !== undefined) set['preferences.defaultReorderLevel'] = wholeNumber(body.defaultReorderLevel, 'The low-stock level', { max: 100000 });
  if (body.expressPercent !== undefined) {
    const n = Number(body.expressPercent);
    if (body.expressPercent === '' || body.expressPercent === null || !Number.isFinite(n) || n < 0 || n > MAX_EXPRESS_PERCENT) {
      throw httpError(400, `The express charge must be between 0 and ${MAX_EXPRESS_PERCENT} percent`);
    }
    set['preferences.expressPercent'] = Math.round(n * 100) / 100;
  }
  if (Object.keys(set).length === 0) throw httpError(400, 'Nothing to change');
  return set;
}

function amount(value, label, max = 1e12) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isFinite(n) || n < 0 || n > max) throw httpError(400, `${label} must be 0 or more`);
  return Math.round(n * 100) / 100;
}

function cleanPolicies(body) {
  const set = {};
  const rules = [
    ['returns', 'minAmount', 'The return amount'],
    ['stockAdjustments', 'minUnits', 'The number of units'],
    ['discounts', 'maxPercent', 'The discount percent'],
    ['creditSales', 'minAmount', 'The amount owed'],
  ];
  for (const [key, field, label] of rules) {
    const rule = body[key];
    if (rule === undefined) continue;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw httpError(400, 'The approval rule is not valid');
    if (rule.enabled !== undefined) set[`approvalPolicies.${key}.enabled`] = bool(rule.enabled, false);
    if (rule[field] !== undefined) {
      const n = amount(rule[field], label);
      if (key === 'discounts' && n > 100) throw httpError(400, 'A discount percent cannot be above 100');
      set[`approvalPolicies.${key}.${field}`] = n;
    }
  }
  if (Object.keys(set).length === 0) throw httpError(400, 'Nothing to change');
  return set;
}

// The saved preferences of a business (with defaults) for code that needs them while doing something else
async function loadPreferences(businessId) {
  const Business = require('../models/Business');
  const business = await Business.findById(businessId).select('preferences');
  return preferencesOf(business);
}

module.exports = {
  loadPreferences,
  PAYMENT_METHODS,
  MAX_EXPRESS_PERCENT,
  organizationOf,
  preferencesOf,
  policiesOf,
  settingsOf,
  cleanOrganization,
  cleanPreferences,
  cleanPolicies,
};
