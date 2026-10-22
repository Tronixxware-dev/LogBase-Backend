// Numbers for repair jobs, laundry orders and stock transfers: 1, 2, 3 ... counted separately for each business.
// The business keeps a counter that only ever goes up (so a number is never given out twice, even after a job is deleted),
// and a unique index on business + number is the safety net: if a number is somehow taken, this tries again with the next one.

const Business = require('../models/Business');
const { httpError } = require('./httpError');

const COUNTERS = { Repair: 'repairCounter', LaundryOrder: 'laundryCounter', Transfer: 'transferCounter' };

async function nextNumber(Model, businessId, field) {
  const counter = COUNTERS[Model.modelName];
  if (counter) {
    const business = await Business.findOneAndUpdate({ _id: businessId }, { $inc: { [counter]: 1 } }, { new: true });
    if (!business) throw httpError(404, 'Business not found');
    return business[counter];
  }
  const last = await Model.findOne({ business: businessId }).sort({ [field]: -1 }).select(field).lean();
  return last && Number.isFinite(last[field]) ? last[field] + 1 : 1;
}

function isNumberClash(err, field) {
  return Boolean(err) && err.code === 11000 && (!err.keyPattern || Boolean(err.keyPattern[field]));
}

// build(number) returns the fields of the new record (without business and the number itself).
async function createNumbered(Model, businessId, field, build) {
  const TRIES = 8;
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    const number = await nextNumber(Model, businessId, field);
    try {
      return await Model.create({ ...build(number), business: businessId, [field]: number });
    } catch (err) {
      if (attempt < TRIES && isNumberClash(err, field)) continue;
      throw err;
    }
  }
  return null; // not reached
}

module.exports = { nextNumber, createNumbered };
