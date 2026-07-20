#!/usr/bin/env node
// One-off fix: the 2026-07-16 transient-omission incident deleted and re-inserted
// several booked tours. A re-inserted row gets first_booking_notified=0 (the
// column default), so a booked tour ends up "primed" — booking_count>=1 but
// notified=0 — and fires a bogus "first booking just came in" email the next
// time a webhook/iCal touches it (e.g. the 31 Aug A3P fired on 2026-07-20 22:00,
// four days after re-insert). Same class as the original migration that marked
// existing booked tours as notified to avoid retro-emails.
//
// This marks every TOUR that already has bookings as notified, so it can't fire
// a first-booking email retroactively. Scoped to feed_type='tour' because the
// notifier (src/notify-first-booking.js) only ever fires for tours; rentals with
// first_booking_notified=0 are harmless.
//
// Idempotent. Dry-run by default; pass --commit to write.
//
// Usage:
//   node scripts/fixes/defuse-primed-first-booking.js            # dry run
//   node scripts/fixes/defuse-primed-first-booking.js --commit   # apply

const { getDb } = require('../../src/db/schema');

const commit = process.argv.includes('--commit');
const db = getDb();

const rows = db.prepare(
  `SELECT availability_id, feed_id, start_date, booking_count
     FROM tour_availabilities
    WHERE feed_type='tour' AND booking_count >= 1 AND first_booking_notified = 0
    ORDER BY start_date`
).all();

if (rows.length === 0) {
  console.log('Nothing to defuse — no booked tours with first_booking_notified=0.');
  process.exit(0);
}

console.log(`${commit ? 'APPLYING' : 'DRY RUN'} — ${rows.length} primed tour(s) to mark notified:\n`);
for (const r of rows) console.log(`  ${r.feed_id.padEnd(7)} ${r.start_date}  ${r.booking_count} booking(s)  [${r.availability_id}]`);

if (!commit) {
  console.log('\nDry run only. Re-run with --commit to apply.');
  process.exit(0);
}

const res = db.prepare(
  `UPDATE tour_availabilities SET first_booking_notified = 1
    WHERE feed_type='tour' AND booking_count >= 1 AND first_booking_notified = 0`
).run();
console.log(`\nDone. ${res.changes} tour(s) marked notified.`);
