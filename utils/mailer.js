// Sends email through Resend (https://resend.com) with a plain fetch call, so no extra package is needed.
// Set these in the backend .env:
//   RESEND_API_KEY   your Resend API key (never put it in the code or share it in chat)
//   MAIL_FROM        the sender, e.g.  LogBase <no-reply@yourdomain.com>   (the domain must be verified in Resend)
// While testing, Resend lets you send from  onboarding@resend.dev  to your own Resend account email only.

const { httpError } = require('./httpError');

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendEmail({ to, subject, html, text }) {
  if (!isConfigured()) throw httpError(503, 'Email sending is not set up.');

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw httpError(502, 'Could not reach the email service.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status >= 500 ? 502 : 400, data.message || 'The email service refused the message.');
  return data;
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
<p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0d9488">LogBase</p>
<h1 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h1>
${bodyHtml}
</div></body></html>`;
}

// The email with the reset link
function resetPasswordEmail({ name, link, minutes }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  const text = `${hello}\n\nSomeone (hopefully you) asked to reset the password of your LogBase account.\nOpen this link to choose a new password (it works once and expires in ${minutes} minutes):\n\n${link}\n\nIf you did not ask for this, ignore this email: your password stays the same.\n`;
  const html = layout(
    'Reset your password',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(hello)}</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.5">Someone (hopefully you) asked to reset the password of your LogBase account. The link works once and expires in ${minutes} minutes.</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0d9488;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">Choose a new password</a></p>
<p style="margin:0 0 8px;font-size:12px;color:#6b7280;line-height:1.5">Or copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
<p style="margin:16px 0 0;font-size:12px;color:#6b7280;line-height:1.5">If you did not ask for this, ignore this email: your password stays the same.</p>`
  );
  return { subject: 'Reset your LogBase password', html, text };
}

// Sent after the password was changed through the link, so the owner of the account knows
function passwordChangedEmail({ name }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  const text = `${hello}\n\nThe password of your LogBase account was just changed. If this was you, there is nothing to do.\nIf it was not you, reset your password again right away and tell the administrator of your business.\n`;
  const html = layout(
    'Your password was changed',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(hello)}</p>
<p style="margin:0;font-size:14px;line-height:1.5">The password of your LogBase account was just changed. If this was you, there is nothing to do. If it was not you, reset your password again right away and tell the administrator of your business.</p>`
  );
  return { subject: 'Your LogBase password was changed', html, text };
}

function money(naira) {
  return `₦${Number(naira).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

function longDate(date) {
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Sent after an automatic renewal worked
function renewalSucceededEmail({ name, planName, amount, until, cardLast4 }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  const card = cardLast4 ? ` from your card ending ${cardLast4}` : '';
  const text = `${hello}\n\nYour LogBase ${planName} plan was renewed automatically. ${money(amount)} was charged${card}, and the plan now runs to ${longDate(until)}.\n\nYou can turn off automatic renewal at any time on the Billing page.\n`;
  const html = layout(
    'Your plan was renewed',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(hello)}</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.5">Your <strong>${escapeHtml(planName)}</strong> plan was renewed automatically. ${escapeHtml(money(amount))} was charged${escapeHtml(card)}, and the plan now runs to <strong>${escapeHtml(longDate(until))}</strong>.</p>
<p style="margin:0;font-size:12px;color:#6b7280;line-height:1.5">You can turn off automatic renewal at any time on the Billing page.</p>`
  );
  return { subject: 'Your LogBase plan was renewed', html, text };
}

// Sent when an automatic renewal did not go through. willRetry: we will try the card again.
function renewalFailedEmail({ name, planName, amount, reason, willRetry, link }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  const why = reason ? ` (${reason})` : '';
  const next = willRetry
    ? 'We will try the card again tomorrow. You can also renew yourself on the Billing page, or use a different card.'
    : 'We tried three times and have switched automatic renewal off. Open the Billing page to renew your plan and save a card again.';
  const text = `${hello}\n\nWe could not renew your LogBase ${planName} plan automatically: the charge of ${money(amount)} did not go through${why}.\n${next}\n\n${link}\n`;
  const html = layout(
    'We could not renew your plan',
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(hello)}</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.5">We could not renew your <strong>${escapeHtml(planName)}</strong> plan automatically: the charge of ${escapeHtml(money(amount))} did not go through${escapeHtml(why)}.</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.5">${escapeHtml(next)}</p>
<p style="margin:0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0d9488;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">Open the Billing page</a></p>`
  );
  return { subject: willRetry ? 'Your LogBase plan could not be renewed' : 'Automatic renewal is off: please renew your plan', html, text };
}

module.exports = { isConfigured, sendEmail, resetPasswordEmail, passwordChangedEmail, renewalSucceededEmail, renewalFailedEmail, escapeHtml };
