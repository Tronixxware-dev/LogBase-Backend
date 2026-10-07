// Finds out why a login fails, and can fix it. Run it from the LogBase-backend folder:
//
//   node scripts/accountHelp.js you@email.com
//        -> says whether that email exists in the database this backend uses (and lists the
//           emails that DO exist, so you can spot a typo or the wrong database)
//
//   node scripts/accountHelp.js you@email.com --password "what-you-type"
//        -> also says whether that password matches the saved one
//
//   node scripts/accountHelp.js you@email.com --set-password "NewPass123"
//        -> saves a new password for that account (6+ characters) and switches the account on
//
// It only touches the one account you name, and never prints password hashes.

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

function readArgs() {
  const args = process.argv.slice(2);
  const email = (args[0] || '').trim().toLowerCase();
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return { email, password: valueOf('--password'), newPassword: valueOf('--set-password') };
}

async function main() {
  const { email, password, newPassword } = readArgs();
  if (!email || email.startsWith('--')) {
    console.log('Usage: node scripts/accountHelp.js you@email.com [--password "..."] [--set-password "..."]');
    return;
  }
  if (!process.env.MONGO_URI) {
    console.log('MONGO_URI is not set. Run this from the LogBase-backend folder, where your .env file is.');
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to database "${mongoose.connection.name}" on ${mongoose.connection.host}`);

  const user = await User.findOne({ email });
  if (!user) {
    console.log(`\nNo account with the email "${email}" exists in this database.`);
    const all = await User.find({}).select('email role').limit(50);
    if (all.length === 0) {
      console.log('This database has no accounts at all. It is probably a different (or new) database than the one you signed up in. Check MONGO_URI in your .env file, or sign up again.');
    } else {
      console.log('Accounts that DO exist here:');
      all.forEach((u) => console.log(`  - ${u.email} (${u.role})`));
    }
    return;
  }

  console.log(`\nFound: ${user.name} <${user.email}>, role ${user.role}, ${user.isActive ? 'active' : 'SWITCHED OFF'}`);

  if (password !== undefined) {
    const ok = await bcrypt.compare(password, user.passwordHash);
    console.log(ok ? 'That password MATCHES.' : 'That password does NOT match the saved one.');
  }

  if (newPassword !== undefined) {
    if (newPassword.length < 6) {
      console.log('The new password must be at least 6 characters. Nothing was changed.');
      return;
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.isActive = true;
    await user.save();
    console.log('New password saved. You can log in with it now.');
  }
}

main()
  .catch((err) => console.error('Failed:', err.message))
  .finally(() => mongoose.disconnect());
