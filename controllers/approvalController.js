const Approval = require('../models/Approval');
const { httpError } = require('../utils/httpError');
const { approve, decline, cancel } = require('../utils/approvals');

const STATUSES = ['pending', 'approved', 'declined', 'cancelled', 'failed'];

// What the app is shown (never the stored request itself: it can hold more than the person needs)
function out(a) {
  return {
    _id: a._id,
    kind: a.kind,
    status: a.status === 'processing' ? 'pending' : a.status,
    summary: a.summary,
    reasons: a.reasons,
    facts: a.facts,
    requestedBy: a.requestedBy,
    requestedByName: a.requestedByName,
    photos: (a.files || []).length,
    decidedByName: a.decidedByName,
    decidedAt: a.decidedAt,
    decisionNote: a.decisionNote,
    failureMessage: a.failureMessage,
    resultType: a.resultType,
    resultId: a.resultId,
    createdAt: a.createdAt,
  };
}

// GET /api/approvals?status=pending
// The administrator sees everyone's requests; a staff sees only their own.
async function listApprovals(req, res, next) {
  try {
    const filter = { business: req.businessId };
    if (req.user.role !== 'owner') filter.requestedBy = req.user._id;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (STATUSES.includes(status)) filter.status = status === 'pending' ? { $in: ['pending', 'processing'] } : status;
    const [rows, pending] = await Promise.all([
      Approval.find(filter).sort({ createdAt: -1 }).limit(200),
      Approval.countDocuments({ business: req.businessId, status: { $in: ['pending', 'processing'] }, ...(req.user.role === 'owner' ? {} : { requestedBy: req.user._id }) }),
    ]);
    res.json({ approvals: rows.map(out), pending });
  } catch (err) {
    next(err);
  }
}

async function findOne(req) {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw httpError(404, 'Request not found');
  const filter = { _id: req.params.id, business: req.businessId };
  if (req.user.role !== 'owner') filter.requestedBy = req.user._id;
  const a = await Approval.findOne(filter);
  if (!a) throw httpError(404, 'Request not found');
  return a;
}

async function getApproval(req, res, next) {
  try {
    res.json({ approval: out(await findOne(req)) });
  } catch (err) {
    next(err);
  }
}

// POST /api/approvals/:id/approve (administrator)
async function approveApproval(req, res, next) {
  try {
    await findOne(req);
    res.json({ approval: out(await approve(req.params.id, req.user)) });
  } catch (err) {
    next(err);
  }
}

// POST /api/approvals/:id/decline (administrator) body: { note? }
async function declineApproval(req, res, next) {
  try {
    await findOne(req);
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
    res.json({ approval: out(await decline(req.params.id, req.user, note)) });
  } catch (err) {
    next(err);
  }
}

// POST /api/approvals/:id/cancel (the staff who asked)
async function cancelApproval(req, res, next) {
  try {
    await findOne(req);
    res.json({ approval: out(await cancel(req.params.id, req.user)) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listApprovals, getApproval, approveApproval, declineApproval, cancelApproval };
