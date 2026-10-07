// What makes a password acceptable. The length rule stays as it was (6 to 128) so nobody's habits break;
// on top of it, the passwords every guesser tries first, and a password made from the person's own email or name, are refused.

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;

// The most used passwords (all lower case). Anyone guessing starts here.
const COMMON = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '654321', '666666', '888888', '000000', '111111',
  '121212', '123123', '112233', '102030', '123321', '987654', '987654321', '1q2w3e', '1q2w3e4r', '1qaz2wsx',
  'qwerty', 'qwerty1', 'qwerty123', 'qwertyuiop', 'qazwsx', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm',
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'pass123', 'pass1234',
  'admin', 'admin1', 'admin123', 'administrator', 'welcome', 'welcome1', 'welcome123', 'login', 'letmein',
  'abc123', 'abcd1234', 'abcdef', 'abcdefg', 'abc12345', 'iloveyou', 'monkey', 'dragon', 'master', 'sunshine',
  'princess', 'football', 'shadow', 'superman', 'trustno1', 'changeme', 'secret', 'test123', 'testing',
  'logbase', 'logbase123', 'logg', 'logg123', 'loggr', 'loggr123', 'inventory', 'business', 'company', 'store123', 'shop123', 'nigeria', 'nigeria1', 'lagos123',
]);

function squash(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Returns a sentence saying what is wrong, or null when the password is fine.
//   label: how to call it in the message ('password' or 'new password')
//   email, name: the person's own details, which must not be the password
function checkPassword(password, { label = 'password', email = '', name = '' } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `The ${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `The ${label} is too long`;

  const lower = password.toLowerCase();
  const letters = squash(password);
  if (COMMON.has(lower) || COMMON.has(letters)) return `That ${label} is too easy to guess. Choose something less common.`;
  if (/^(.)\1+$/.test(password)) return `That ${label} is too easy to guess. Choose something less common.`; // aaaaaa, 000000

  const own = [email, String(email || '').split('@')[0], name].map(squash).filter((x) => x.length >= 4);
  if (letters && own.includes(letters)) return `The ${label} cannot be your email or your name. Choose something only you would know.`;
  return null;
}

module.exports = { checkPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };
