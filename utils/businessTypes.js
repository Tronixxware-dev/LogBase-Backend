// The kinds of business LogBase is set up for. The type is chosen at signup and decides which menus and pages
// the business gets (the front end has the same list in lib/businessTypes.js).

const BUSINESS_TYPES = [
  { key: 'phone_shop', label: 'Phone & gadget shop' },
  { key: 'retail', label: 'General shop / retail' },
  { key: 'laundromat', label: 'Laundromat' },
  { key: 'repair', label: 'Repair workshop' },
];

const BUSINESS_TYPE_KEYS = BUSINESS_TYPES.map((t) => t.key);

// Every business created before types existed is a phone & gadget shop, so nothing changes for them.
const DEFAULT_BUSINESS_TYPE = 'phone_shop';

// Returns the type when it is one of ours, otherwise null.
function cleanBusinessType(value) {
  return typeof value === 'string' && BUSINESS_TYPE_KEYS.includes(value.trim()) ? value.trim() : null;
}

module.exports = { BUSINESS_TYPES, BUSINESS_TYPE_KEYS, DEFAULT_BUSINESS_TYPE, cleanBusinessType };
