// "Sold by" on a sale is the seller's name. These helpers add the seller's profile photo (sellerPhotoUrl) to sales,
// so the pages can show the picture next to the name. It is only a display detail: a sale never stores a photo.

const User = require('../models/User');

function norm(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Everyone in the business with a photo, found by id and by (unique) name.
async function loadLookup(businessId) {
  const users = await User.find({ business: businessId }).select('name photo');
  const byId = new Map();
  const byName = new Map(); // name -> photo url, or null when two people share that name (then we cannot tell)
  for (const u of users) {
    const url = (u.photo && u.photo.url) || '';
    byId.set(String(u._id), { name: norm(u.name), url });
    const key = norm(u.name);
    byName.set(key, byName.has(key) ? null : url);
  }
  return { byId, byName };
}

function photoFor(sale, lookup) {
  const seller = norm(sale.sellerName);
  if (!seller) return '';
  // the person who recorded the sale, when the name on it is theirs
  const recorder = sale.recordedBy && lookup.byId.get(String(sale.recordedBy._id || sale.recordedBy));
  if (recorder && recorder.name === seller) return recorder.url;
  return lookup.byName.get(seller) || '';
}

function plain(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
}

// A copy of each sale with sellerPhotoUrl added (only when the seller has a photo).
async function withSellerPhotos(businessId, sales) {
  const lookup = await loadLookup(businessId);
  return sales.map((sale) => {
    const out = plain(sale);
    const url = photoFor(out, lookup);
    if (url) out.sellerPhotoUrl = url;
    return out;
  });
}

async function withSellerPhoto(businessId, sale) {
  return (await withSellerPhotos(businessId, [sale]))[0];
}

module.exports = { withSellerPhotos, withSellerPhoto };
