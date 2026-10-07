// Server-wide protections: browser security headers, which proxy to believe, and who may call the API from a browser.

// TRUST_PROXY tells Express how many proxies sit in front of the server (a host like Render, Railway or Nginx).
// Without it every visitor looks like the proxy's address, so the login limits would lock everyone out together.
//   unset / false -> no proxy (the default)      1 or true -> one proxy in front      "loopback", "10.0.0.0/8" ... -> as Express reads it
// It is never "trust everything": anyone could then claim any address and walk round the limits.
function trustProxyValue(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!text || text === 'false' || text === '0') return false;
  if (text === 'true') return 1;
  if (/^\d+$/.test(text)) return Number(text);
  return String(raw).trim();
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

// Everything under /api holds somebody's business data or a one-time answer: browsers and proxies must not keep copies.
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

// CORS_ORIGIN="https://app.yourdomain.com,https://www.yourdomain.com" limits browsers to those sites.
// Unset keeps the old behaviour (any site; fine while nothing relies on cookies, since every call carries its own token).
function corsOptions(raw) {
  const list = String(raw || '')
    .split(',')
    .map((x) => x.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (list.length === 0) return {};
  return {
    origin(origin, callback) {
      // no Origin header = not a browser (Paystack's webhook, curl, health checks): CORS does not apply
      if (!origin || list.includes(origin.replace(/\/+$/, ''))) return callback(null, true);
      return callback(null, false);
    },
  };
}

module.exports = { trustProxyValue, securityHeaders, noStore, corsOptions };
