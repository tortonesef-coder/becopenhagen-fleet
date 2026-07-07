// Transactional email via SMTP (Simply.com), using nodemailer.
// Replaces the earlier Brevo REST API integration -- Simply.com already
// hosts the team's mailboxes, so this consolidates onto one provider.

const nodemailer = require('nodemailer');
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

  try {
    await t.sendMail({
      from: '"BeCopenhagen Fleet" <' + process.env.SMTP_USER + '>',
      to: toName ? '"' + toName + '" <' + to + '>' : to,
      subject,
      html: htmlContent,
      attachments: attachments || [],
    });
    logEmail(to, toName, subject, category, true, null);
    return { ok: true };
  } catch (e) {
    console.error('SMTP send error:', e.message);
    logEmail(to, toName, subject, category, false, e.message);
    return { ok: false, error: e.message };
  }
}

function logEmail(to, toName, subject, category, ok, error) {
  try {
    getDb().prepare(`INSERT INTO emails_sent (to_email, to_name, subject, category, ok, error) VALUES (?,?,?,?,?,?)`)
      .run(to, toName || null, subject, category || null, ok ? 1 : 0, error || null);
  } catch (e) {
    console.error('Failed to log sent email:', e.message);
  }
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
