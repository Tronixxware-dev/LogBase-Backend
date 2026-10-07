// Protection against password guessing and request flooding.
//
// Everything here lives in the memory of the running server: it needs no database and costs nothing, but it
// starts from zero when the server restarts, and with more than one server each one counts on its own.
// That is a fair trade for now; the numbers below are generous enough for real people and tight for a script.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_KEYS = 20000; // a flood of made-up emails cannot eat the server's memory

// A counter per key that forgets after `windowMs` (the window starts at the first hit).
function createCounter({ windowMs, max, now = Date.now }) {
  const entries = new Map(); // key -> { count, resetAt }

  function live(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() >= entry.resetAt) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  function sweep() {
    const t = now();
    for (const [key, entry] of entries) if (t >= entry.resetAt) entries.delete(key);
  }

  return {
    max,
    // how many hits so far, and how long until the counter forgets them
    peek(key) {
      const entry = live(key);
      return entry ? { count: entry.count, retryAfterMs: entry.resetAt - now() } : { count: 0, retryAfterMs: 0 };
    },
    blocked(key) {
      const { count, retryAfterMs } = this.peek(key);
      return count >= max ? retryAfterMs : 0;
    },
    hit(key) {
      let entry = live(key);
      if (!entry) {
        if (entries.size >= MAX_KEYS) {
          sweep();
          if (entries.size >= MAX_KEYS) entries.delete(entries.keys().next().value); // the oldest one
        }
        entry = { count: 0, resetAt: now() + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return { count: entry.count, retryAfterMs: entry.resetAt - now() };
    },
    reset(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    sweep,
    keys() {
      return [...entries.keys()];
    },
    get size() {
      return entries.size;
    },
  };
}

// Removes the expired entries now and then. unref() so this never keeps the server (or a test) from exiting.
function keepTidy(counters, everyMs = 5 * 60 * 1000) {
  const timer = setInterval(() => counters.forEach((c) => c.sweep()), everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

function minutesText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function lockedMessage(ms) {
  return `Too many failed attempts. Try again in ${minutesText(ms)}, or use Forgot password.`;
}

// Who is asking. Behind a proxy this is only the real visitor when TRUST_PROXY is set (see utils/security.js).
function clientIp(req) {
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

// Wrong-password limits for logging in:
//   - the same email from the same address:   5 in 15 minutes   (the person who forgot their password)
//   - the same email from anywhere:          20 in 15 minutes   (a guesser using many addresses)
//   - one address trying any emails:         30 in 15 minutes   (a guesser trying many accounts)
// Unknown emails count exactly like known ones, so the limits cannot be used to find out who has an account.
function createLoginGuard({ now = Date.now, pairMax = 5, emailMax = 20, ipMax = 30, windowMs = WINDOW_MS } = {}) {
  const pair = createCounter({ windowMs, max: pairMax, now });
  const byEmail = createCounter({ windowMs, max: emailMax, now });
  const byIp = createCounter({ windowMs, max: ipMax, now });
  const pairKey = (email, ip) => `${emailKey(email)}|${ip}`;

  return {
    counters: [pair, byEmail, byIp],
    // 0 when this attempt may go ahead, otherwise how many milliseconds until it may
    check(email, ip) {
      return Math.max(pair.blocked(pairKey(email, ip)), byEmail.blocked(emailKey(email)), byIp.blocked(ip));
    },
    // Records a wrong password. `lockedNow` says which limit this attempt just reached (so it is reported once).
    fail(email, ip) {
      const a = pair.hit(pairKey(email, ip));
      const b = byEmail.hit(emailKey(email));
      const c = byIp.hit(ip);
      let lockedNow = null;
      if (a.count === pairMax) lockedNow = 'device';
      else if (b.count === emailMax) lockedNow = 'account';
      else if (c.count === ipMax) lockedNow = 'address';
      return { lockedNow, retryAfterMs: Math.max(a.count >= pairMax ? a.retryAfterMs : 0, b.count >= emailMax ? b.retryAfterMs : 0, c.count >= ipMax ? c.retryAfterMs : 0) };
    },
    // a correct password: forget the wrong guesses for this email (not the address's, which may be a guesser's)
    success(email, ip) {
      pair.reset(pairKey(email, ip));
      byEmail.reset(emailKey(email));
    },
    // the password was just reset: the person must not stay locked out of their own account
    clearEmail(email) {
      byEmail.reset(emailKey(email));
      const prefix = `${emailKey(email)}|`;
      // the per-device counters for this email: only a handful can exist, so a scan is cheap enough
      for (const key of pair.keys()) if (key.startsWith(prefix)) pair.reset(key);
    },
    clear() {
      this.counters.forEach((c) => c.clear());
    },
  };
}

// Same idea for "type your current password" when changing a password while signed in:
// someone holding a borrowed phone gets 5 tries per 15 minutes, not unlimited ones.
function createPasswordGuard({ now = Date.now, max = 5, windowMs = WINDOW_MS } = {}) {
  const counter = createCounter({ windowMs, max, now });
  return {
    counters: [counter],
    check: (userId) => counter.blocked(String(userId)),
    fail: (userId) => counter.hit(String(userId)),
    success: (userId) => counter.reset(String(userId)),
    clear: () => counter.clear(),
  };
}

const loginGuard = createLoginGuard();
const changePasswordGuard = createPasswordGuard();
keepTidy([...loginGuard.counters, ...changePasswordGuard.counters]);

// Express middleware: at most `max` requests per address in `windowMs`. For sign-up and the password e-mail routes.
function rateLimit({ windowMs, max, message, now = Date.now }) {
  const counter = createCounter({ windowMs, max, now });
  keepTidy([counter]);
  const middleware = (req, res, next) => {
    const { count, retryAfterMs } = counter.hit(clientIp(req));
    if (count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return res.status(429).json({ message: message || `Too many requests. Please try again in ${minutesText(retryAfterMs)}.` });
    }
    next();
  };
  middleware.counter = counter;
  return middleware;
}

module.exports = {
  createCounter,
  createLoginGuard,
  createPasswordGuard,
  rateLimit,
  loginGuard,
  changePasswordGuard,
  clientIp,
  lockedMessage,
  minutesText,
  WINDOW_MS,
};
