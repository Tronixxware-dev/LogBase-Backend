// Who is a LogBase super admin. It is NOT stored in the database (so nobody can promote themselves through the app):
// set SUPER_ADMIN_EMAILS in the server's environment, e.g.  SUPER_ADMIN_EMAILS=you@gmail.com   (several: separate with commas).
// That person logs in with their normal LogBase account and then sees the Admin panel.

function superAdminEmails() {
  return String(process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function isSuperAdminEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return superAdminEmails().includes(email.trim().toLowerCase());
}

module.exports = { isSuperAdminEmail, superAdminEmails };
