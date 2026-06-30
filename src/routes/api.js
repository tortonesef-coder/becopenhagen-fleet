const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

function db() { return getDb(); }

router.get('/availability', (req, res) => {
  const rows = db().prepare(`
    SELECT bt.id as type_id, bt.label, bt.sort_order,
      COUNT(b.id) as total,
      SUM(CASE WHEN bs.status='available' THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN bs.status='out' THEN 1 ELSE 0 END) as out,
      SUM(CASE WHEN bs.status='reserved' THEN 1 ELSE 0 END) as reserved,
      SUM(CASE WHEN bs.status='repair' THEN 1 ELSE 0 END) as repair,
      SUM(CASE WHEN bs.status='missing' THEN 1 ELSE 0 END) as missing,
      SUM(CASE WHEN bs.status='city' THEN 1 ELSE 0 END) as city
    FROM bike_types bt
    LEFT JOIN bikes b ON b.type_id=bt.id AND b.active=1
    LEFT JOIN bike_status bs ON bs.bike_id=b.id
    GROUP BY bt.id ORDER BY bt.sort_order
  `).all();
  const adultRows = rows.filter(r => ['A','AC','AT'].includes(r.type_id));
  const adult_pool = {
    total: adultRows.reduce((s,r)=>s+(r.total||0),0),
    available: adultRows.reduce((s,r)=>s+(r.available||0),0)
  };
  res.json({ types: rows, adult_pool });
});

router.get('/bikes', (req, res) => {
  const { type, status, search } = req.query;
  let sql = `
    SELECT b.*, bt.label as type_label,
      bs.status, bs.assigned_to, bs.assignment_type,
      bs.customer_name, bs.out_since, bs.return_due,
      bs.fareharbor_booking_ref, bs.note as status_note,
      bs.location_lat, bs.location_lng, bs.location_address,
      bs.updated_by, bs.updated_at,
      bc.has_child_seat, bc.has_toddler_seat,
      (SELECT COUNT(*) FROM repair_tickets rt WHERE rt.bike_id=b.id AND rt.status!='done') as open_tickets
    FROM bikes b
    JOIN bike_types bt ON bt.id=b.type_id
    LEFT JOIN bike_status bs ON bs.bike_id=b.id
    LEFT JOIN bike_configurations bc ON bc.bike_id=b.id
    WHERE b.active=1
  `;
  const params = [];
  if (type)   { sql += ' AND b.type_id=?'; params.push(type); }
  if (status) { sql += ' AND bs.status=?'; params.push(status); }
  if (search) {
    sql += ' AND (b.id LIKE ? OR b.name LIKE ? OR bs.customer_name LIKE ? OR bs.assigned_to LIKE ?)';
    const s = `%${search}%`; params.push(s,s,s,s);
  }
  sql += ' ORDER BY b.type_id, b.id';
  res.json(db().prepare(sql).all(...params));
});

router.get('/bikes/:id', (req, res) => {
  const bike = db().prepare(`
    SELECT b.*, bt.label as type_label,
      bs.status, bs.assigned_to, bs.assignment_type,
      bs.customer_name, bs.out_since, bs.return_due,
      bs.fareharbor_booking_ref, bs.note as status_note,
      bs.location_lat, bs.location_lng, bs.location_address,
      bc.has_child_seat, bc.has_toddler_seat
    FROM bikes b
    JOIN bike_types bt ON bt.id=b.type_id
    LEFT JOIN bike_status bs ON bs.bike_id=b.id
    LEFT JOIN bike_configurations bc ON bc.bike_id=b.id
    WHERE b.id=?
  `).get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });
  const tickets = db().prepare(`SELECT * FROM repair_tickets WHERE bike_id=? ORDER BY created_at DESC LIMIT 10`).all(req.params.id);
  const log = db().prepare(`SELECT * FROM action_log WHERE bike_id=? ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  res.json({ ...bike, tickets, log });
});

router.post('/bikes/:id/checkout', (req, res) => {
  const { assigned_to, assignment_type, customer_name, fareharbor_booking_ref, return_due, note, force } = req.body;
  const actor = req.session?.actor || 'unknown';
  const bike = db().prepare('SELECT * FROM bikes WHERE id=? AND active=1').get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });
  const status = db().prepare('SELECT status FROM bike_status WHERE bike_id=?').get(req.params.id);
  if (status?.status === 'out' && !force) return res.status(400).json({ error: 'Bike already checked out' });
  if (status?.status === 'repair' && !force) return res.status(400).json({ error: 'Bike is in repair' });

  db().prepare(`UPDATE bike_status SET status='out', assigned_to=?, assignment_type=?, customer_name=?,
    fareharbor_booking_ref=?, out_since=datetime('now'), return_due=?, note=?,
    location_lat=NULL, location_lng=NULL, location_address=NULL,
    updated_at=datetime('now'), updated_by=? WHERE bike_id=?`)
    .run(assigned_to||null, assignment_type||'rental', customer_name||null,
      fareharbor_booking_ref||null, return_due||null, note||null, actor, req.params.id);

  db().prepare(`INSERT INTO action_log (actor,action,bike_id,booking_ref,details) VALUES (?,?,?,?,?)`)
    .run(actor, 'checkout', req.params.id, fareharbor_booking_ref||null,
      JSON.stringify({assigned_to, assignment_type, customer_name, note}));
  res.json({ ok: true });
});

router.post('/bikes/:id/return', (req, res) => {
  const { note, new_status } = req.body;
  const actor = req.session?.actor || 'unknown';
  const finalStatus = new_status || 'available';

  const bike = db().prepare('SELECT * FROM bikes WHERE id=? AND active=1').get(req.params.id);
  if (!bike) return res.status(404).json({ error: `Bike ${req.params.id} does not exist` });

  const prev = db().prepare('SELECT * FROM bike_status WHERE bike_id=?').get(req.params.id);

  db().prepare(`UPDATE bike_status SET status=?, assigned_to=NULL, assignment_type=NULL,
    customer_name=NULL, fareharbor_booking_ref=NULL, out_since=NULL, return_due=NULL,
    location_lat=NULL, location_lng=NULL, location_address=NULL,
    note=?, updated_at=datetime('now'), updated_by=? WHERE bike_id=?`)
    .run(finalStatus, note||null, actor, req.params.id);

  db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`)
    .run(actor, 'return', req.params.id,
      JSON.stringify({prev_assigned_to: prev?.assigned_to, note, new_status: finalStatus}));
  res.json({ ok: true });
});

router.post('/bikes/:id/city', (req, res) => {
  const { note, location_lat, location_lng, location_address, problem_categories, create_ticket } = req.body;
  const actor = req.session?.actor || 'unknown';
  const bike = db().prepare('SELECT * FROM bikes WHERE id=? AND active=1').get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  db().prepare(`UPDATE bike_status SET status='city', assigned_to='In city', assignment_type='city',
    customer_name=NULL, out_since=datetime('now'), note=?,
    location_lat=?, location_lng=?, location_address=?,
    updated_at=datetime('now'), updated_by=? WHERE bike_id=?`)
    .run(note||null, location_lat||null, location_lng||null, location_address||null, actor, req.params.id);

  db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`)
    .run(actor, 'city', req.params.id,
      JSON.stringify({note, location_lat, location_lng, location_address, problem_categories}));

  if (create_ticket) {
    const cats = Array.isArray(problem_categories) ? problem_categories : [];
    const problem = [cats.join(', '), note].filter(Boolean).join(' — ') || 'Left in city';
    db().prepare(`INSERT INTO repair_tickets (bike_id,reported_by,problem,problem_categories,can_rent,status) VALUES (?,?,?,?,0,'open')`)
      .run(req.params.id, actor, problem, JSON.stringify(cats));
  }
  res.json({ ok: true });
});

router.post('/bikes/bulk-return', (req, res) => {
  const { bike_ids, note } = req.body;
  const actor = req.session?.actor || 'unknown';
  if (!Array.isArray(bike_ids) || bike_ids.length === 0)
    return res.status(400).json({ error: 'No bike IDs provided' });
  const results = [];
  const upd = db().prepare(`UPDATE bike_status SET status='available', assigned_to=NULL, assignment_type=NULL,
    customer_name=NULL, fareharbor_booking_ref=NULL, out_since=NULL, return_due=NULL,
    location_lat=NULL, location_lng=NULL, location_address=NULL,
    note=NULL, updated_at=datetime('now'), updated_by=? WHERE bike_id=?`);
  const log = db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`);
  for (const id of bike_ids) {
    const bike = db().prepare('SELECT id FROM bikes WHERE id=? AND active=1').get(id);
    if (!bike) { results.push({id, ok:false, error:'Not found'}); continue; }
    upd.run(actor, id);
    log.run(actor, 'bulk_return', id, JSON.stringify({note}));
    results.push({id, ok:true});
  }
  res.json({ results });
});

router.get('/today', (req, res) => {
  const today = new Date().toISOString().substring(0,10);
  const checkouts = db().prepare(`
    SELECT al.*, b.type_id, bt.label as type_label
    FROM action_log al
    LEFT JOIN bikes b ON b.id=al.bike_id
    LEFT JOIN bike_types bt ON bt.id=b.type_id
    WHERE al.action IN ('checkout','bulk_return','return','city','repair_ticket')
    AND date(al.created_at)=? ORDER BY al.created_at DESC
  `).all(today);
  const pending = db().prepare(`SELECT * FROM pending_assignments WHERE status='pending' AND (booking_date IS NULL OR booking_date >= date('now')) ORDER BY booking_date, start_time LIMIT 10`).all();
  res.json({ checkouts, pending });
});

router.get('/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const rows = db().prepare(`
    SELECT al.*, b.type_id, bt.label as type_label
    FROM action_log al
    LEFT JOIN bikes b ON b.id=al.bike_id
    LEFT JOIN bike_types bt ON bt.id=b.type_id
    ORDER BY al.created_at DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

router.get('/team', (req, res) => {
  res.json(db().prepare('SELECT * FROM team_members WHERE active=1 ORDER BY role,name').all());
});


// GET /api/assignments — all pending
router.get('/assignments', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM pending_assignments WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY booking_date, start_time';
  res.json(db().prepare(sql).all(...params));
});

// POST /api/assignments/:id/assign — mark assigned or dismissed
router.post('/assignments/:id/assign', (req, res) => {
  const { bike_ids, note, dismissed } = req.body;
  const actor = req.session?.actor || 'unknown';
  const status = dismissed ? 'cancelled' : 'assigned';
  db().prepare(`UPDATE pending_assignments SET status=?, assigned_at=datetime('now'), assigned_by=?, notes=? WHERE id=?`)
    .run(status, actor, note||null, req.params.id);
  res.json({ ok: true });
});

// POST /api/log/undo — delete recent log entries for a bike (used by undo)
router.post('/log/undo', (req, res) => {
  const { bike_id, actions, limit } = req.body;
  if (!bike_id) return res.status(400).json({ error: 'bike_id required' });
  const n = limit || 2;
  const rows = db().prepare(
    `SELECT id FROM action_log WHERE bike_id=? ORDER BY created_at DESC LIMIT ?`
  ).all(bike_id, n);
  rows.forEach(r => db().prepare('DELETE FROM action_log WHERE id=?').run(r.id));
  res.json({ ok: true, deleted: rows.length });
});

// POST /api/log/attribute — retroactively assign the real actor name to recent shop-mode actions
router.post('/log/attribute', (req, res) => {
  const { bike_ids, actor_name } = req.body;
  if (!Array.isArray(bike_ids) || !actor_name) return res.status(400).json({ error: 'bike_ids and actor_name required' });

  const upd = db().prepare(`
    UPDATE action_log SET actor=?
    WHERE bike_id=? AND actor='shop'
    AND id = (SELECT MAX(id) FROM action_log WHERE bike_id=? AND actor='shop')
  `);
  bike_ids.forEach(id => upd.run(actor_name, id, id));

  res.json({ ok: true });
});

// GET /api/fareharbor-agent-log — recent agent activity (successes + failures)
router.get('/fareharbor-agent-log', (req, res) => {
  const rows = db().prepare(`
    SELECT * FROM action_log
    WHERE action IN ('fareharbor_booking_created','fareharbor_booking_failed')
    ORDER BY created_at DESC LIMIT 50
  `).all();
  res.json(rows.map(r => ({ ...r, details: JSON.parse(r.details || '{}') })));
});

module.exports = router;
