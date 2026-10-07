const Category = require('../models/Category');
const { httpError } = require('./httpError');

// Finds the category with this name for the business, creating it if it does not exist yet.
// Returns { category, created }.
async function ensureCategory(businessId, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) throw httpError(400, 'Category name is required');
  if (name.length > 60) throw httpError(400, 'Category name is too long (60 characters max)');

  const key = name.toLowerCase();

  let category = await Category.findOne({ business: businessId, key });
  if (category) return { category, created: false };

  try {
    category = await Category.create({ business: businessId, name });
    return { category, created: true };
  } catch (err) {
    // Two requests created it at the same moment: use the one that won.
    if (err.code === 11000) {
      category = await Category.findOne({ business: businessId, key });
      if (category) return { category, created: false };
    }
    throw err;
  }
}

module.exports = { ensureCategory };
