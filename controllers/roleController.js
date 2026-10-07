const Role = require('../models/Role');
const { httpError } = require('../utils/httpError');
const { cleanPermissions, upgradePermissions } = require('../utils/permissions');
const { logActivity } = require('../utils/audit');

// roles saved before customers were called buyers still hold the old permission names
function roleView(role) {
  const out = typeof role.toObject === 'function' ? role.toObject() : { ...role };
  out.permissions = upgradePermissions(out.permissions || []);
  return out;
}

const MAX_ROLES = 30;

function cleanName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw httpError(400, 'Give the role a name');
  if (name.length > 40) throw httpError(400, 'The role name can be at most 40 characters');
  return name;
}

function duplicate(name) {
  return httpError(409, `You already have a role called "${name}"`);
}

// Owner only: every role this business has made.
async function listRoles(req, res, next) {
  try {
    const roles = await Role.find({ business: req.businessId }).sort({ name: 1 });
    res.json({ roles: roles.map(roleView) });
  } catch (err) {
    next(err);
  }
}

// Owner only: makes a new role.
async function createRole(req, res, next) {
  try {
    const name = cleanName(req.body.name);
    const permissions = req.body.permissions === undefined ? [] : cleanPermissions(req.body.permissions);

    const count = await Role.countDocuments({ business: req.businessId });
    if (count >= MAX_ROLES) throw httpError(400, `You can have at most ${MAX_ROLES} roles. Delete one you no longer use.`);

    const taken = await Role.findOne({ business: req.businessId, key: name.toLowerCase() });
    if (taken) throw duplicate(name);

    const role = await Role.create({ business: req.businessId, name, permissions });
    logActivity(req, { action: 'staff.role', summary: `Created the role ${role.name}`, entityType: 'Role', entityId: role._id });
    res.status(201).json({ role: roleView(role) });
  } catch (err) {
    next(err);
  }
}

// Owner only: renames a role and/or changes its permissions. Staffs who already have it are not changed.
async function updateRole(req, res, next) {
  try {
    const role = await Role.findOne({ _id: req.params.id, business: req.businessId });
    if (!role) throw httpError(404, 'Role not found');

    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name);
      const taken = await Role.findOne({ business: req.businessId, key: name.toLowerCase() });
      if (taken && String(taken._id) !== String(role._id)) throw duplicate(name);
      role.name = name;
    }
    if (req.body.permissions !== undefined) role.permissions = cleanPermissions(req.body.permissions);

    await role.save();
    logActivity(req, { action: 'staff.role', summary: `Changed the role ${role.name}`, entityType: 'Role', entityId: role._id });
    res.json({ role: roleView(role) });
  } catch (err) {
    next(err);
  }
}

// Owner only: removes a role from the list. Staffs who already have it keep their access and their label.
async function deleteRole(req, res, next) {
  try {
    const role = await Role.findOne({ _id: req.params.id, business: req.businessId });
    if (!role) throw httpError(404, 'Role not found');

    await role.deleteOne();
    logActivity(req, { action: 'staff.role', summary: `Deleted the role ${role.name}`, entityType: 'Role', entityId: role._id });
    res.json({ message: 'Role deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listRoles, createRole, updateRole, deleteRole };
