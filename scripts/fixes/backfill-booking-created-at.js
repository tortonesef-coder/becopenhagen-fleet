#!/usr/bin/env node
// One-off fix: every 90-second iCal sync was unconditionally overwriting
// tour_availabilities.bookings_json with a freshly-parsed version that has
// no created_at field at all (iCal text doesn't carry booking creation
// timestamps). This silently wiped out the created_at the webhook correctly
// sets when a booking first arrives — within ~90 seconds of every single
// booking, for as long as this flag has existed. The "Can keep bikes after
// tour" flag (and any other "booked before X" logic) defaults to TRUE when
// created_at is missing, so it showed for every booking, not just old ones.
//
// The sync code itself is now fixed (ical.js merges forward any created_at
// already present). This script backfills the CURRENTLY-missing values from
// action_log's 'booking_received' history, which has a full record of
// created_at per booking_ref for as long as the webhook has been running.
//
// Safe to run multiple times — idempotent.
//
// Usage: node scripts/fixes/backfill-booking-created-at.js

const { getDb } = require('../../src/db/schema');

const db = getDb();

// Build a ref -> created_at map from action_log history
const logRows = db.prepare(`SELECT booking_ref, details FROM action_log WHERE action='booking_received' AND booking_ref IS NOT NULL`).all();
const createdAtByRef = {};
for (const row of logRows) {
  try {
    const details = JSON.parse(row.details || '{}');
    if (details.created_at && !createdAtByRef[row.booking_ref]) {
      createdAtByRef[row.booking_ref] = details.created_at;
    }
  } catch (e) { /* skip malformed */ }
}
console.log(`Found ${Object.keys(createdAtByRef).length} historical booking creation dates in action_log.`);

// Backfill into tour_availabilities.bookings_json
let taUpdated = 0, taBookingsFixed = 0;
const taRows = db.prepare(`SELECT availability_id, bookings_json FROM tour_availabilities WHERE bookings_json IS NOT NULL AND bookings_json != '[]'`).all();
for (const row of taRows) {
  let bookings;
  try { bookings = JSON.parse(row.bookings_json); } catch (e) { continue; }
  let changed = false;
  for (const b of bookings) {
    if (b.ref && !b.created_at && createdAtByRef[b.ref]) {
      b.created_at = createdAtByRef[b.ref];
      changed = true;
      taBookingsFixed++;
    }
  }
  if (changed) {
    db.prepare('UPDATE tour_availabilities SET bookings_json=? WHERE availability_id=?').run(JSON.stringify(bookings), row.availability_id);
    taUpdated++;
  }
}
console.log(`tour_availabilities: updated ${taUpdated} rows, backfilled ${taBookingsFixed} individual bookings.`);

// Backfill into the bookings ledger too
let ledgerFixed = 0;
const ledgerRows = db.prepare(`SELECT ref FROM bookings WHERE booking_created_at IS NULL`).all();
for (const row of ledgerRows) {
  if (createdAtByRef[row.ref]) {
    db.prepare('UPDATE bookings SET booking_created_at=? WHERE ref=?').run(createdAtByRef[row.ref], row.ref);
    ledgerFixed++;
  }
}
console.log(`bookings ledger: backfilled ${ledgerFixed} rows.`);

console.log('\nDone.');
