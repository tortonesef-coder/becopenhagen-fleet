#!/usr/bin/env node
// One-off fix: completed tours stop being re-synced once they age out of the
// live FareHarbor feed, so the Food Tour buffer change (15+15 -> 30+30,
// making F3 4.5h total instead of 4h) never reached any ALREADY-COMPLETED
// F3 tour — they're frozen with whatever duration was computed before the
// fix. Future/upcoming F3 tours self-correct automatically via the normal
// sync (already fixed in code); this script only needs to touch the past.
//
// Safe to run multiple times — idempotent.
//
// Usage: node scripts/fixes/fix-past-f3-duration.js

const { getDb } = require('../../src/db/schema');

const db = getDb();
const F3_DURATION_MINUTES = 270; // 3.5h tour + 30min + 30min buffer

const todayStr = new Date().toISOString().substring(0, 10);

const result = db.prepare(`
  UPDATE guide_tour_hours
  SET duration_minutes = ?
  WHERE feed_id IN ('F3', 'F3P')
    AND start_date < ?
    AND duration_minutes != ?
`).run(F3_DURATION_MINUTES, todayStr, F3_DURATION_MINUTES);

console.log(`Updated ${result.changes} past F3/F3P rows to ${F3_DURATION_MINUTES} minutes (4h30m).`);

console.log('\nVerifying — all F3/F3P rows:');
const check = db.prepare(`SELECT availability_id, guide, feed_id, start_date, duration_minutes FROM guide_tour_hours WHERE feed_id IN ('F3','F3P') ORDER BY start_date`).all();
check.forEach(r => console.log(JSON.stringify(r)));
