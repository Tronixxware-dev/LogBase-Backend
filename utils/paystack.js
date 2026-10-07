// A very small Paystack client (no extra package needed). The secret key is read from the environment
// (PAYSTACK_SECRET_KEY in .env) and is never logged or sent anywhere except to Paystack.

const crypto = require('crypto');
const { httpError } = require('./httpError');

const BASE_URL = 'https://api.paystack.co';

function isConfigured() {
  return Boolean(process.env.PAYSTACK_SECRET_KEY);
}

async function request(path, { method = 'GET', body } = {}) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw httpError(503, 'Online payments are not set up yet. Please try again later.');

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw httpError(502, 'Could not reach Paystack. Check your connection and try again.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    throw httpError(res.status >= 500 ? 502 : 400, data.message || 'Paystack could not process this request.');
  }
  return data;
}

// Starts a payment. Returns { authorization_url, access_code, reference }.
async function initializeTransaction({ email, amount, reference, callbackUrl, currency, metadata }) {
  const data = await request('/transaction/initialize', {
    method: 'POST',
    body: { email, amount, reference, callback_url: callbackUrl, currency, metadata },
  });
  return data.data;
}

// Asks Paystack what really happened to a payment. Returns Paystack's `data` object.
async function verifyTransaction(reference) {
  const data = await request(`/transaction/verify/${encodeURIComponent(reference)}`);
  return data.data;
}

// Charges a card that was saved earlier (the "authorization" Paystack returned after the first payment).
// Returns Paystack's transaction `data`; its `status` is 'success', 'failed' or something still in progress.
async function chargeAuthorization({ authorizationCode, email, amount, reference, currency, metadata }) {
  const data = await request('/transaction/charge_authorization', {
    method: 'POST',
    body: { authorization_code: authorizationCode, email, amount, reference, currency, metadata },
  });
  return data.data;
}

// Paystack signs every webhook with HMAC-SHA512 of the raw request body, using your secret key.
function isValidSignature(rawBody, signature) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key || !rawBody || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, initializeTransaction, verifyTransaction, chargeAuthorization, isValidSignature };
