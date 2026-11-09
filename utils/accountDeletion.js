// Deleting an account from inside the app (the stores require it).
//   - A staff's own login is switched off and made anonymous. Sales and records they made stay with the business
//     (they belong to the business, and the name written on them is part of its history).
//   - The owner's deletion removes the whole business: every record, every photo and every login.
//     Only what the law and accounting need is kept: the plan payments (and the referral commissions on them),
//     with the business reduced to an empty shell that carries no name, email, phone or address.
// Everything here can safely be run again if it stops half way.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Business = require('../models/Business');
const User = require('../models/User');
const { cloudinary } = require('../config/cloudinary');

// Collections that keep their rows for the accounting and legal duties named in the privacy policy.
const KEEP = new Set(['BillingPayment', 'ReferralCommission', 'Referral', 'AdminLog', 'Business', 'User']);

// Make sure every model file has been loaded, so none is forgotten when a new one is added later.
function loadModels() {
  const dir = path.join(__dirname, '..', 'models');
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.js')) {
      try {
        require(path.join(dir, file));
      } catch {
        /* a file that only holds schemas can be ignored */
      }
    }
  }
}

// The collections that hold a business's own records (they all have a `business` field).
function businessModels() {
  loadModels();
  return mongoose.modelNames()
    .filter((name) => !KEEP.has(name))
    .map((name) => mongoose.model(name))
    .filter((model) => model.schema.path('business'));
}

// Every Cloudinary picture mentioned anywhere in a record (a field called publicId, or ending in PublicId)
function collectPublicIds(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPublicIds(item, out);
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === 'string' && /publicid$/i.test(key) && inner) out.add(inner);
    else if (inner && typeof inner === 'object') collectPublicIds(inner, out);
  }
}

async function removePictures(ids) {
  const list = Array.from(ids);
  let removed = 0;
  for (let i = 0; i < list.length; i += 100) {
    try {
      await cloudinary.api.delete_resources(list.slice(i, i + 100));
      removed += Math.min(100, list.length - i);
    } catch (err) {
      console.error('Could not remove some pictures from Cloudinary:', err && err.message);
    }
  }
  return removed;
}

function randomEmail(id) {
  return `deleted-${id}-${crypto.randomBytes(4).toString('hex')}@deleted.invalid`;
}

// A staff deleting their own login: switched off and anonymous, their pictures removed.
async function anonymiseUser(user) {
  const ids = new Set();
  collectPublicIds(user.toObject(), ids);
  user.name = 'Former staff';
  user.email = randomEmail(user._id);
  user.passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  user.isActive = false;
  user.phone = undefined;
  user.jobTitle = undefined;
  user.photo = undefined;
  user.cover = undefined;
  user.permissions = [];
  user.notificationPrefs = undefined;
  user.pendingEmail = undefined;
  user.pendingEmailHash = undefined;
  user.resetTokenHash = undefined;
  user.passwordChangedAt = new Date();
  await user.save();
  await removePictures(ids);
}

// The owner deleting the whole business.
async function deleteBusiness(businessId) {
  const ids = new Set();
  const counts = {};

  // 1. pictures: note which ones exist before the records that name them are gone
  const users = await User.find({ business: businessId }).lean();
  for (const u of users) collectPublicIds(u, ids);
  const business = await Business.findById(businessId).lean();
  if (business) collectPublicIds(business, ids);
  const models = businessModels();
  for (const model of models) {
    const cursor = model.find({ business: businessId }).lean().cursor();
    for await (const doc of cursor) collectPublicIds(doc, ids);
  }

  // 2. the records (this also ends any automatic renewal, because the subscription is among them)
  for (const model of models) {
    const result = await model.deleteMany({ business: businessId });
    counts[model.modelName] = result.deletedCount || 0;
  }

  // 3. the logins. A referrer who was this person keeps their earnings record, only the link to the login goes.
  const userIds = users.map((u) => u._id);
  try {
    const Referrer = mongoose.model('Referrer');
    await Referrer.updateMany({ user: { $in: userIds } }, { $unset: { user: 1 } });
  } catch {
    /* no referrer records */
  }
  await User.deleteMany({ business: businessId });

  // 4. the business itself becomes an empty shell so the kept payment records still point somewhere
  await Business.updateOne(
    { _id: businessId },
    {
      $set: {
        name: 'Deleted business',
        email: randomEmail(businessId),
        isActive: false,
        suspendedReason: 'Account deleted by the owner',
        suspendedAt: new Date(),
        deletedAt: new Date(),
      },
      $unset: { phone: 1, address: 1, logoUrl: 1, logoPublicId: 1, website: 1, taxId: 1, receipt: 1, preferences: 1, approvalPolicies: 1 },
    }
  );

  // 5. pictures last: if Cloudinary is slow the account is already gone
  counts.pictures = await removePictures(ids);
  counts.users = users.length;
  return counts;
}

module.exports = { anonymiseUser, deleteBusiness };
