#!/usr/bin/env node
// Safe email test — sends a REAL first-booking email to the address you give,
// and ONLY that address. Uses the shared notifier's test mode, so it sets no
// flags, creates no admin alert, and never emails a guide. Repeatable.
//
//   node scripts/fixes/test-first-booking-email.js you@example.com [availabilityId]
//
// With no availabilityId it auto-picks the soonest upcoming tour whose guide
// matches a real team member (so the email has realistic content).

const { getDb } = require('../../src/db/schema');
const { guideMatches } = require('../../src/guide-name-match');
const { notifyFirstBooking } = require('../../src/notify-first-booking');

const email = process.argv[2];
const availArg = process.argv[3];

if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/fixes/test-first-booking-email.js you@example.com [availabilityId]');
  console.error('An email address is required so this can never accidentally message a guide.');
  process.exit(1);
}

const db = getDb();
const members = db.prepare("SELECT id, name, email FROM team_members WHERE active=1 AND email IS NOT NULL").all();

let availId = availArg;
let picked = null;
if (availId) {
  picked = db.prepare("SELECT availability_id, feed_id, start_date, guide FROM tour_availabilities WHERE availability_id=?").get(String(availId));
} else {
  const today = new Date().toISOString().substring(0, 10);
  const rows = db.prepare(
    "SELECT availability_id, feed_id, start_date, guide FROM tour_availabilities WHERE feed_type='tour' AND guide IS NOT NULL AND start_date >= ? ORDER BY start_date"
  ).all(today);
  picked = rows.find(r => members.some(m => guideMatches(r.guide, m.name))) || rows[0] || null;
  availId = picked?.availability_id;
}

if (!picked) {
  console.error('Could not find an upcoming tour with a guide to base the test on. Pass an availabilityId explicitly.');
  process.exit(1);
}

console.log(`Test tour: ${picked.feed_id} ${picked.start_date}  guide=${picked.guide}  avail=${picked.availability_id}`);
console.log(`Sending a [TEST] first-booking email to ${email} only...`);

const sent = notifyFirstBooking(String(availId), { testEmailTo: email });
if (sent) {
  console.log('notifier ran. Check that inbox for a "[TEST] First booking — ..." email.');
  console.log('(If nothing arrives, the picked tour\'s guide may not match a team member — try another availabilityId.)');
} else {
  console.log('Notifier did not send — the tour may have no matching guide. Try passing a specific availabilityId.');
}
// give the async SMTP send a moment to flush before the process exits
setTimeout(() => process.exit(0), 4000);
