const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

function db() { return getDb(); }

function requireAdmin(req, res, next) {
  if (req.session?.actor_role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// GET /api/admin-notifs — all undismissed notifications + count
router.get('/', requireAdmin, (req, res) => {
  const rows = db().prepare(`SELECT * FROM admin_notifications WHERE dismissed=0 ORDER BY created_at DESC`).all();
  res.json({ count: rows.length, notifications: rows });
});

// POST /api/admin-notifs/dismiss/:id — dismiss one
router.post('/dismiss/:id', requireAdmin, (req, res) => {
  db().prepare(`UPDATE admin_notifications SET dismissed=1 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin-notifs/dismiss-all — dismiss all
router.post('/dismiss-all', requireAdmin, (req, res) => {
  db().prepare(`UPDATE admin_notifications SET dismissed=1 WHERE dismissed=0`).run();
  res.json({ ok: true });
});

// Internal helper — called by other routes to create notifications
function createNotification(type, title, body, ref_id) {
  // Avoid duplicates for the same ref_id + type
  if (ref_id) {
    const existing = db().prepare(`SELECT id FROM admin_notifications WHERE type=? AND ref_id=? AND dismissed=0`).get(type, String(ref_id));
    if (existing) return;
  }
  db().prepare(`INSERT INTO admin_notifications (type, title, body, ref_id) VALUES (?,?,?,?)`).run(type, title, body || null, ref_id ? String(ref_id) : null);
}

module.exports = { router, createNotification };
