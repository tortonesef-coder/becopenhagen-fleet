const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

function db() { return getDb(); }

// ── Priority scoring engine ───────────────────────────────────────────────
function calcPriorityScore(ticket, bikeType) {
  const rentalValue = bikeType?.rental_value_dkk || 150;
  const daysWaiting = (Date.now() - new Date(ticket.created_at + 'Z').getTime()) / 86400000;

  // Scarcity: what % of this bike type is unavailable
  const typeStats = db().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN bs.status NOT IN ('available') THEN 1 ELSE 0 END) as unavailable
    FROM bikes b
    JOIN bike_status bs ON bs.bike_id = b.id
    WHERE b.type_id = ? AND b.active = 1
  `).get(bikeType?.id || '');
  const scarcityPct = typeStats?.total > 0
    ? (typeStats.unavailable / typeStats.total)
    : 0.5;

  // Opportunity cost: daily rental value × days waiting × scarcity
  const opportunityCost = rentalValue * Math.max(daysWaiting, 0.1) * (0.3 + scarcityPct * 0.7);

  // Ease bonus: low complexity = small boost
  const complexityMap = { 1: 1.2, 2: 1.1, 3: 1.0, 4: 0.95, 5: 0.9 };
  const easeBonus = complexityMap[ticket.complexity] || 1.0;

  // Booking pressure: placeholder 1.0 until FareHarbor connected
  const bookingPressure = 1.0;

  const raw = opportunityCost * easeBonus * bookingPressure;
  return Math.round(raw * 10) / 10;
}

function refreshPriorityScores() {
  const tickets = db().prepare(`
    SELECT rt.*, bt.rental_value_dkk, bt.id as type_id, bt.label as type_label
    FROM repair_tickets rt
    JOIN bikes b ON b.id = rt.bike_id
    JOIN bike_types bt ON bt.id = b.type_id
    WHERE rt.status = 'open'
  `).all();

  const upd = db().prepare(`UPDATE repair_tickets SET priority_score=? WHERE id=?`);
  tickets.forEach(t => {
    const score = calcPriorityScore(t, { id: t.type_id, rental_value_dkk: t.rental_value_dkk });
    upd.run(score, t.id);
  });
}

// ── GET /api/repairs ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { status } = req.query;
  refreshPriorityScores();

  let sql = `
    SELECT rt.*,
      b.type_id, bt.label as type_label, bt.rental_value_dkk,
      b.name as bike_name, b.frame_size,
      bs.status as bike_status,
      ROUND((julianday('now') - julianday(rt.created_at)) * 24, 1) as hours_waiting,
      CASE WHEN rt.resolved_at IS NOT NULL
        THEN ROUND((julianday(rt.resolved_at) - julianday(rt.created_at)) * 24, 1)
        ELSE NULL
      END as hours_to_resolve
    FROM repair_tickets rt
    JOIN bikes b ON b.id = rt.bike_id
    JOIN bike_types bt ON bt.id = b.type_id
    LEFT JOIN bike_status bs ON bs.bike_id = rt.bike_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND rt.status=?'; params.push(status); }
  sql += ' ORDER BY rt.priority_score DESC, rt.created_at ASC';

  res.json(db().prepare(sql).all(...params));
});

// ── GET /api/repairs/stats ────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  // Problem frequency
  const allTickets = db().prepare(`SELECT problem_categories, created_at, resolved_at, status FROM repair_tickets`).all();

  const catCount = {};
  const catResolveHours = {};

  allTickets.forEach(t => {
    let cats = [];
    try { cats = JSON.parse(t.problem_categories || '[]'); } catch(e) {}
    if (!cats.length && t.problem_categories) cats = [t.problem_categories];

    const hoursToResolve = t.estimated_hours
      ? parseFloat(t.estimated_hours)
      : t.resolved_at
      ? (new Date(t.resolved_at + 'Z') - new Date(t.created_at + 'Z')) / 3600000
      : null;

    cats.forEach(cat => {
      catCount[cat] = (catCount[cat] || 0) + 1;
      if (hoursToResolve !== null) {
        if (!catResolveHours[cat]) catResolveHours[cat] = [];
        catResolveHours[cat].push(hoursToResolve);
      }
    });
  });

  const problemFrequency = Object.entries(catCount)
    .map(([cat, count]) => ({
      category: cat,
      count,
      avg_hours: catResolveHours[cat]
        ? Math.round(catResolveHours[cat].reduce((a,b)=>a+b,0) / catResolveHours[cat].length * 10) / 10
        : null,
    }))
    .sort((a,b) => b.count - a.count);

  // Avg resolution time overall
  const resolved = db().prepare(`
    SELECT
      ROUND(AVG(CASE WHEN estimated_hours IS NOT NULL THEN estimated_hours
        ELSE (julianday(resolved_at) - julianday(created_at)) * 24 END), 1) as avg_hours,
      COUNT(*) as total,
      ROUND(AVG(estimated_hours), 1) as avg_actual_hours
    FROM repair_tickets WHERE status='done' AND resolved_at IS NOT NULL
  `).get();

  // Resolution time by bike type
  const byType = db().prepare(`
    SELECT bt.label, bt.id as type_id,
      COUNT(*) as ticket_count,
      ROUND(AVG(CASE WHEN rt.estimated_hours IS NOT NULL THEN rt.estimated_hours
        WHEN rt.resolved_at IS NOT NULL THEN (julianday(rt.resolved_at) - julianday(rt.created_at)) * 24
        ELSE NULL END), 1) as avg_hours
    FROM repair_tickets rt
    JOIN bikes b ON b.id = rt.bike_id
    JOIN bike_types bt ON bt.id = b.type_id
    GROUP BY bt.id ORDER BY ticket_count DESC
  `).all();

  // Worst offenders — bikes with most tickets
  const worstBikes = db().prepare(`
    SELECT rt.bike_id, b.name as bike_name, bt.label as type_label,
      COUNT(*) as ticket_count,
      SUM(CASE WHEN rt.status='open' THEN 1 ELSE 0 END) as open_tickets
    FROM repair_tickets rt
    JOIN bikes b ON b.id = rt.bike_id
    JOIN bike_types bt ON bt.id = b.type_id
    GROUP BY rt.bike_id ORDER BY ticket_count DESC LIMIT 10
  `).all();

  // Cost of downtime — bikes currently in repair × daily rental value
  const currentDowntime = db().prepare(`
    SELECT bt.label, bt.rental_value_dkk,
      COUNT(*) as bikes_down,
      ROUND(AVG((julianday('now') - julianday(rt.created_at))), 1) as avg_days_waiting
    FROM repair_tickets rt
    JOIN bikes b ON b.id = rt.bike_id
    JOIN bike_types bt ON bt.id = b.type_id
    WHERE rt.status = 'open' AND rt.can_rent = 0
    GROUP BY bt.id
  `).all();

  // Revenue lost weighted by scarcity — only meaningful when most bikes of a type are down
  const dailyRevenueLost = currentDowntime.reduce((sum, row) => {
    const typeTotal = db().prepare(
      'SELECT COUNT(*) as n FROM bikes WHERE type_id=(SELECT type_id FROM bikes WHERE id=(SELECT bike_id FROM repair_tickets WHERE status=\'open\' AND can_rent=0 LIMIT 1)) AND active=1'
    );
    // Simple: bikes_down / (bikes_down + available) as scarcity weight
    const scarcityWeight = Math.min(1, row.bikes_down / Math.max(row.bikes_down, 1));
    return sum + (row.bikes_down * row.rental_value_dkk * (row.avg_days_waiting || 0) * scarcityWeight);
  }, 0);

  // Open vs resolved count
  const counts = db().prepare(`
    SELECT status, COUNT(*) as count FROM repair_tickets GROUP BY status
  `).all();

  res.json({
    problem_frequency: problemFrequency,
    resolution_overall: resolved,
    resolution_by_type: byType,
    worst_bikes: worstBikes,
    current_downtime: currentDowntime,
    daily_revenue_lost: Math.round(dailyRevenueLost),
    ticket_counts: counts,
  });
});

// ── POST /api/repairs ─────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { bike_id, problem, problem_categories, can_rent, complexity } = req.body;
  const actor = req.session?.actor || 'unknown';
  if (!bike_id || !problem) return res.status(400).json({ error: 'bike_id and problem required' });

  const cats = Array.isArray(problem_categories) ? problem_categories : [];
  const result = db().prepare(`
    INSERT INTO repair_tickets (bike_id, reported_by, problem, problem_categories, can_rent, complexity, status)
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `).run(bike_id, actor, problem, JSON.stringify(cats), can_rent ? 1 : 0, complexity || 3);

  db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`)
    .run(actor, 'repair_ticket', bike_id, JSON.stringify({ problem, can_rent, ticket_id: result.lastInsertRowid }));

  res.json({ ok: true, ticket_id: result.lastInsertRowid });
});

// ── PATCH /api/repairs/:id ────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  const { complexity, can_rent, problem } = req.body;
  const actor = req.session?.actor || 'unknown';
  const ticket = db().prepare('SELECT * FROM repair_tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (complexity !== undefined) db().prepare('UPDATE repair_tickets SET complexity=? WHERE id=?').run(complexity, req.params.id);
  if (can_rent !== undefined) db().prepare('UPDATE repair_tickets SET can_rent=? WHERE id=?').run(can_rent ? 1 : 0, req.params.id);
  if (problem !== undefined) db().prepare('UPDATE repair_tickets SET problem=? WHERE id=?').run(problem, req.params.id);

  db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`)
    .run(actor, 'ticket_updated', ticket.bike_id, JSON.stringify({ ticket_id: req.params.id, complexity, can_rent }));

  res.json({ ok: true });
});

// ── POST /api/repairs/:id/resolve ─────────────────────────────────────────
router.post('/:id/resolve', (req, res) => {
  const { resolution_note, new_bike_status, actual_hours } = req.body;
  const actor = req.session?.actor || 'unknown';

  db().prepare(`
    UPDATE repair_tickets SET status='done', resolved_by=?, resolved_at=datetime('now'),
    resolution_note=?, estimated_hours=? WHERE id=?
  `).run(actor, resolution_note || null, actual_hours || null, req.params.id);

  const ticket = db().prepare('SELECT bike_id FROM repair_tickets WHERE id=?').get(req.params.id);
  if (ticket && new_bike_status) {
    db().prepare(`UPDATE bike_status SET status=?, updated_at=datetime('now'), updated_by=? WHERE bike_id=?`)
      .run(new_bike_status, actor, ticket.bike_id);
    db().prepare(`INSERT INTO action_log (actor,action,bike_id,details) VALUES (?,?,?,?)`)
      .run(actor, 'ticket_resolved', ticket.bike_id, JSON.stringify({ ticket_id: req.params.id, resolution_note, new_bike_status }));
  }
  res.json({ ok: true });
});

module.exports = router;
