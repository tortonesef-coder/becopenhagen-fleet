const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
function db() { return getDb(); }

// GET /api/fleet/bikes — all bikes including inactive
router.get('/bikes', (req, res) => {
  const bikes = db().prepare(`
    SELECT b.*, bt.label as type_label, bt.rental_value_dkk,
      bs.status, bc.has_child_seat, bc.has_toddler_seat
    FROM bikes b
    JOIN bike_types bt ON bt.id = b.type_id
    LEFT JOIN bike_status bs ON bs.bike_id = b.id
    LEFT JOIN bike_configurations bc ON bc.bike_id = b.id
    ORDER BY b.type_id, b.id
  `).all();
  res.json(bikes);
});

// GET /api/fleet/types
router.get('/types', (req, res) => {
  res.json(db().prepare('SELECT * FROM bike_types ORDER BY sort_order').all());
});

// POST /api/fleet/bikes — add a new bike
router.post('/bikes', (req, res) => {
  const { id, type_id, name, frame_number, model, frame_size, key_number, gender, notes } = req.body;
  const actor = req.session?.actor || 'unknown';
  if (!id || !type_id) return res.status(400).json({ error: 'id and type_id required' });
  if (db().prepare('SELECT id FROM bikes WHERE id=?').get(id))
    return res.status(400).json({ error: `Bike ${id} already exists` });

  db().prepare(`INSERT INTO bikes (id,type_id,name,frame_number,model,frame_size,key_number,gender,notes,active)
    VALUES (?,?,?,?,?,?,?,?,?,1)`)
    .run(id, type_id, name||null, frame_number||null, model||null, frame_size||null, key_number||null, gender||null, notes||null);

  db().prepare(`INSERT INTO bike_status (bike_id,status,updated_by) VALUES (?,'available',?)`)
    .run(id, actor);

  db().prepare(`INSERT INTO bike_configurations (bike_id,has_child_seat,has_toddler_seat) VALUES (?,?,?)`)
    .run(id, type_id==='AC'?1:0, type_id==='AT'?1:0);

  db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`)
    .run(actor, 'bike_added', id, JSON.stringify({type_id,name,frame_size,key_number}));

  res.json({ ok: true });
});

// PATCH /api/fleet/bikes/:id — edit a bike
router.patch('/bikes/:id', (req, res) => {
  const { type_id, name, frame_number, model, frame_size, key_number, gender, notes, active } = req.body;
  const actor = req.session?.actor || 'unknown';
  const bike = db().prepare('SELECT * FROM bikes WHERE id=?').get(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  const fields = [];
  const vals = [];
  if (type_id !== undefined)      { fields.push('type_id=?');      vals.push(type_id); }
  if (name !== undefined)         { fields.push('name=?');          vals.push(name||null); }
  if (frame_number !== undefined) { fields.push('frame_number=?');  vals.push(frame_number||null); }
  if (model !== undefined)        { fields.push('model=?');         vals.push(model||null); }
  if (frame_size !== undefined)   { fields.push('frame_size=?');    vals.push(frame_size||null); }
  if (key_number !== undefined)   { fields.push('key_number=?');    vals.push(key_number||null); }
  if (gender !== undefined)       { fields.push('gender=?');        vals.push(gender||null); }
  if (notes !== undefined)        { fields.push('notes=?');         vals.push(notes||null); }
  if (active !== undefined)       { fields.push('active=?');        vals.push(active?1:0); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  db().prepare(`UPDATE bikes SET ${fields.join(',')} WHERE id=?`).run(...vals, req.params.id);

  db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`)
    .run(actor, active===false?'bike_retired':'bike_edited', req.params.id, JSON.stringify(req.body));

  res.json({ ok: true });
});

// PATCH /api/fleet/types/:id — edit bike type rental value / demand
router.patch('/types/:id', (req, res) => {
  const { rental_value_dkk, demand_level } = req.body;
  const actor = req.session?.actor || 'unknown';
  if (rental_value_dkk !== undefined)
    db().prepare('UPDATE bike_types SET rental_value_dkk=? WHERE id=?').run(rental_value_dkk, req.params.id);
  if (demand_level !== undefined)
    db().prepare('UPDATE bike_types SET demand_level=? WHERE id=?').run(demand_level, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
