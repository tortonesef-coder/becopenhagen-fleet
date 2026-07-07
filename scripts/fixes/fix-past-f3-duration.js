#!/usr/bin/env node
// One-off fix: force EVERY F3/F3P row to the correct 270min (4h30m) duration,
// regardless of date. The original version filtered by start_date < today,
// which should have caught everything but evidently missed at least one row
// — rather than debug the date-comparison edge case, just fix all of them
// unconditionally. F3/F3P is always 270min now, full stop.
//
// Safe to run multiple times — idempotent.
//
// Usage: node scripts/fixes/fix-past-f3-duration.js

const { getDb } = require('../../src/db/schema');

const db = getDb();
const F3_DURATION_MINUTES = 270; // 3.5h tour + 30min + 30min buffer

const result = db.prepare(`
  UPDATE guide_tour_hours
  SET duration_minutes = ?
  WHERE feed_id IN ('F3', 'F3P')
    AND duration_minutes != ?
`).run(F3_DURATION_MINUTES, F3_DURATION_MINUTES);

console.log(`Updated ${result.changes} F3/F3P rows to ${F3_DURATION_MINUTES} minutes (4h30m).`);

console.log('\nVerifying — all F3/F3P rows:');
const check = db.prepare(`SELECT availability_id, guide, feed_id, start_date, duration_minutes FROM guide_tour_hours WHERE feed_id IN ('F3','F3P') ORDER BY start_date`).all();
check.forEach(r => console.log(JSON.stringify(r)));

