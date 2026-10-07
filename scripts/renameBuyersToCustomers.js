// One-time clean-up after "Buyers" became "Customers" in the code. Run it ONCE from the LogBase-backend folder
// (where your .env file is), after saving the new code and BEFORE using the app again:
//
//   node scripts/renameBuyersToCustomers.js --dry-run     (only shows what it would change)
//   node scripts/renameBuyersToCustomers.js               (does it)
//
// What it changes in the database this backend uses:
//   1. the "buyers" collection becomes "customers", and "buyerpayments" becomes "customerpayments"
//   2. in sales and customer payments, the field "buyer" becomes "customer" (and "buyerName" becomes "customerName")
//   3. staffs and roles that hold the old permission names (viewBuyers, addBuyers, manageBuyers)
//      get the new ones (viewCustomers, addCustomers, manageCustomers)
//
// It is safe to run again: anything already changed is left alone. It never deletes any records.

require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry-run');
const LEGACY = { viewBuyers: 'viewCustomers', addBuyers: 'addCustomers', manageBuyers: 'manageCustomers' };

function say(text) {
  console.log(DRY ? `[dry run] ${text}` : text);
}

async function collectionExists(db, name) {
  return (await db.listCollections({ name }).toArray()).length > 0;
}

// buyers -> customers (the same records, under the new collection name)
async function renameCollection(db, from, to) {
  if (!(await collectionExists(db, from))) {
    say(`"${from}": nothing to rename (already done, or it never existed).`);
    return;
  }
  if (await collectionExists(db, to)) {
    const already = await db.collection(to).countDocuments();
    if (already > 0) {
      console.log(`"${to}" already holds ${already} record(s), so "${from}" was NOT renamed. Check this by hand before going on.`);
      return;
    }
    say(`"${to}" exists but is empty (the new code created it), so it is replaced by "${from}".`);
    if (!DRY) await db.collection(to).drop();
  }
  const count = await db.collection(from).countDocuments();
  say(`Renaming "${from}" to "${to}" (${count} record(s)).`);
  if (!DRY) await db.collection(from).rename(to);
}

async function renameFields(db, collection, renames) {
  if (!(await collectionExists(db, collection))) {
    say(`"${collection}": no such collection, skipped.`);
    return;
  }
  const filter = { $or: Object.keys(renames).map((field) => ({ [field]: { $exists: true } })) };
  const count = await db.collection(collection).countDocuments(filter);
  say(`"${collection}": ${count} record(s) with old field names.`);
  if (!DRY && count > 0) await db.collection(collection).updateMany(filter, { $rename: renames });
}

async function upgradePermissions(db, collection) {
  if (!(await collectionExists(db, collection))) return;
  const old = Object.keys(LEGACY);
  const docs = await db.collection(collection).find({ permissions: { $in: old } }).toArray();
  say(`"${collection}": ${docs.length} record(s) with old permission names.`);
  if (DRY) return;
  for (const doc of docs) {
    const upgraded = [...new Set(doc.permissions.map((p) => LEGACY[p] || p))];
    await db.collection(collection).updateOne({ _id: doc._id }, { $set: { permissions: upgraded } });
  }
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.log('MONGO_URI is not set. Run this from the LogBase-backend folder, where your .env file is.');
    return;
  }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}${DRY ? ' (dry run, nothing will be changed)' : ''}`);

  await renameCollection(db, 'buyers', 'customers');
  await renameCollection(db, 'buyerpayments', 'customerpayments');
  await renameFields(db, 'sales', { buyer: 'customer', buyerName: 'customerName' });
  await renameFields(db, 'customerpayments', { buyer: 'customer' });
  await upgradePermissions(db, 'users');
  await upgradePermissions(db, 'roles');

  console.log(DRY ? 'Dry run finished. Run it again without --dry-run to apply.' : 'Done.');
}

main()
  .catch((err) => {
    console.error('The clean-up stopped with an error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
