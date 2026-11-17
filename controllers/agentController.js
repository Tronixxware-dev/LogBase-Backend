// What a Sales Agent sees in their own LogBase account (see utils/agents.js for the pay plan).
// Only their own numbers come back. The admin creates the agent and links it to this login (see adminAgentController).

const Referrer = require('../models/Referrer');
const AgentLog = require('../models/AgentLog');
const { httpError } = require('../utils/httpError');
const { agentSummary, leaderboard, loggableDay } = require('../utils/agents');

async function agentOf(user) {
  return Referrer.findOne({ user: user._id, kind: 'agent' }).lean();
}

function count(value, label) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 500) throw httpError(400, `${label} must be a whole number from 0 to 500`);
  return n;
}

// GET /api/agent/me   ->   { agent: null }  or  { ...summary, leaderboard }
async function myAgent(req, res, next) {
  try {
    const agent = await agentOf(req.user);
    if (!agent) return res.json({ agent: null });
    const [summary, board] = await Promise.all([agentSummary(agent), leaderboard(10).catch(() => [])]);
    res.json({ ...summary, leaderboard: board.map((b) => ({ name: b.name, shops: b.shops, rank: b.rank, you: b.id === String(agent._id) })) });
  } catch (err) {
    next(err);
  }
}

// PUT /api/agent/log   body: { day?, visits, demos, notes? }   (today, or one of the last 6 days)
async function saveLog(req, res, next) {
  try {
    const agent = await agentOf(req.user);
    if (!agent) throw httpError(403, 'Not authorized');
    if (!agent.isActive) throw httpError(403, 'Your Sales Agent account is switched off. Contact the Programme Desk.');
    const day = loggableDay(req.body && req.body.day);
    if (!day) throw httpError(400, 'You can only write up today or the last 6 days');
    const visits = count(req.body.visits, 'Visits');
    const demos = count(req.body.demos, 'Demos');
    if (demos > visits) throw httpError(400, 'Demos cannot be more than visits');
    const notes = typeof req.body.notes === 'string' ? req.body.notes.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    await AgentLog.updateOne({ agent: agent._id, day }, { $set: { visits, demos, notes } }, { upsert: true });
    res.json({ ok: true, day });
  } catch (err) {
    next(err);
  }
}

module.exports = { myAgent, saveLog };
