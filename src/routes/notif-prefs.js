const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { getActor } = require('../actor');

function db() { return getDb(); }

const GUIDE_NOTIF_TYPES = [
  { id: 'tour_assigned',     label: 'New tour assigned to you' },
  { id: 'first_booking',     label: 'First booking on your tour' },
  { id: 'zero_bookings',     label: 'All bookings cancelled (slot still open)' },
  { id: 'tour_cancelled',    label: 'Tour cancelled' },
  { id: 'new_review',        label: 'New 5⭐ review' },
  { id: 'tour_reminder',     label: 'Tour reminder (16h before)' },
  { id: 'invoice_reminder',  label: 'Invoice reminder (20th of month)' },
];

// GET /api/notif-prefs — get current user's preferences
router.get('/', (req, res) => {
  const { id: actor } = getActor(req);
  if (!actor) return res.status(401).json({ error: 'Not logged in' });

  const rows = db().prepare('SELECT notification_type, enabled FROM notification_prefs WHERE member_id=?').all(actor);
  const map = Object.fromEntries(rows.map(r => [r.notification_type, !!r.enabled]));

  // Default to enabled for any type not yet in DB
  const result = GUIDE_NOTIF_TYPES.map(t => ({
    id: t.id,
    label: t.label,
    enabled: map[t.id] !== undefined ? map[t.id] : true,
  }));

  res.json(result);
});

// PUT /api/notif-prefs/:type — toggle a single notification type
router.put('/:type', (req, res) => {
  const { id: actor } = getActor(req);
  if (!actor) return res.status(401).json({ error: 'Not logged in' });

  const { enabled } = req.body;
  const type = req.params.type;

  if (!GUIDE_NOTIF_TYPES.find(t => t.id === type)) {
    return res.status(400).json({ error: 'Unknown notification type' });
  }

  const before = db().prepare('SELECT enabled FROM notification_prefs WHERE member_id=? AND notification_type=?').get(actor, type);
  const oldEnabled = before ? !!before.enabled : true; // default is enabled

  db().prepare(`
    INSERT INTO notification_prefs (member_id, notification_type, enabled)
    VALUES (?, ?, ?)
    ON CONFLICT(member_id, notification_type) DO UPDATE SET enabled=excluded.enabled
  `).run(actor, type, enabled ? 1 : 0);

  db().prepare(`INSERT INTO action_log (actor, action, details) VALUES (?,?,?)`)
    .run(actor, 'notif_pref_toggled', JSON.stringify({ type, old: oldEnabled, new: !!enabled }));

  res.json({ ok: true });
});

module.exports = { router, GUIDE_NOTIF_TYPES };
