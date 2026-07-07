#!/usr/bin/env node
// One-off fix: restore the 6 manually-seeded guide_tour_hours rows that were
// accidentally deleted, this time with correct start_at/end_at (missing the
// first time, which silently excluded them from the "worked hours" query)
// and real booking_count values (checked against FareHarbor's manifest).
//
// Safe to run multiple times — uses INSERT ... ON CONFLICT DO UPDATE.
//
// Usage: node scripts/fixes/restore-manual-guide-hours.js

const { getDb } = require('../../src/db/schema');

const db = getDb();

const rows = [
  ['manual-ibrahim-1', 'Ibrahim', 'A3', '2026-06-24', '2026-06-24T10:00:00.000Z', '2026-06-24T13:30:00.000Z', 210, 1],
  ['manual-ibrahim-2', 'Ibrahim', 'A3', '2026-06-26', '2026-06-26T10:00:00.000Z', '2026-06-26T13:30:00.000Z', 210, 4],
  ['manual-pam-1',     'Pam',     'F3', '2026-06-28', '2026-06-28T10:00:00.000Z', '2026-06-28T13:30:00.000Z', 240, 5],
  ['manual-pam-2',     'Pam',     'F3', '2026-06-30', '2026-06-30T10:00:00.000Z', '2026-06-30T13:30:00.000Z', 240, 1],
  ['manual-andrew-1',  'Andrew',  'A3', '2026-06-29', '2026-06-29T10:00:00.000Z', '2026-06-29T13:30:00.000Z', 210, 5],
  ['manual-andrew-2',  'Andrew',  'A3', '2026-06-30', '2026-06-30T10:00:00.000Z', '2026-06-30T13:30:00.000Z', 210, 4],
];

const upsert = db.prepare(`
  INSERT INTO guide_tour_hours
    (availability_id, guide, feed_id, start_date, start_at, end_at, duration_minutes, booking_count)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(availability_id) DO UPDATE SET
    guide=excluded.guide, feed_id=excluded.feed_id, start_date=excluded.start_date,
    start_at=excluded.start_at, end_at=excluded.end_at,
    duration_minutes=excluded.duration_minutes, booking_count=excluded.booking_count
`);

for (const [id, guide, feed_id, start_date, start_at, end_at, duration_minutes, booking_count] of rows) {
  upsert.run(id, guide, feed_id, start_date, start_at, end_at, duration_minutes, booking_count);
}

console.log(`Restored ${rows.length} rows. Verifying:`);
const check = db.prepare(`SELECT availability_id, guide, start_date, start_at, duration_minutes, booking_count FROM guide_tour_hours WHERE availability_id LIKE 'manual-%'`).all();
console.log('count:', check.length);
check.forEach(r => console.log(JSON.stringify(r)));
