const Category = require('../models/Category');
const Product = require('../models/Product');
const { ensureCategory } = require('../utils/categories');
const { httpError } = require('../utils/httpError');

async function listCategories(req, res, next) {
  try {
    // Products created before categories existed only have the name as text. Add those to the list.
    const used = await Product.distinct('category', {
      business: req.businessId,
      isActive: true,
      category: { $nin: [null, ''] },
    });
    for (const name of used) {
      await ensureCategory(req.businessId, name);
    }

    const [categories, counts] = await Promise.all([
      Category.find({ business: req.businessId }).sort({ name: 1 }).lean(),
      Product.aggregate([
        { $match: { business: req.businessId, isActive: true, category: { $nin: [null, ''] } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
    ]);

    const countByName = new Map(counts.map((c) => [c._id, c.count]));
    const result = categories.map((c) => ({ ...c, productCount: countByName.get(c.name) || 0 }));

    res.json({ categories: result });
  } catch (err) {
    next(err);
  }
}

async function createCategory(req, res, next) {
  try {
    const { category, created } = await ensureCategory(req.businessId, req.body.name);
    res.status(created ? 201 : 200).json({ category, created });
  } catch (err) {
    next(err);
  }
}

async function renameCategory(req, res, next) {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) throw httpError(400, 'Category name is required');

    const category = await Category.findOne({ _id: req.params.id, business: req.businessId });
    if (!category) throw httpError(404, 'Category not found');

    const oldName = category.name;
    category.name = name;
    await category.save(); // a duplicate name is rejected by the unique index (409)

    if (oldName !== name) {
      await Product.updateMany(
        { business: req.businessId, category: oldName },
        { $set: { category: name } }
      );
    }

    res.json({ category });
  } catch (err) {
    next(err);
  }
}

async function deleteCategory(req, res, next) {
  try {
    const category = await Category.findOne({ _id: req.params.id, business: req.businessId });
    if (!category) throw httpError(404, 'Category not found');

    const inUse = await Product.countDocuments({
      business: req.businessId,
      isActive: true,
      category: category.name,
    });
    if (inUse > 0) {
      throw httpError(
        409,
        `${inUse} product${inUse === 1 ? ' uses' : 's use'} this category. Move them to another category first.`
      );
    }

    await category.deleteOne();
    res.json({ message: 'Category deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listCategories, createCategory, renameCategory, deleteCategory };
