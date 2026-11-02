const Worker = require('../models/Worker');
const WorkerEntry = require('../models/WorkerEntry');
const TailorOrder = require('../models/TailorOrder');
const { httpError } = require('../utils/httpError');
const { round2 } = require('../utils/money');
const { canSeeCosts } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');
const { clean, cleanLong, money, readMoney, isIdText, escapeRegex } = require('../utils/jobHelpers');
const { summariesFor, EMPTY } = require('../utils/workerLedger');

const KINDS = ['tailor'];
const ENTRY_KINDS = ['payout', 'bonus', 'deduction'];
const ENTRY_METHODS = ['cash', 'transfer', 'other'];

// The worker as it is sent to the app. What a worker earns is for the administrator only: a staff just sees who they are (to pick them for a job).
function view(req, worker, summary) {
  const out = typeof worker.toObject === 'function' ? worker.toObject() : { ...worker };
  if (canSeeCosts(req.user)) {
    out.summary = summary || EMPTY;
  } else {
    delete out.rate;
    delete out.guarantor;
    delete out.address;
    delete out.notes;
  }
  return out;
}

async function loadWorker(req) {
  if (!isIdText(req.params.id)) throw httpError(404, 'Worker not found');
  const worker = await Worker.findOne({ _id: req.params.id, business: req.businessId });
  if (!worker) throw httpError(404, 'Worker not found');
  return worker;
}

// GET /api/workers?kind=tailor&active=1&search=ade
async function listWorkers(req, res, next) {
  try {
    const filter = { business: req.businessId };
    if (req.query.kind !== undefined && req.query.kind !== '') {
      if (!KINDS.includes(req.query.kind)) throw httpError(400, 'Unknown kind of worker');
      filter.kind = req.query.kind;
    }
    if (req.query.active === '1' || req.query.active === 'true') filter.isActive = true;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      filter.$or = [{ name: rx }, { phone: rx }, { role: rx }];
    }
    const rows = await Worker.find(filter).sort({ isActive: -1, name: 1 }).limit(500);
    const summaries = canSeeCosts(req.user) ? await summariesFor(req.businessId, rows.map((w) => w._id)) : {};
    const workers = rows.map((w) => view(req, w, summaries[String(w._id)]));
    const out = { workers };
    if (canSeeCosts(req.user)) {
      out.totals = {
        owed: round2(workers.filter((w) => w.summary.balance > 0).reduce((s, w) => s + w.summary.balance, 0)),
        paid: round2(workers.reduce((s, w) => s + w.summary.paid, 0)),
      };
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
}

// GET /api/workers/:id   (administrator)
async function getWorker(req, res, next) {
  try {
    const worker = await loadWorker(req);
    const summaries = await summariesFor(req.businessId, [worker._id]);
    const entries = await WorkerEntry.find({ business: req.businessId, worker: worker._id }).sort({ at: -1, _id: -1 }).limit(300);
    // how much work they have done (pieces sewn)
    let work = {};
    {
      const orders = await TailorOrder.find({ business: req.businessId, 'pieces.worker': worker._id }).select('pieces').lean();
      let pieces = 0;
      let done = 0;
      for (const o of orders) {
        for (const p of o.pieces) {
          if (String(p.worker) !== String(worker._id)) continue;
          pieces += p.quantity || 1;
          if (p.done) done += p.quantity || 1;
        }
      }
      work = { assigned: pieces, finished: done, open: pieces - done };
    }
    res.json({ worker: view(req, worker, summaries[String(worker._id)]), entries, work });
  } catch (err) {
    next(err);
  }
}

function readFields(body, { creating }) {
  const out = {};
  const text = (field, max, label, required) => {
    if (body[field] === undefined && !creating) return;
    const value = clean(body[field], max);
    if (required && !value) throw httpError(400, `${label} is required`);
    out[field] = value;
  };
  text('name', 80, 'The name', true);
  text('phone', 30, 'The phone number');
  text('role', 40, 'The role');
  text('guarantor', 120, "The guarantor's details");
  text('address', 200, 'The address');
  if (body.notes !== undefined || creating) out.notes = cleanLong(body.notes, 500);
  if (body.rate !== undefined || creating) out.rate = readMoney(body.rate, 'The rate', { fallback: 0 });
  if (body.isActive !== undefined) out.isActive = body.isActive === true;
  return out;
}

// POST /api/workers   (administrator)   body: { kind, name, phone?, role?, rate?, guarantor?, address?, notes? }
async function createWorker(req, res, next) {
  try {
    const body = req.body || {};
    if (!KINDS.includes(body.kind)) throw httpError(400, 'Choose the kind of worker');
    const fields = readFields(body, { creating: true });
    const worker = await Worker.create({ ...fields, kind: body.kind, business: req.businessId });
    logActivity(req, {
      action: 'worker.create',
      summary: `Added tailor ${worker.name}${worker.rate > 0 ? ` (usually earns ${money(worker.rate)})` : ''}.`,
      entityType: 'Worker',
      entityId: worker._id,
    });
    res.status(201).json({ worker: view(req, worker, EMPTY) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/workers/:id   (administrator)
async function updateWorker(req, res, next) {
  try {
    const worker = await loadWorker(req);
    const fields = readFields(req.body || {}, { creating: false });
    if (Object.keys(fields).length === 0) return res.json({ worker: view(req, worker, (await summariesFor(req.businessId, [worker._id]))[String(worker._id)]) });
    worker.set(fields);
    await worker.save();
    logActivity(req, {
      action: 'worker.update',
      summary: fields.isActive === false ? `Marked ${worker.name} as no longer working here.` : fields.isActive === true ? `Marked ${worker.name} as working here again.` : `Changed the details of ${worker.name}.`,
      entityType: 'Worker',
      entityId: worker._id,
    });
    res.json({ worker: view(req, worker, (await summariesFor(req.businessId, [worker._id]))[String(worker._id)]) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/workers/:id   (administrator): only a worker with no work and no money on record; otherwise mark them as no longer working here
async function deleteWorker(req, res, next) {
  try {
    const worker = await loadWorker(req);
    const [entries, orders] = await Promise.all([
      WorkerEntry.countDocuments({ business: req.businessId, worker: worker._id }),
      TailorOrder.countDocuments({ business: req.businessId, 'pieces.worker': worker._id }),
    ]);
    if (entries + orders > 0) {
      throw httpError(400, `${worker.name} has work or payments on record, so they cannot be deleted. Mark them as no longer working here instead.`);
    }
    await worker.deleteOne();
    logActivity(req, { action: 'worker.delete', summary: `Deleted ${worker.name} from the list of workers.`, entityType: 'Worker', entityId: worker._id });
    res.json({ message: 'Worker deleted' });
  } catch (err) {
    next(err);
  }
}

// POST /api/workers/:id/entries   (administrator)   body: { kind: 'payout'|'bonus'|'deduction', amount, description?, method?, key?, advance? }
async function addEntry(req, res, next) {
  try {
    const body = req.body || {};
    if (!ENTRY_KINDS.includes(body.kind)) throw httpError(400, 'Choose payout, bonus or deduction');
    const amount = readMoney(body.amount, 'The amount', { min: 0.01 });
    let method;
    if (body.kind === 'payout') {
      method = body.method === undefined || body.method === '' ? 'cash' : body.method;
      if (!ENTRY_METHODS.includes(method)) throw httpError(400, 'Choose how it was paid: cash or transfer');
    }
    let key;
    if (body.key != null && body.key !== '') {
      if (typeof body.key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.key)) throw httpError(400, 'The payment id is not valid');
      key = body.key;
    }

    const worker = await loadWorker(req);
    if (key) {
      const again = await WorkerEntry.findOne({ business: req.businessId, worker: worker._id, key });
      if (again) return res.status(200).json({ duplicate: true, entry: again, summary: (await summariesFor(req.businessId, [worker._id]))[String(worker._id)] || EMPTY });
    }

    const before = (await summariesFor(req.businessId, [worker._id]))[String(worker._id)] || EMPTY;
    // paying out more than they have earned is an advance: the administrator has to say so
    if (body.kind === 'payout' && amount > Math.max(before.balance, 0) && body.advance !== true) {
      throw httpError(
        400,
        before.balance > 0
          ? `${worker.name} is owed ${money(before.balance)}. To pay ${money(amount)}, confirm that the extra is an advance.`
          : `${worker.name} is not owed anything. To pay ${money(amount)}, confirm that it is an advance.`
      );
    }
    let entry;
    try {
      entry = await WorkerEntry.create({
        business: req.businessId,
        worker: worker._id,
        kind: body.kind,
        amount,
        description: clean(body.description, 160) || undefined,
        method,
        key,
        recordedBy: req.user._id,
        recordedByName: req.user.name,
      });
    } catch (err) {
      if (key && err && err.code === 11000) {
        const again = await WorkerEntry.findOne({ business: req.businessId, worker: worker._id, key });
        if (again) return res.status(200).json({ duplicate: true, entry: again, summary: before });
      }
      throw err;
    }

    const verb = { payout: 'Paid', bonus: 'Gave a bonus of', deduction: 'Took off' }[body.kind];
    logActivity(req, {
      action: `worker.${body.kind}`,
      summary: `${verb} ${money(amount)} ${body.kind === 'payout' ? 'to' : body.kind === 'bonus' ? 'to' : 'from'} ${worker.name}${body.advance === true && body.kind === 'payout' ? ' (advance)' : ''}.`,
      entityType: 'Worker',
      entityId: worker._id,
      meta: { amount, method },
    });
    res.status(201).json({ entry, summary: (await summariesFor(req.businessId, [worker._id]))[String(worker._id)] || EMPTY });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/workers/:id/entries/:entryId   (administrator): a payout, bonus or deduction written by mistake.
// What a worker earned is taken back by undoing the work (un-marking the piece or the delivery), not here.
async function deleteEntry(req, res, next) {
  try {
    const worker = await loadWorker(req);
    if (!isIdText(req.params.entryId)) throw httpError(404, 'Entry not found');
    const removed = await WorkerEntry.findOneAndDelete({ _id: req.params.entryId, business: req.businessId, worker: worker._id, kind: { $in: ENTRY_KINDS } });
    if (!removed) throw httpError(404, 'Entry not found, or it is earnings, which are taken back by undoing the work');
    logActivity(req, {
      action: 'worker.entryRemoved',
      summary: `Removed a ${removed.kind} of ${money(removed.amount)} on ${worker.name}'s account.`,
      entityType: 'Worker',
      entityId: worker._id,
    });
    res.json({ summary: (await summariesFor(req.businessId, [worker._id]))[String(worker._id)] || EMPTY });
  } catch (err) {
    next(err);
  }
}

module.exports = { listWorkers, getWorker, createWorker, updateWorker, deleteWorker, addEntry, deleteEntry };
