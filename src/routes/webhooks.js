const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

function db() { return getDb(); }

// Map customer_type singular/plural text to bike type IDs
// "Adult incl. bike for the tour" -> needs a bike (A)
// "Adult with own bike" -> does NOT need a bike
function classifyCustomerType(typeName) {
  if (!typeName) return null;
  const t = typeName.toLowerCase();

  if (t.includes('own bike')) return null; // brings their own, no bike needed

  if (t.includes('cargo') || t.includes('christiania')) return 'CC';
  if (t.includes('e-bike') || t.includes('electric')) return 'E';
  if (t.includes('toddler')) return 'AT';
  if (t.includes('child seat')) return 'AC';
  if (t.includes('child') || t.includes('kid')) return 'B';
  if (t.includes('small adult') || t.includes('small bike')) return 'SA';
  if (t.includes('touring')) return 'TB';
  if (t.includes('mountain')) return 'MB';
  if (t.includes('adult')) return 'A';

  return null;
}

function formatBikesNeeded(needed) {
  const d = db();
  return Object.entries(needed)
    .filter(([,n]) => n > 0)
    .map(([typeId, qty]) => {
      const type = d.prepare('SELECT label FROM bike_types WHERE id=?').get(typeId);
      return `${qty}× ${type?.label || typeId}`;
    }).join(', ');
}

// POST /webhooks/fareharbor
router.post('/fareharbor', express.json({ type: '*/*' }), (req, res) => {
  res.json({ ok: true }); // Always ack immediately

  try {
    const payload = req.body;
    const booking = payload.booking;
    if (!booking || !booking.pk) {
      console.log('Webhook: no booking data');
      return;
    }

    const ref = String(booking.pk);
    const status = booking.status || 'booked';
    const contact = booking.contact || {};
    const availability = booking.availability || {};
    const item = availability.item || {};
    const customers = booking.customers || [];

    const customerName = contact.name || 'Unknown';
    const customerEmail = contact.email || null;
    const customerPhone = contact.normalized_phone || contact.phone || null;
    const createdAt = booking.created_at || null;
    const note = booking.note || null;
    const dashboardUrl = booking.dashboard_url || null;
    const amountPaid = booking.amount_paid_display || null;
    const receiptTotal = booking.receipt_total_display || null;
    const isFullyPaid = booking.amount_paid >= booking.receipt_total;

    // Parse date/time directly from availability (already has correct timezone offset)
    const startAt = availability.start_at; // e.g. "2027-06-01T10:00:00+0200"
    const endAt = availability.end_at;
    let bookingDate = null, startTime = null, endTime = null;
    if (startAt) {
      bookingDate = startAt.substring(0, 10);
      startTime = startAt.substring(11, 16);
    }
    if (endAt) endTime = endAt.substring(11, 16);

    // Classify customer types into bikes needed
    const bikesNeeded = {};
    let ownBikeCount = 0;
    customers.forEach(c => {
      const typeName = c.customer_type_rate?.customer_type?.singular || '';
      const bikeType = classifyCustomerType(typeName);
      if (bikeType) bikesNeeded[bikeType] = (bikesNeeded[bikeType] || 0) + 1;
      else if (typeName.toLowerCase().includes('own bike')) ownBikeCount++;
    });
    const bikesNeededStr = formatBikesNeeded(bikesNeeded) ||
      (ownBikeCount > 0 ? `${ownBikeCount}× own bike (no rental needed)` : item.name || '');

    // Handle cancellation
    if (status === 'cancelled') {
      db().prepare(`UPDATE pending_assignments SET status='cancelled' WHERE fareharbor_booking_ref=?`).run(ref);
      db().prepare(`INSERT INTO action_log (actor,action,bike_id,booking_ref,details) VALUES (?,?,?,?,?)`)
        .run('fareharbor', 'booking_cancelled', null, ref, JSON.stringify({customer_name: customerName}));
      console.log('Booking cancelled:', ref);
      return;
    }

    // Handle rebooking — old booking becomes inactive, points to new one
    if (status === 'rebooked' && booking.rebooked_to) {
      db().prepare(`UPDATE pending_assignments SET status='cancelled', notes=? WHERE fareharbor_booking_ref=?`)
        .run('Rebooked to ' + booking.rebooked_to, ref);
      console.log('Booking rebooked, old ref closed:', ref);
      // The new booking will arrive as its own webhook event
      return;
    }

    const existing = db().prepare('SELECT * FROM pending_assignments WHERE fareharbor_booking_ref=?').get(ref);
    const fullNote = [note, isFullyPaid ? null : `Due: ${receiptTotal} (paid: ${amountPaid})`].filter(Boolean).join(' | ');

    if (existing) {
      db().prepare(`UPDATE pending_assignments SET customer_name=?, customer_email=?, customer_phone=?,
        booking_date=?, start_time=?, end_time=?, bikes_needed=?, notes=?
        WHERE fareharbor_booking_ref=?`)
        .run(customerName, customerEmail, customerPhone, bookingDate, startTime, endTime, bikesNeededStr, fullNote, ref);
      console.log('Updated pending assignment:', ref);
    } else {
      db().prepare(`INSERT INTO pending_assignments
        (fareharbor_booking_ref, customer_name, customer_email, customer_phone,
         booking_date, start_time, end_time, bikes_needed, status, notes)
        VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
        .run(ref, customerName, customerEmail, customerPhone, bookingDate, startTime, endTime, bikesNeededStr, fullNote);
      console.log('Created pending assignment:', ref, customerName, bookingDate, startTime);
    }

    // Store created_at and full booking metadata in action_log for the "booked before X" flag
    db().prepare(`INSERT INTO action_log (actor,action,bike_id,booking_ref,details) VALUES (?,?,?,?,?)`)
      .run('fareharbor', 'booking_received', null, ref, JSON.stringify({
        customer_name: customerName, booking_date: bookingDate, start_time: startTime,
        bikes_needed: bikesNeededStr, status, created_at: createdAt,
        item_name: item.name, dashboard_url: dashboardUrl,
        amount_paid: amountPaid, receipt_total: receiptTotal,
      }));

    // Update tour_availabilities table with the created_at for this booking ref
    // so the Tours tab can show the "booked before July 1" flag
    try {
      const availId = String(availability.pk);
      const existing2 = db().prepare('SELECT bookings_json FROM tour_availabilities WHERE availability_id=?').get(availId);
      if (existing2) {
        let bookings = JSON.parse(existing2.bookings_json || '[]');
        const idx = bookings.findIndex(b => b.ref === ref);
        const bookingRecord = {
          ref, name: customerName, phone: customerPhone, email: customerEmail,
          created_at: createdAt, note, what: bikesNeededStr,
        };
        if (idx >= 0) bookings[idx] = { ...bookings[idx], ...bookingRecord };
        else bookings.push(bookingRecord);
        db().prepare('UPDATE tour_availabilities SET bookings_json=?, booking_count=? WHERE availability_id=?')
          .run(JSON.stringify(bookings), bookings.length, availId);
      }
    } catch(e) { console.error('Could not update tour_availabilities from webhook:', e.message); }

  } catch(e) {
    console.error('Webhook processing error:', e.message, e.stack);
  }
});

router.get('/fareharbor', (req, res) => {
  res.json({ ok: true, service: 'BeCopenhagen Fleet Tracker', webhook: 'ready' });
});

module.exports = router;
