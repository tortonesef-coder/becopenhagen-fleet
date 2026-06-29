const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

function db() { return getDb(); }

// Map FareHarbor item names to our bike type IDs
const ITEM_TYPE_MAP = {
  "adult's bike": 'A',
  "adult bike": 'A',
  "city bike": 'A',
  "adult city bike (small)": 'SA',
  "small adult": 'SA',
  "christiania cargo bike": 'CC',
  "cargo bike": 'CC',
  "bike with child seat": 'AC',
  "child seat": 'AC',
  "bike with toddler seat": 'AT',
  "toddler seat": 'AT',
  "child bike": 'B',
  "kids bike": 'B',
  "electric bike": 'E',
  "touring bike": 'TB',
  "mountain bike": 'MB',
};

function mapItemToType(itemName) {
  if (!itemName) return null;
  const lower = itemName.toLowerCase();
  for (const [key, val] of Object.entries(ITEM_TYPE_MAP)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

function parseBikesNeeded(booking) {
  // Try to extract bike types and quantities from customer types
  const needed = {};

  // From customer types (e.g. "Adult's Bike x2")
  const customers = booking.customers || [];
  customers.forEach(c => {
    const type = mapItemToType(c.customer_type?.name || '');
    if (type) needed[type] = (needed[type] || 0) + (c.num || 1);
  });

  // From custom fields if set
  const fields = booking.custom_field_values || [];
  fields.forEach(f => {
    if (f.value && typeof f.value === 'string') {
      // Look for "bike numbers assigned" field
      const ids = f.value.toUpperCase().match(/[A-Z]{1,2}\d+/g);
      if (ids) booking._assigned_bike_ids = ids;
    }
  });

  return needed;
}

function formatBikesNeeded(needed) {
  const db2 = db();
  return Object.entries(needed).map(([typeId, qty]) => {
    const type = db2.prepare('SELECT label FROM bike_types WHERE id=?').get(typeId);
    return `${qty}× ${type?.label || typeId}`;
  }).join(', ');
}

// POST /webhooks/fareharbor
router.post('/fareharbor', express.json({ type: '*/*' }), (req, res) => {
  // Always respond 200 immediately to prevent FareHarbor retries
  res.json({ ok: true });

  try {
    const payload = req.body;
    console.log('FareHarbor webhook received:', JSON.stringify(payload).substring(0, 200));

    const action = payload.action || payload.type || 'unknown';
    const booking = payload.booking || payload.data?.booking || payload;

    if (!booking || !booking.pk) {
      console.log('No booking data in webhook payload');
      return;
    }

    const ref = String(booking.pk);
    const customer = booking.contact || {};
    const availability = booking.availability || {};
    const item = availability.item || {};

    const customerName = [customer.name || '', customer.normalized_name || ''].find(Boolean) || 'Unknown';
    const customerEmail = customer.email || null;
    const customerPhone = customer.phone_country || customer.phone || null;

    // Parse date/time
    const startAt = availability.start_at || null;
    const endAt = availability.end_at || null;
    let bookingDate = null, startTime = null, endTime = null;
    if (startAt) {
      const d = new Date(startAt);
      bookingDate = d.toISOString().substring(0, 10);
      startTime = d.toTimeString().substring(0, 5);
    }
    if (endAt) {
      endTime = new Date(endAt).toTimeString().substring(0, 5);
    }

    const itemName = item.name || '';
    const bikesNeeded = parseBikesNeeded(booking);
    const bikesNeededStr = formatBikesNeeded(bikesNeeded) || itemName;

    if (action === 'cancelled' || action === 'booking.cancelled') {
      // Cancel any pending assignment for this booking
      db().prepare(`UPDATE pending_assignments SET status='cancelled' WHERE fareharbor_booking_ref=? AND status='pending'`)
        .run(ref);
      db().prepare(`INSERT INTO action_log (actor,action,bike_id,booking_ref,details) VALUES (?,?,?,?,?)`)
        .run('fareharbor', 'booking_cancelled', null, ref, JSON.stringify({customer_name:customerName}));
      console.log('Booking cancelled:', ref);
      return;
    }

    // Check if assignment already exists
    const existing = db().prepare('SELECT * FROM pending_assignments WHERE fareharbor_booking_ref=?').get(ref);

    if (existing) {
      // Update existing
      db().prepare(`UPDATE pending_assignments SET customer_name=?, customer_email=?, customer_phone=?,
        booking_date=?, start_time=?, end_time=?, bikes_needed=?
        WHERE fareharbor_booking_ref=?`)
        .run(customerName, customerEmail, customerPhone, bookingDate, startTime, endTime, bikesNeededStr, ref);
      console.log('Updated pending assignment:', ref);
    } else {
      // Create new
      db().prepare(`INSERT INTO pending_assignments
        (fareharbor_booking_ref, customer_name, customer_email, customer_phone,
         booking_date, start_time, end_time, bikes_needed, status)
        VALUES (?,?,?,?,?,?,?,?,'pending')`)
        .run(ref, customerName, customerEmail, customerPhone, bookingDate, startTime, endTime, bikesNeededStr);
      console.log('Created pending assignment:', ref, customerName, bookingDate, startTime);
    }

    db().prepare(`INSERT INTO action_log (actor,action,bike_id,booking_ref,details) VALUES (?,?,?,?,?)`)
      .run('fareharbor', 'booking_received', null, ref,
        JSON.stringify({customer_name:customerName, booking_date:bookingDate, start_time:startTime, bikes_needed:bikesNeededStr, action}));

  } catch(e) {
    console.error('Webhook processing error:', e.message, e.stack);
  }
});

// GET /webhooks/fareharbor — health check so Romain can verify the URL works
router.get('/fareharbor', (req, res) => {
  res.json({ ok: true, service: 'BeCopenhagen Fleet Tracker', webhook: 'ready' });
});

module.exports = router;
