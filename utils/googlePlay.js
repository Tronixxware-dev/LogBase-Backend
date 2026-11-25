// Plans bought inside the Android app with Google Play Billing.
//
// The app asks Google to charge the person and gets back a "purchase token". The app sends the token to us and WE ask Google
// (Play Developer API) what it really is: which subscription, until when, and whose it is. Nothing the app says is trusted.
// Google also tells us about renewals and cancellations (real-time notifications, see googleNotifications in the billing
// controller), and the Billing page re-checks a purchase now and then, so the plan always follows what Google says.
//
// Needs two things on the server:
//   GOOGLE_PLAY_SERVICE_ACCOUNT   the service account's JSON key (as JSON text or base64 of it)
//   GOOGLE_PLAY_RTDN_TOKEN        a long random secret that is part of the notification address

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Subscription = require('../models/Subscription');
const BillingPayment = require('../models/BillingPayment');
const { GOOGLE_PRODUCTS, GOOGLE_PACKAGE, priceOf } = require('../config/plans');
const { getSubscription } = require('./billing');
const { recordCommission } = require('./referrals');
const { httpError } = require('./httpError');

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const ENTITLED_STATES = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'];

function serviceAccount() {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const json = JSON.parse(text);
    if (!json.client_email || !json.private_key) return null;
    return { email: json.client_email, key: String(json.private_key).replace(/\\n/g, '\n') };
  } catch {
    return null;
  }
}

function isConfigured() {
  return Boolean(serviceAccount());
}

// What the app attaches to a purchase so we can tell whose it is. Not secret, but not the business id itself.
function accountTokenFor(businessId) {
  return crypto.createHash('sha256').update(`logbase:${String(businessId)}`).digest('hex').slice(0, 32);
}

let cached = null;
async function accessToken() {
  if (cached && cached.expires > Date.now() + 60000) return cached.value;
  const sa = serviceAccount();
  if (!sa) throw httpError(503, 'Google Play payments are not set up yet. Please try again later.');
  const assertion = jwt.sign({ scope: SCOPE }, sa.key, { algorithm: 'RS256', issuer: sa.email, audience: TOKEN_URL, expiresIn: 3000 });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error('Google sign-in failed:', res.status, data.error || '');
    throw httpError(502, 'Could not reach Google Play. Please try again in a moment.');
  }
  cached = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3000) * 1000 };
  return cached.value;
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Google Play API error:', res.status, text.slice(0, 300));
    if (res.status === 400 || res.status === 404 || res.status === 410) throw httpError(400, 'Google could not confirm this purchase.');
    throw httpError(502, 'Could not reach Google Play. Please try again in a moment.');
  }
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

function fetchSubscription(purchaseToken) {
  return api('GET', `/applications/${GOOGLE_PACKAGE}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
}

// Google's answer, boiled down to what we need.
function readInfo(info) {
  const line = (info.lineItems && info.lineItems[0]) || {};
  const product = GOOGLE_PRODUCTS[line.productId] || null;
  const expiry = line.expiryTime ? new Date(line.expiryTime) : null;
  const state = info.subscriptionState || '';
  const entitled = ENTITLED_STATES.includes(state) && Boolean(expiry) && expiry.getTime() > Date.now();
  const price = line.autoRenewingPlan && line.autoRenewingPlan.recurringPrice;
  let amountKobo = null;
  if (price && price.currencyCode === 'NGN') {
    amountKobo = Math.round((Number(price.units || 0) + Number(price.nanos || 0) / 1e9) * 100);
  }
  if (product && !(amountKobo > 0)) amountKobo = priceOf(product.plan, product.interval);
  return {
    productId: line.productId || null,
    plan: product ? product.plan : null,
    interval: product ? product.interval : null,
    expiry,
    state,
    entitled,
    pending: state === 'SUBSCRIPTION_STATE_PENDING',
    orderId: line.latestSuccessfulOrderId || info.latestOrderId || null,
    autoRenewing: Boolean(line.autoRenewingPlan && line.autoRenewingPlan.autoRenewEnabled),
    accountId: info.externalAccountIdentifiers && info.externalAccountIdentifiers.obfuscatedExternalAccountId,
    acknowledged: info.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    linkedToken: info.linkedPurchaseToken || null,
    amountKobo,
  };
}

// Google needs every purchase confirmed within 3 days or it is refunded. The app normally does this itself; this is the safety net.
async function acknowledgeIfNeeded(token, r) {
  if (r.acknowledged || !r.productId || !r.entitled) return;
  await api('POST', `/applications/${GOOGLE_PACKAGE}/purchases/subscriptions/${encodeURIComponent(r.productId)}/tokens/${encodeURIComponent(token)}:acknowledge`, {}).catch((err) =>
    console.error('Could not acknowledge a Google purchase:', err.message)
  );
}

// Gives the business its plan (or updates it) from what Google says. Safe to repeat: a payment is recorded once per Google order.
async function applyGoogle(businessId, token, r, now = new Date()) {
  if (!r.plan) throw httpError(400, 'This purchase is not one of the LogBase plans.');
  const sub = await Subscription.findOne({ business: businessId }).select('+google.purchaseToken');
  const sameToken = Boolean(sub && sub.google && sub.google.purchaseToken === token);

  const set = {
    'google.purchaseToken': token,
    'google.productId': r.productId,
    'google.orderId': r.orderId,
    'google.state': r.state,
    'google.expiresAt': r.expiry,
    'google.autoRenewing': r.autoRenewing,
    'google.syncedAt': now,
  };
  if (r.entitled) {
    set.status = 'active';
    set.plan = r.plan;
    set.interval = r.interval;
    set.lastPaymentAt = now;
    // a plan already paid on the website that runs longer is never cut short
    const websiteEnd = sub && !sameToken && sub.status === 'active' && sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
    set.currentPeriodEnd = websiteEnd && websiteEnd > r.expiry ? websiteEnd : r.expiry;
    // Google renews it; our own card renewal must stay out of the way
    set.autoRenew = false;
    set.renewalAttempts = 0;
    set.renewalFailure = '';
    set.nextRenewalAt = null;
  } else if (sameToken && r.expiry) {
    // cancelled, refunded or run out: the plan time now ends when Google says
    // (a refunded or revoked purchase shows as expired: it ends now, not at the date it would have run to)
    set.currentPeriodEnd = r.state === 'SUBSCRIPTION_STATE_EXPIRED' && r.expiry > now ? now : r.expiry;
  }
  // a purchase that is not running (expired, still pending) must not replace the one we already follow
  if (!r.entitled && !sameToken) return { subscription: sub, payment: null };
  await getSubscription(businessId, now);
  const updated = await Subscription.findOneAndUpdate({ business: businessId }, { $set: set }, { new: true });

  let created = null;
  if (r.entitled && r.orderId) {
    try {
      created = await BillingPayment.create({
        business: businessId,
        reference: `gp_${r.orderId}`,
        plan: r.plan,
        interval: r.interval,
        amount: r.amountKobo,
        currency: 'NGN',
        status: 'success',
        source: 'google',
        googleOrderId: r.orderId,
        paidAt: now,
        periodStart: now,
        periodEnd: r.expiry,
        renewal: /\.\.\d+$/.test(r.orderId), // Google numbers renewals GPA.xxxx..0, ..1 ...
      });
      // the referrer of this business (if any) earns their share; this can never undo the purchase
      await recordCommission(created).catch((err) => console.error('Referral commission failed:', err.message));
    } catch (err) {
      if (!err || err.code !== 11000) throw err; // already recorded for this order
    }
  }
  return { subscription: updated, payment: created };
}

// The app has just bought a plan: check the token with Google and apply it to THIS business.
async function verifyAndApply(businessId, token) {
  const info = await fetchSubscription(token);
  const r = readInfo(info);
  if (r.accountId !== accountTokenFor(businessId)) throw httpError(403, 'This purchase belongs to another account.');
  const other = await Subscription.findOne({ 'google.purchaseToken': token, business: { $ne: businessId } }).select('_id').lean();
  if (other) throw httpError(409, 'This purchase is already used by another business.');
  await acknowledgeIfNeeded(token, r);
  const applied = await applyGoogle(businessId, token, r);
  return { ...r, ...applied };
}

// Google says something changed about a subscription (renewed, cancelled, expired...): bring our records in line.
async function syncByToken(token) {
  let sub = await Subscription.findOne({ 'google.purchaseToken': token }).select('+google.purchaseToken');
  const info = await fetchSubscription(token);
  const r = readInfo(info);
  if (!sub && r.linkedToken) {
    // the person subscribed again after letting it run out: Google gives the new subscription a new token
    sub = await Subscription.findOne({ 'google.purchaseToken': r.linkedToken }).select('+google.purchaseToken');
  }
  if (!sub) return null; // a purchase the app has not told us about yet: the app's own check will handle it
  if (r.accountId && r.accountId !== accountTokenFor(sub.business)) return null;
  await acknowledgeIfNeeded(token, r);
  return applyGoogle(sub.business, token, r);
}

// Called when the Billing page opens: looks again at a stored purchase when it is due to end soon or was not checked for a while.
async function refreshIfStale(businessId) {
  const sub = await Subscription.findOne({ business: businessId }).select('+google.purchaseToken');
  if (!sub || !sub.google || !sub.google.purchaseToken || !isConfigured()) return;
  const synced = sub.google.syncedAt ? new Date(sub.google.syncedAt).getTime() : 0;
  const ends = sub.google.expiresAt ? new Date(sub.google.expiresAt).getTime() : 0;
  const soon = ends < Date.now() + 2 * 24 * 3600 * 1000;
  if (!soon && Date.now() - synced < 6 * 3600 * 1000) return;
  const r = readInfo(await fetchSubscription(sub.google.purchaseToken));
  await applyGoogle(businessId, sub.google.purchaseToken, r);
}

module.exports = { isConfigured, accountTokenFor, verifyAndApply, syncByToken, refreshIfStale, readInfo };
