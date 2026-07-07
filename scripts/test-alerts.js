#!/usr/bin/env node
/**
 * Test script: fires one notification of each type so you can verify
 * icons, colors, and formatting in the Alerts tab all look right.
 *
 * All test notifications are prefixed "TEST:" and use ref_ids starting
 * with "test-" so they never collide with real alerts and are easy to
 * clean up afterwards.
 *
 * Usage:
 *   node scripts/test-alerts.js          — create one of each test alert
 *   node scripts/test-alerts.js --clean  — delete all TEST: alerts
 */

const { getDb } = require('../src/db/schema');
const { createNotification } = require('../src/routes/admin-notifs');

const db = getDb();

if (process.argv.includes('--clean')) {
  const result = db.prepare(`DELETE FROM admin_notifications WHERE title LIKE 'TEST:%'`).run();
  console.log(`Cleaned up ${result.changes} test notification(s).`);
  process.exit(0);
}

const stamp = Date.now();
const tests = [
  {
    type: 'unassigned_tour',
    title: `TEST: Unassigned tour: A3 on 2026-08-01`,
    body: `3 bookings — no guide assigned yet.`,
    ref_id: `test-unassigned-${stamp}`,
  },
  {
    type: 'unavailability',
    title: `TEST: Monica is unavailable: 2026-08-10 → 2026-08-15`,
    body: `Testing unavailability notification`,
    ref_id: `test-unavail-${stamp}`,
  },
  {
    type: 'invoice',
    title: `TEST: New invoice from Andrew for July 2026`,
    body: `invoice-july-2026.pdf`,
    ref_id: `test-invoice-${stamp}`,
  },
  {
    type: 'first_booking_soon',
    title: `TEST: First booking: F3 on Monday`,
    body: `10:00 — 1 booking — guide: Ibrahim.`,
    ref_id: `test-firstbooking-${stamp}`,
  },
  {
    type: 'bug_report',
    title: `TEST: New bug reported by Pam`,
    body: `The bikes tab shows the wrong count when I filter by...`,
    ref_id: `test-bugreport-${stamp}`,
  },
  {
    type: 'conflict',
    title: `TEST: Conflict — guide assigned during unavailability`,
    body: `Hassan is marked unavailable Aug 3-5 but has H3 assigned Aug 4.`,
    ref_id: `test-conflict-${stamp}`,
  },
];

for (const t of tests) {
  createNotification(t.type, t.title, t.body, t.ref_id);
  console.log(`✓ Created test alert: [${t.type}] ${t.title}`);
}

console.log(`\nDone. Open Admin → Alerts to check them all.`);
console.log(`Run "node scripts/test-alerts.js --clean" afterwards to remove them.`);
