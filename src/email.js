// Brevo (formerly Sendinblue) transactional email sender

async function sendEmail({ to, toName, subject, htmlContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEY not set — cannot send email');
    return { ok: false, error: 'Email not configured' };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { name: 'BeCopenhagen Fleet', email: 'noreply@interestingtours.dk' },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Brevo send failed:', res.status, err);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e) {
    console.error('Email send error:', e.message);
    return { ok: false, error: e.message };
  }
}

async function sendPasswordResetEmail(toEmail, toName, resetUrl) {
  return sendEmail({
    to: toEmail,
    toName,
    subject: 'Reset your BC Fleet password',
    htmlContent: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#C8102E">BC Fleet</h2>
        <p>Hi ${toName},</p>
        <p>Click the link below to set a new password. This link expires in 1 hour.</p>
        <p><a href="${resetUrl}" style="display:inline-block;background:#C8102E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a></p>
        <p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendEmail, sendPasswordResetEmail };
