// Item swaps: the customer hands in an old item and takes a new one. The old item's value is taken off the new
// item's price, and the customer adds the rest (the top-up). If the old item is worth more than the new one,
// the business gives the difference back.

const { httpError } = require('./httpError');
const { round2 } = require('./money');

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// Reads the trade-in from the request. Returns null when the sale is not a swap.
function readTradeIn(body) {
  if (body.tradeIn === undefined || body.tradeIn === null || body.tradeIn === '') return null;
  const raw = body.tradeIn;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'The item handed in could not be read');

  const description = text(raw.description, 120);
  if (!description) throw httpError(400, 'Say what the customer is handing in (for example: iPhone XR 64GB)');

  if (raw.value === undefined || raw.value === null || raw.value === '') {
    throw httpError(400, 'Enter how much the item handed in is worth');
  }
  const value = round2(Number(raw.value));
  if (!Number.isFinite(value) || value <= 0) throw httpError(400, 'The value of the item handed in must be above 0');
  if (value > 1e12) throw httpError(400, 'The value of the item handed in is too large');

  return {
    description,
    imei: text(raw.imei, 40),
    condition: text(raw.condition, 80),
    value,
  };
}

// The money of a swap.
//   grandTotal  the price of the new item(s)
//   value       what the old item is worth
//   cashPaid    what the customer paid towards the top-up (empty = all of it)
// Returns:
//   credit  the part of the new price covered by the old item (never more than the price)
//   due     the top-up the customer has to add
//   cash    the part of the top-up paid now
//   paid    credit + cash: what counts as paid on the sale
//   refund  what the business gives back when the old item is worth more than the new one
function swapAmounts(grandTotal, value, cashPaid) {
  const total = round2(grandTotal);
  const credit = round2(Math.min(value, total));
  const due = round2(total - credit);
  const refund = round2(Math.max(value - total, 0));

  let cash = cashPaid === undefined || cashPaid === null || cashPaid === '' ? due : Number(cashPaid);
  if (!Number.isFinite(cash) || cash < 0) throw httpError(400, 'The amount paid must be 0 or more');
  cash = round2(Math.min(cash, due));

  return { credit, due, cash, paid: round2(credit + cash), refund };
}

module.exports = { readTradeIn, swapAmounts };
