const Business = require('../models/Business');
const { cloudinary } = require('../config/cloudinary');
const { httpError } = require('../utils/httpError');
const { logActivity } = require('../utils/audit');
const { settingsOf, cleanOrganization, cleanPreferences, cleanPolicies } = require('../utils/settings');

const PUBLIC_FIELDS = 'name email phone address website taxId logoUrl businessType receipt preferences approvalPolicies';

async function load(req) {
  const business = await Business.findById(req.businessId).select(PUBLIC_FIELDS);
  if (!business) throw httpError(404, 'Business not found');
  return business;
}

// GET /api/settings: everyone in the business reads it (receipts and slips need the identity); only the administrator changes it.
async function getSettings(req, res, next) {
  try {
    res.json({ settings: settingsOf(await load(req)) });
  } catch (err) {
    next(err);
  }
}

// What changed, in words, for the activity log
function describe(set, labels) {
  const keys = Object.keys(set).map((k) => labels[k] || labels[k.split('.')[0]]).filter(Boolean);
  return [...new Set(keys)].join(', ');
}

async function save(req, res, next, { clean, action, what, labels }) {
  try {
    const set = clean(req.body || {});
    const updated = await Business.findByIdAndUpdate(req.businessId, { $set: set }, { new: true, runValidators: true });
    if (!updated) throw httpError(404, 'Business not found');
    logActivity(req, { action, summary: `Changed the ${what}: ${describe(set, labels)}`, entityType: 'Business', entityId: req.businessId });
    res.json({ settings: settingsOf(updated) });
  } catch (err) {
    next(err);
  }
}

const ORG_LABELS = {
  name: 'business name',
  phone: 'phone',
  address: 'address',
  website: 'website',
  taxId: 'tax number',
  receipt: 'receipt choices',
};
const PREF_LABELS = { 'preferences.defaultPaymentMethod': 'usual payment method', 'preferences.defaultReorderLevel': 'low-stock level', 'preferences.expressPercent': 'express charge' };
const POLICY_LABELS = { returns: 'returns rule', stockAdjustments: 'stock changes rule', discounts: 'discounts rule', creditSales: 'credit sales rule' };

const updateOrganization = (req, res, next) => save(req, res, next, { clean: cleanOrganization, action: 'settings.organization', what: 'business details', labels: ORG_LABELS });
const updatePreferences = (req, res, next) => save(req, res, next, { clean: cleanPreferences, action: 'settings.preferences', what: 'preferences', labels: PREF_LABELS });
const updatePolicies = (req, res, next) => save(req, res, next, { clean: cleanPolicies, action: 'settings.policies', what: 'approval policies', labels: POLICY_LABELS });

// POST /api/settings/logo (multipart, field "logo")
async function uploadLogo(req, res, next) {
  const file = req.file;
  try {
    if (!file) throw httpError(400, 'Choose a picture');
    const business = await load(req);
    const old = business.logoPublicId;
    business.logoUrl = file.path;
    business.logoPublicId = file.filename;
    await business.save();
    if (old) await cloudinary.uploader.destroy(old).catch(() => {});
    logActivity(req, { action: 'settings.logo', summary: 'Changed the business logo', entityType: 'Business', entityId: req.businessId });
    res.json({ settings: settingsOf(business) });
  } catch (err) {
    if (file && file.filename) await cloudinary.uploader.destroy(file.filename).catch(() => {});
    next(err);
  }
}

// DELETE /api/settings/logo
async function deleteLogo(req, res, next) {
  try {
    const business = await load(req);
    const old = business.logoPublicId;
    business.logoUrl = null;
    business.logoPublicId = undefined;
    await business.save();
    if (old) await cloudinary.uploader.destroy(old).catch(() => {});
    logActivity(req, { action: 'settings.logo', summary: 'Removed the business logo', entityType: 'Business', entityId: req.businessId });
    res.json({ settings: settingsOf(business) });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateOrganization, updatePreferences, updatePolicies, uploadLogo, deleteLogo };
