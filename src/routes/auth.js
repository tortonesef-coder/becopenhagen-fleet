const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { hashPassword, verifyPassword, generateToken } = require('../auth');
const { sendPasswordResetEmail, sendVerificationCodeEmail } = require('../email');

function db() { return getDb(); }

// GET /auth/team — names only, for the Counter Mode "who did this?" grid.
// Roles are NOT exposed: an unauthenticated caller has no business knowing who
// is an admin, and the login screen no longer lists people at all.
router.get('/team', (req, res) => {
  const team = db().prepare('SELECT id, name FROM team_members WHERE active=1 ORDER BY name').all();
  res.json(team);
});

// GET /auth/team-admin — full team incl. roles/capabilities. Admin only: the
// public /auth/team deliberately hides roles, but the "View as" preview tool
// needs them to reproduce another person's view.
router.get('/team-admin', (req, res) => {
  if (req.session?.actor_role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const team = db().prepare('SELECT id, name, role, is_guide, can_shop, view_mode FROM team_members WHERE active=1 ORDER BY name').all();
  res.json(team);
});

// POST /auth/login-email — log in with email + password (the login screen).
// Deliberately vague on failure: never reveal whether an email exists.
router.post('/login-email', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const member = db().prepare('SELECT * FROM team_members WHERE lower(email)=lower(?) AND active=1').get(String(email).trim());
  const FAIL = { error: 'Incorrect email or password' };
  if (!member) return res.status(401).json(FAIL);
  if (member.needs_password_setup || !member.password_hash) {
    return res.status(403).json({ error: 'No password set yet — use "Set up / forgot password" below.', needs_setup: true });
  }
  if (!verifyPassword(password, member.password_hash, member.password_salt)) return res.status(401).json(FAIL);

  req.session.actor = member.id;
  req.session.actor_name = member.name;
  req.session.actor_role = member.role;
  res.json({ ok: true, actor: { id: member.id, name: member.name, role: member.role, is_guide: member.is_guide, can_shop: member.can_shop, view_mode: member.view_mode } });
});

// POST /auth/forgot-password-email — reset by email (no member picker).
// Always reports success, so this can't be used to discover who has an account.
router.post('/forgot-password-email', async (req, res) => {
  const { email } = req.body;
  const OK = { ok: true, message: 'If that email is on file, a reset link is on its way.' };
  if (!email) return res.json(OK);

  const member = db().prepare('SELECT * FROM team_members WHERE lower(email)=lower(?) AND active=1').get(String(email).trim());
  if (!member || !member.email) return res.json(OK);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db().prepare('INSERT INTO password_resets (token, member_id, expires_at) VALUES (?,?,?)').run(token, member.id, expiresAt);

  const resetUrl = `https://fleet.interestingtours.dk/reset-password?token=${token}`;
  await sendPasswordResetEmail(member.email, member.name, resetUrl).catch(e => console.error('Reset email failed:', e.message));
  res.json(OK);
});

// POST /auth/login — step 1: check if password set, step 2: verify
router.post('/login', (req, res) => {
  const { member_id, password } = req.body;
  const member = db().prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(member_id);
  if (!member) return res.status(404).json({ error: 'Unknown team member' });

  if (member.needs_password_setup) {
    return res.json({ needs_setup: true, email_on_file: member.email || null });
  }

  // A genuinely empty/missing password must NEVER succeed — always reject explicitly.
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  if (!member.password_hash || !verifyPassword(password, member.password_hash, member.password_salt)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  req.session.actor = member.id;
  req.session.actor_name = member.name;
  req.session.actor_role = member.role;
  res.json({ ok: true, actor: { id: member.id, name: member.name, role: member.role, is_guide: member.is_guide, can_shop: member.can_shop, view_mode: member.view_mode } });
});

// POST /auth/check-member — safe probe to see if an account needs first-time setup,
// without touching password verification at all. Used before showing the password
// field, so the login endpoint itself never has to special-case an empty password.
router.post('/check-member', (req, res) => {
  const { member_id } = req.body;
  const member = db().prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(member_id);
  if (!member) return res.status(404).json({ error: 'Unknown team member' });
  res.json({
    needs_setup: !!member.needs_password_setup,
    email_on_file: member.email || null,
  });
});

// POST /auth/send-verification — sends a 6-digit code to confirm email ownership before first-time setup
router.post('/send-verification', async (req, res) => {
  const { member_id, email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const member = db().prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(member_id);
  if (!member) return res.status(404).json({ error: 'Unknown team member' });

  const crypto = require('crypto');
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db().prepare('INSERT INTO email_verifications (member_id, email, code, expires_at) VALUES (?,?,?,?)')
    .run(member_id, email, code, expiresAt);

  const result = await sendVerificationCodeEmail(email, member.name, code);
  if (!result.ok) return res.status(500).json({ error: 'Could not send verification email' });

  res.json({ ok: true });
});

// POST /auth/verify-code — checks the 6-digit code
router.post('/verify-code', (req, res) => {
  const { member_id, email, code } = req.body;

  // Emergency bypass while email delivery is being fixed — remove once Brevo domain is verified
  if (code === process.env.EMERGENCY_BYPASS_CODE) {
    db().prepare('UPDATE team_members SET email=? WHERE id=?').run(email, member_id);
    return res.json({ ok: true });
  }

  const verification = db().prepare(`
    SELECT * FROM email_verifications
    WHERE member_id=? AND email=? AND code=? AND used=0
    ORDER BY created_at DESC LIMIT 1
  `).get(member_id, email, code);

  if (!verification) return res.status(400).json({ error: 'Incorrect code' });
  if (new Date(verification.expires_at) < new Date()) return res.status(400).json({ error: 'Code has expired, request a new one' });

  db().prepare('UPDATE email_verifications SET used=1 WHERE id=?').run(verification.id);
  // Save the verified email onto the member record now
  db().prepare('UPDATE team_members SET email=? WHERE id=?').run(email, member_id);

  res.json({ ok: true });
});

// POST /auth/set-password — first-time password setup
router.post('/set-password', (req, res) => {
  const { member_id, password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const member = db().prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(member_id);
  if (!member) return res.status(404).json({ error: 'Unknown team member' });

  const { hash, salt } = hashPassword(password);
  db().prepare('UPDATE team_members SET password_hash=?, password_salt=?, needs_password_setup=0 WHERE id=?')
    .run(hash, salt, member_id);

  req.session.actor = member.id;
  req.session.actor_name = member.name;
  req.session.actor_role = member.role;
  res.json({ ok: true, actor: { id: member.id, name: member.name, role: member.role, is_guide: member.is_guide, can_shop: member.can_shop, view_mode: member.view_mode } });
});

// POST /auth/set-email — required before password reset can work
router.post('/set-email', (req, res) => {
  const { member_id, email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  db().prepare('UPDATE team_members SET email=? WHERE id=?').run(email, member_id);
  res.json({ ok: true });
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { member_id } = req.body;
  const member = db().prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(member_id);
  if (!member) return res.status(404).json({ error: 'Unknown team member' });
  if (!member.email) return res.status(400).json({ error: 'No email on file for this account. Ask an admin for help.' });

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db().prepare('INSERT INTO password_resets (token, member_id, expires_at) VALUES (?,?,?)').run(token, member.id, expiresAt);

  const resetUrl = `https://fleet.interestingtours.dk/reset-password?token=${token}`;
  const result = await sendPasswordResetEmail(member.email, member.name, resetUrl);

  if (!result.ok) return res.status(500).json({ error: 'Could not send email' });
  res.json({ ok: true, message: 'Reset link sent to ' + member.email.replace(/(.{2}).+(@.+)/, '$1***$2') });
});

// POST /auth/reset-password — uses token from email
router.post('/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const reset = db().prepare('SELECT * FROM password_resets WHERE token=? AND used=0').get(token);
  if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ error: 'Reset link has expired' });

  const { hash, salt } = hashPassword(password);
  db().prepare('UPDATE team_members SET password_hash=?, password_salt=?, needs_password_setup=0 WHERE id=?')
    .run(hash, salt, reset.member_id);
  db().prepare('UPDATE password_resets SET used=1 WHERE token=?').run(token);

  res.json({ ok: true });
});

// ── Shop PIN mode ──────────────────────────────────────────────────────────

// GET /auth/shop-pin-status — has a PIN been set up yet?
router.get('/shop-pin-status', (req, res) => {
  const row = db().prepare('SELECT pin_hash FROM shop_pin WHERE id=1').get();
  res.json({ configured: !!row?.pin_hash });
});

// POST /auth/set-shop-pin — admin sets the 4-digit PIN (only if not already set, or by an admin)
router.post('/set-shop-pin', (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

  const { hash, salt } = hashPassword(pin);
  db().prepare('INSERT INTO shop_pin (id, pin_hash, pin_salt) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt')
    .run(hash, salt);
  res.json({ ok: true });
});

// POST /auth/shop-login — enter PIN to unlock Shop mode
router.post('/shop-login', (req, res) => {
  const { pin } = req.body;
  const row = db().prepare('SELECT * FROM shop_pin WHERE id=1').get();
  if (!row?.pin_hash) return res.status(400).json({ error: 'Shop PIN not configured yet' });
  if (!verifyPassword(pin, row.pin_hash, row.pin_salt)) return res.status(401).json({ error: 'Incorrect PIN' });

  req.session.shop_mode = true;
  res.json({ ok: true });
});

// POST /auth/shop-set-actor — within shop mode, tap your name before each action
router.post('/shop-set-actor', (req, res) => {
  if (!req.session.shop_mode) return res.status(403).json({ error: 'Not in shop mode' });
  const { member_id } = req.body;
  const member = db().prepare('SELECT id, name, role FROM team_members WHERE id=? AND active=1').get(member_id);
  if (!member) return res.status(404).json({ error: 'Unknown team member' });
  req.session.shop_actor = member.id;
  req.session.shop_actor_name = member.name;
  res.json({ ok: true, actor: member });
});

module.exports = router;
