const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const path = require('path');
const { getDb } = require('../db/schema');

function db() { return getDb(); }

const AGENT_SCRIPT = path.join(__dirname, '../../scripts/fareharbor-agent/create-booking.js');

// Map number of rental days to the matching FareHarbor item ID
const RENTAL_ITEM_BY_DAYS = {
  1: '190975', 2: '190977', 3: '190978', 4: '190980',
  5: '651114', 6: '651124', 7: '190983', 8: '651812',
  9: '652669', 10: '652693', 11: '652695', 12: '652697',
  13: '652699', 14: '652703',
};

function runAgentScript(args) {
  return new Promise((resolve, reject) => {
    const argv = Object.entries(args)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `--${k}=${v}`);

    execFile('node', [AGENT_SCRIPT, ...argv], {
      cwd: path.dirname(AGENT_SCRIPT),
      timeout: 90000, // 90s — booking flow takes a while (two browser contexts, several page loads)
      env: process.env, // inherit FAREHARBOR_EMAIL / FAREHARBOR_PASSWORD from /etc/environment
    }, (error, stdout, stderr) => {
      console.log('FareHarbor agent stdout:', stdout);
      if (stderr) console.error('FareHarbor agent stderr:', stderr);

      if (error) {
        // Pull out the FATAL line if present, for a clean user-facing message
        const fatalMatch = stdout.match(/FATAL: (.+)/) || stderr.match(/FATAL: (.+)/);
        return reject(new Error(fatalMatch ? fatalMatch[1] : error.message));
      }

      const resultMatch = stdout.match(/Result: ({[\s\S]*})/);
      if (!resultMatch) return reject(new Error('Agent ran but no result found in output.'));

      try {
        const result = JSON.parse(resultMatch[1]);
        resolve(result);
      } catch (e) {
        reject(new Error('Could not parse agent result: ' + e.message));
      }
    });
  });
}

// POST /api/fareharbor-agent/create-booking
router.post('/create-booking', async (req, res) => {
  const { customer_name, phone, email, days, payment_method, bike_ids, start_datetime } = req.body;
  const actor = req.session?.actor || 'unknown';

  if (!customer_name) return res.status(400).json({ error: 'Customer name required' });
  if (!Array.isArray(bike_ids) || bike_ids.length === 0) return res.status(400).json({ error: 'At least one bike required' });

  // Look up each bike's type to determine its FareHarbor resource label,
  // and group bikes by type since each type needs its own quantity+IDs on the form.
  const bikesByType = {};
  for (const bikeId of bike_ids) {
    const bike = db().prepare(`
      SELECT b.id, bt.id as type_id, bt.fareharbor_resource
      FROM bikes b JOIN bike_types bt ON bt.id = b.type_id
      WHERE b.id = ?
    `).get(bikeId);
    if (!bike) return res.status(404).json({ error: `Bike ${bikeId} not found` });
    if (!bike.fareharbor_resource) return res.status(400).json({ error: `Bike type ${bike.type_id} has no FareHarbor resource mapping configured` });

    if (!bikesByType[bike.fareharbor_resource]) bikesByType[bike.fareharbor_resource] = [];
    bikesByType[bike.fareharbor_resource].push(bike.id);
  }

  const bikeTypeLabels = Object.keys(bikesByType);
  const items = bikeTypeLabels.map(label => ({
    bikeTypeLabel: label,
    qty: bikesByType[label].length,
    bikeIds: bikesByType[label],
  }));
  const allBikeIds = bikeTypeLabels.flatMap(label => bikesByType[label]);

  const itemId = RENTAL_ITEM_BY_DAYS[days] || RENTAL_ITEM_BY_DAYS[1];

  // Booking date/time: defaults to right now (walk-in), or a future date/time
  // if the rental form specified one.
  let bookingMoment;
  if (start_datetime) {
    bookingMoment = new Date(start_datetime);
    if (isNaN(bookingMoment.getTime())) return res.status(400).json({ error: 'Invalid start_datetime' });
  } else {
    bookingMoment = new Date();
  }
  const date = bookingMoment.toISOString().substring(0, 10);
  const time = bookingMoment.toTimeString().substring(0, 5);

  const paymentMethod = payment_method === 'card' ? 'card' : 'cash';

  console.log('Triggering FareHarbor agent:', { itemId, date, time, items: items.map(i=>`${i.bikeTypeLabel} x${i.qty}`), customer_name, paymentMethod });

  try {
    const result = await runAgentScript({
      item: itemId,
      date,
      time,
      items: JSON.stringify(items),
      customerName: customer_name,
      phone: phone || '',
      email: email || '',
      payment: paymentMethod,
    });

    db().prepare(`INSERT INTO action_log (actor,action,bike_id,booking_ref,details) VALUES (?,?,?,?,?)`)
      .run(actor, 'fareharbor_booking_created', allBikeIds.join(','), result.booking_ref,
        JSON.stringify({ customer_name, bike_ids: allBikeIds, days, payment_method: paymentMethod, start_datetime: start_datetime || null }));

    res.json({ ok: true, booking_ref: result.booking_ref });
  } catch (e) {
    console.error('FareHarbor agent failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
