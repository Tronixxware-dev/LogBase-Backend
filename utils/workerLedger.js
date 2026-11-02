// A worker's account: what they have earned (pieces sewn), bonuses, deductions and what was paid out.
// Only records are kept here, no money is sent. balance = earnings + bonuses - payouts - deductions (below zero = paid in advance).

const mongoose = require('mongoose');
const WorkerEntry = require('../models/WorkerEntry');
const { round2 } = require('./money');

const PLUS = ['earning', 'bonus'];

// { [workerId]: { earned, bonus, paid, deducted, balance } } for the given workers (all of them when none are named)
async function summariesFor(businessId, workerIds) {
  const match = { business: new mongoose.Types.ObjectId(String(businessId)) };
  if (workerIds) match.worker = { $in: workerIds.map((id) => new mongoose.Types.ObjectId(String(id))) };
  const rows = await WorkerEntry.aggregate([{ $match: match }, { $group: { _id: { worker: '$worker', kind: '$kind' }, total: { $sum: '$amount' } } }]);
  const out = {};
  for (const r of rows) {
    const key = String(r._id.worker);
    if (!out[key]) out[key] = { earned: 0, bonus: 0, paid: 0, deducted: 0, balance: 0 };
    const field = { earning: 'earned', bonus: 'bonus', payout: 'paid', deduction: 'deducted' }[r._id.kind];
    out[key][field] = round2(r.total);
  }
  for (const s of Object.values(out)) s.balance = round2(s.earned + s.bonus - s.paid - s.deducted);
  return out;
}

const EMPTY = { earned: 0, bonus: 0, paid: 0, deducted: 0, balance: 0 };

// Records what a worker earned for one piece. Doing it twice for the same piece changes nothing.
async function recordEarning(req, { worker, amount, description, sourceType, sourceId, sourceCode, pieceId }) {
  const value = round2(Number(amount));
  if (!worker || !(value > 0)) return null;
  const sourceKey = `${sourceType}:${sourceId}${pieceId ? `:${pieceId}` : ''}`;
  try {
    return await WorkerEntry.create({
      business: req.businessId,
      worker,
      kind: 'earning',
      amount: value,
      description,
      sourceType,
      sourceId,
      sourceCode,
      sourceKey,
      recordedBy: req.user._id,
      recordedByName: req.user.name,
    });
  } catch (err) {
    if (err && err.code === 11000) return null; // already recorded
    throw err;
  }
}

// Takes an earning back (the work was undone). Returns true when there was one.
async function removeEarning(businessId, { sourceType, sourceId, pieceId }) {
  const sourceKey = `${sourceType}:${sourceId}${pieceId ? `:${pieceId}` : ''}`;
  const removed = await WorkerEntry.findOneAndDelete({ business: businessId, kind: 'earning', sourceKey });
  return Boolean(removed);
}

// Takes back every earning of an order (it was deleted or cancelled).
async function removeEarningsOf(businessId, { sourceType, sourceId }) {
  await WorkerEntry.deleteMany({ business: businessId, kind: 'earning', sourceType, sourceId });
}

module.exports = { summariesFor, recordEarning, removeEarning, removeEarningsOf, EMPTY, PLUS };
