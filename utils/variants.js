const { httpError } = require('./httpError');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `${field} must be a number of 0 or more`);
  return n;
}

// "Red / M", "Red", "M"
function variantLabel(variant) {
  if (!variant) return '';
  return [variant.color, variant.size].filter(Boolean).join(' / ');
}

function variantKey(variant) {
  return `${clean(variant.color).toLowerCase()}|${clean(variant.size).toLowerCase()}`;
}

// Turns raw request data into a clean variant object. Throws a 400 if it is invalid.
function normalizeVariant(input = {}) {
  const color = clean(input.color);
  const size = clean(input.size);

  if (!color && !size) {
    throw httpError(400, 'Each variant needs a color or a size');
  }

  const variant = {
    color,
    size,
    sku: clean(input.sku),
    quantity: optionalNumber(input.quantity, 'Variant quantity') ?? 0,
  };

  const costPrice = optionalNumber(input.costPrice, 'Variant cost price');
  const sellingPrice = optionalNumber(input.sellingPrice, 'Variant selling price');
  if (costPrice !== undefined) variant.costPrice = costPrice;
  if (sellingPrice !== undefined) variant.sellingPrice = sellingPrice;

  return variant;
}

// Normalizes a whole list and rejects duplicates (same color + size).
function normalizeVariantList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((raw) => {
    const variant = normalizeVariant(raw);
    const key = variantKey(variant);
    if (seen.has(key)) {
      throw httpError(400, `Duplicate variant: ${variantLabel(variant)}`);
    }
    seen.add(key);
    return variant;
  });
}

function totalQuantity(variants) {
  return (variants || []).reduce((sum, v) => sum + (Number(v.quantity) || 0), 0);
}

module.exports = {
  variantLabel,
  variantKey,
  normalizeVariant,
  normalizeVariantList,
  totalQuantity,
};
