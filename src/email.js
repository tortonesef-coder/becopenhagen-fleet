// Transactional email via SMTP (Simply.com), using nodemailer.
// Replaces the earlier Brevo REST API integration -- Simply.com already
// hosts the team's mailboxes, so this consolidates onto one provider.

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { getDb } = require('./db/schema');

const EMAIL_FOOTER = `
  <p style="margin-top:1.5rem;padding-top:0.75rem;border-top:1px solid #eee;color:#aaa;font-size:0.8em">
    This is an automated email — please do not reply.<br>
    For questions, contact Paloma (+45 25 30 33 30) or Federico (+45 93 89 38 79).
  </p>
`;

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) {
    console.error('SMTP not configured -- missing SMTP_HOST / SMTP_USER / SMTP_PASSWORD env vars');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

async function sendEmail({ to, toName, subject, htmlContent, attachments, category }) {
  const t = getTransporter();
  if (!t) return { ok: false, error: 'Email not configured' };

  const cHash = crypto.createHash('sha1').update(htmlContent || '').digest('hex').substring(0, 16);
  try { maybeAlertDuplicate(to, subject, category, cHash); } catch (e) { console.error('dup-check error:', e.message); }

  try {
    await t.sendMail({
      from: '"BeCopenhagen Fleet" <' + process.env.SMTP_USER + '>',
      to: toName ? '"' + toName + '" <' + to + '>' : to,
      subject,
      html: htmlContent,
      attachments: attachments || [],
    });
    logEmail(to, toName, subject, category, true, null, cHash);
    return { ok: true };
  } catch (e) {
    console.error('SMTP send error:', e.message);
    logEmail(to, toName, subject, category, false, e.message, cHash);
    return { ok: false, error: e.message };
  }
}

function logEmail(to, toName, subject, category, ok, error, contentHash) {
  try {
    getDb().prepare(`INSERT INTO emails_sent (to_email, to_name, subject, category, ok, error, content_hash) VALUES (?,?,?,?,?,?,?)`)
      .run(to, toName || null, subject, category || null, ok ? 1 : 0, error || null, contentHash || null);
  } catch (e) {
    console.error('Failed to log sent email:', e.message);
  }
}

// Duplicate-send guard. Automated notifications (first_booking, tour_reminder,
// tour_cancelled, etc.) are once-only by design, so the SAME email — same
// recipient, same subject, AND same body content — should never go out twice
// within the hour. If it does, it's almost always a trigger bug (an hourly/90s
// job re-firing), so alert Fede. Comparing the content hash means two genuinely
// different emails that happen to share a subject (e.g. two different reviews)
// don't false-trigger. Transactional emails carry no category (not monitored);
// the alert itself is excluded to avoid loops.
const DUP_ALERT_TO = 'federico@becopenhagen.dk';
function maybeAlertDuplicate(to, subject, category, contentHash) {
  if (!category || category === 'duplicate_alert') return;
  const db = getDb();
  const prior = db.prepare(
    `SELECT COUNT(*) n, MAX(sent_at) last FROM emails_sent
       WHERE to_email=? AND subject=? AND content_hash=? AND ok=1 AND sent_at >= datetime('now','-70 minutes')`
  ).get(to, subject, contentHash || '');
  if (!prior || prior.n < 1) return; // no recent identical send (same subject AND body) — normal

  const alertSubject = `⚠️ Duplicate email — "${subject}" → ${to}`;
  // Alert at most once per incident per 12h so a persistent bug doesn't spam.
  const already = db.prepare(
    `SELECT 1 FROM emails_sent WHERE category='duplicate_alert' AND to_email=? AND subject=? AND sent_at >= datetime('now','-12 hours')`
  ).get(DUP_ALERT_TO, alertSubject);
  if (already) return;

  const html = `
    <p><strong>The identical email below was sent to the same person more than once within about an hour.</strong></p>
    <p>These notifications are meant to fire once, so a repeat almost always means an automated job (the hourly scraper or the 90-second sync) is re-firing it — i.e. a bug worth checking.</p>
    <table style="border-collapse:collapse;margin:0.5rem 0">
      <tr><td style="padding:3px 12px 3px 0;color:#888">Recipient</td><td>${to}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#888">Subject</td><td>${subject}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#888">Category</td><td>${category}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#888">Repeats in last 70 min</td><td>${prior.n + 1} (last at ${prior.last} UTC)</td></tr>
    </table>
    ${EMAIL_FOOTER}`;
  // Fire-and-forget; its 'duplicate_alert' category means it won't re-trigger this check.
  sendEmail({ to: DUP_ALERT_TO, toName: 'Federico', subject: alertSubject, htmlContent: html, category: 'duplicate_alert' })
    .catch(e => console.error('Duplicate-alert send failed:', e.message));
}

async function sendPasswordResetEmail(toEmail, toName, resetUrl) {
  return sendEmail({
    to: toEmail,
    toName,
    subject: 'Reset your BC Fleet password',
    htmlContent: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
      '<h2 style="color:#C8102E">BC Fleet</h2>' +
      '<p>Hi ' + toName + ',</p>' +
      '<p>Click the link below to set a new password. This link expires in 1 hour.</p>' +
      '<p><a href="' + resetUrl + '" style="display:inline-block;background:#C8102E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a></p>' +
      '<p style="color:#888;font-size:13px">If you didn\'t request this, you can safely ignore this email.</p>' +
      '</div>',
  });
}

async function sendVerificationCodeEmail(toEmail, toName, code) {
  return sendEmail({
    to: toEmail,
    toName,
    subject: 'Your BC Fleet verification code',
    htmlContent: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
      '<h2 style="color:#C8102E">BC Fleet</h2>' +
      '<p>Hi ' + toName + ',</p>' +
      '<p>Your verification code is:</p>' +
      '<p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#C8102E;text-align:center;padding:16px;background:#fdf0f2;border-radius:8px">' + code + '</p>' +
      '<p style="color:#888;font-size:13px">This code expires in 10 minutes. If you didn\'t request this, you can safely ignore this email.</p>' +
      '</div>',
  });
}

module.exports = { sendEmail, sendPasswordResetEmail, sendVerificationCodeEmail, EMAIL_FOOTER };
