const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/schema');
const { createNotification } = require('./admin-notifs');

function db() { return getDb(); }

const INVOICES_DIR = path.join(__dirname, '../../data/invoices');
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB

function safeFilename(name) {
  return (name || 'invoice').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}

function requireSelfOrAdmin(req, res, next) {
  const actor = req.session?.actor;
  const role = req.session?.actor_role;
  if (!actor) return res.status(401).json({ error: 'Not logged in' });
  if (role === 'admin' || actor === req.params.id) return next();
  return res.status(403).json({ error: 'Not authorized' });
}

// ── Invoices ────────────────────────────────────────────────────────────

// POST /api/guides/:id/invoices — upload an invoice (base64-encoded file in body)
router.post('/:id/invoices', requireSelfOrAdmin, (req, res) => {
  const { filename, mime_type, data_base64, period_label, note } = req.body;
  if (!data_base64) return res.status(400).json({ error: 'File data required' });

  const member = db().prepare('SELECT * FROM team_members WHERE id=? AND active=1').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  let buffer;
  try {
    buffer = Buffer.from(data_base64, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid file data' });
  }
  if (buffer.length === 0) return res.status(400).json({ error: 'Empty file' });
  if (buffer.length > MAX_FILE_BYTES) return res.status(400).json({ error: 'File too large (max 15MB)' });

  const dir = path.join(INVOICES_DIR, req.params.id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${Date.now()}-${safeFilename(filename)}`;
  fs.writeFileSync(path.join(dir, stored), buffer);

  const actor = req.session?.actor || 'unknown';
  const result = db().prepare(`
    INSERT INTO guide_invoices (guide_id, original_filename, stored_filename, mime_type, size_bytes, period_label, note)
    VALUES (?,?,?,?,?,?,?)
  `).run(req.params.id, filename || stored, stored, mime_type || 'application/octet-stream', buffer.length, period_label || null, note || null);

  db().prepare(`INSERT INTO action_log (actor,action,details) VALUES (?,?,?)`)
    .run(actor, 'invoice_upload', JSON.stringify({ guide_id: req.params.id, filename, period_label }));

  res.json({ ok: true, id: result.lastInsertRowid });
});

// GET /api/guides/:id/invoices — list a guide's own invoices (self or admin)
router.get('/:id/invoices', requireSelfOrAdmin, (req, res) => {
  const rows = db().prepare(`
    SELECT id, original_filename, mime_type, size_bytes, period_label, note, uploaded_at
    FROM guide_invoices WHERE guide_id=? ORDER BY uploaded_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// GET /api/guides/invoices — admin: every invoice across all guides
router.get('/invoices', (req, res) => {
  if (req.session?.actor_role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const rows = db().prepare(`
    SELECT gi.*, tm.name as guide_name
    FROM guide_invoices gi
    JOIN team_members tm ON tm.id = gi.guide_id
    ORDER BY gi.uploaded_at DESC
  `).all();
  res.json(rows);
});

// GET /api/guides/invoices/:invoiceId/file — view/download a specific invoice
router.get('/invoices/:invoiceId/file', (req, res) => {
  const inv = db().prepare('SELECT * FROM guide_invoices WHERE id=?').get(req.params.invoiceId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const actor = req.session?.actor;
  const role = req.session?.actor_role;
  if (!actor) return res.status(401).json({ error: 'Not logged in' });
  if (role !== 'admin' && actor !== inv.guide_id) return res.status(403).json({ error: 'Not authorized' });

  const filePath = path.join(INVOICES_DIR, inv.guide_id, inv.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', inv.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeFilename(inv.original_filename)}"`);
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/guides/invoices/:invoiceId — remove an invoice (owner or admin)
router.delete('/invoices/:invoiceId', (req, res) => {
  const inv = db().prepare('SELECT * FROM guide_invoices WHERE id=?').get(req.params.invoiceId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const actor = req.session?.actor;
  const role = req.session?.actor_role;
  if (!actor) return res.status(401).json({ error: 'Not logged in' });
  if (role !== 'admin' && actor !== inv.guide_id) return res.status(403).json({ error: 'Not authorized' });

  const filePath = path.join(INVOICES_DIR, inv.guide_id, inv.stored_filename);
  try { fs.unlinkSync(filePath); } catch (e) { /* file already gone — fine */ }
  db().prepare('DELETE FROM guide_invoices WHERE id=?').run(req.params.invoiceId);
  res.json({ ok: true });
});

// ── Invoicing instructions (admin-editable text shown on every guide's profile) ──

// GET /api/guides/invoice-instructions — anyone logged in can read it
router.get('/invoice-instructions', (req, res) => {
  if (!req.session?.actor) return res.status(401).json({ error: 'Not logged in' });
  const row = db().prepare(`SELECT value FROM app_settings WHERE key='guide_invoice_instructions'`).get();
  res.json({ text: row?.value || '' });
});

// PUT /api/guides/invoice-instructions — admin only
router.put('/invoice-instructions', (req, res) => {
  if (req.session?.actor_role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const { text } = req.body;
  const actor = req.session?.actor || 'unknown';
  db().prepare(`
    INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('guide_invoice_instructions', ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by
  `).run(text || '', actor);
  res.json({ ok: true });
});

// ── Unavailability ───────────────────────────────────────────────────────

// GET /api/guides/unavailability — all periods (admin) or own (guide)
router.get('/unavailability', (req, res) => {
  const actor = req.session?.actor;
  const role = req.session?.actor_role;
  if (!actor) return res.status(401).json({ error: 'Not logged in' });

  const rows = role === 'admin'
    ? db().prepare(`SELECT gu.*, tm.name as guide_name FROM guide_unavailability gu JOIN team_members tm ON tm.id=gu.guide_id ORDER BY gu.from_dt`).all()
    : db().prepare(`SELECT * FROM guide_unavailability WHERE guide_id=? ORDER BY from_dt`).all(actor);

  res.json(rows);
});

// POST /api/guides/unavailability — add a period (self or admin)
router.post('/unavailability', (req, res) => {
  const actor = req.session?.actor;
  const role = req.session?.actor_role;
  if (!actor) return res.status(401).json({ error: 'Not logged in' });

  const guide_id = role === 'admin' && req.body.guide_id ? req.body.guide_id : actor;
  const { from_dt, to_dt, reason } = req.body;

  if (!from_dt || !to_dt) return res.status(400).json({ error: 'from_dt and to_dt required' });
  if (from_dt >= to_dt) return res.status(400).json({ error: 'End must be after start' });

  // Check for assigned tours in this window
  const guide = db().prepare('SELECT name FROM team_members WHERE id=?').get(guide_id);
  const conflicts = db().prepare(`
    SELECT feed_id, start_date, start_time, end_time FROM tour_availabilities
    WHERE guide IS NOT NULL
      AND datetime(replace(replace(start_at,'T',' '),'Z','')) < datetime(?)
      AND datetime(replace(replace(end_at,'T',' '),'Z','')) > datetime(?)
      AND start_at > datetime('now')
  `).all(to_dt, from_dt).filter(t => {
    const g = db().prepare('SELECT name FROM team_members WHERE id=?').get(guide_id);
    return t.guide && g && (t.guide === g.name || t.guide.includes(g.name));
  });

  // Re-do with guide name match in JS since SQLite can't do fuzzy match easily
  const guideName = guide?.name;
  const allConflicts = db().prepare(`
    SELECT feed_id, start_date, start_time, end_time, guide FROM tour_availabilities
    WHERE guide IS NOT NULL
      AND datetime(replace(replace(start_at,'T',' '),'Z','')) < datetime(?)
      AND datetime(replace(replace(end_at,'T',' '),'Z','')) > datetime(?)
      AND start_at > datetime('now')
  `).all(to_dt, from_dt).filter(t => guideName && (t.guide === guideName || t.guide.toLowerCase().includes(guideName.toLowerCase().split(' ')[0])));

  if (allConflicts.length > 0) {
    const list = allConflicts.map(t => `${t.feed_id} on ${t.start_date} at ${t.start_time}`).join(', ');
    return res.status(409).json({
      error: `You have ${allConflicts.length} tour${allConflicts.length > 1 ? 's' : ''} assigned in this period: ${list}. Please contact Federico to reassign before marking yourself unavailable.`,
      conflicts: allConflicts,
    });
  }

  const result = db().prepare(`INSERT INTO guide_unavailability (guide_id, from_dt, to_dt, reason) VALUES (?,?,?,?)`).run(guide_id, from_dt, to_dt, reason || null);

  // Notify admins
  const notifGuideName = guide?.name || guide_id;
  const label = `${from_dt.substring(0,10)} → ${to_dt.substring(0,10)}`;
  createNotification('unavailability', `${notifGuideName} is unavailable: ${label}`, reason || null, result.lastInsertRowid);

  res.json({ ok: true, id: result.lastInsertRowid });
});

// DELETE /api/guides/unavailability/:id — remove (self or admin)
router.delete('/unavailability/:id', (req, res) => {
  const actor = req.session?.actor;
  const role = req.session?.actor_role;
  if (!actor) return res.status(401).json({ error: 'Not logged in' });

  const row = db().prepare('SELECT * FROM guide_unavailability WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (role !== 'admin' && row.guide_id !== actor) return res.status(403).json({ error: 'Not authorized' });

  db().prepare('DELETE FROM guide_unavailability WHERE id=?').run(req.params.id);
  db().prepare(`UPDATE admin_notifications SET dismissed=1 WHERE type='unavailability' AND ref_id=? AND dismissed=0`).run(String(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
