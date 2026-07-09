#!/usr/bin/env node
// DIAGNOSTIC ONLY — read-only. Explains why only N cancellation emails fired
// after cancelling many tours. A tour_cancelled email is only sent to a guide who
// was ASSIGNED to the cancelled tour — cancellations with no assigned guide have
// nobody to email. This reconciles cancelled tours vs emails sent.
//
//   node scripts/fixes/diag-cancellations.js [days]   (default 3)

const { getDb } = require('../../src/db/schema');
const db = getDb();
const days = parseInt(process.argv[2], 10) || 3;
const since = `-${days} days`;
const L = (s) => console.log(s);

L(`\n=== tour_cancelled EMAILS sent (last ${days}d) ===`);
const emails = db.prepare(`SELECT sent_at, to_email, subject FROM emails_sent WHERE category='tour_cancelled' AND sent_at >= datetime('now',?) ORDER BY sent_at DESC`).all(since);
L(`  count: ${emails.length}`);
emails.forEach(e => L(`  ${e.sent_at}  ${e.to_email}  ${e.subject}`));

L(`\n=== tours DETECTED cancelled by v2 (status->cancelled, last ${days}d) ===`);
L('  (note: iCal-deleted cancellations are NOT logged here, so this can undercount)');
const cancels = db.prepare(`
  SELECT availability_id, feed_id, start_date, created_at
  FROM tour_change_log
  WHERE field='status' AND new_value='cancelled' AND created_at >= datetime('now',?)
  ORDER BY created_at DESC`).all(since);

// last-known guide per availability (most recent guide entry in the log)
const guideFor = (availId) => {
  const r = db.prepare(`SELECT new_value FROM tour_change_log WHERE availability_id=? AND field='guide' AND new_value IS NOT NULL AND new_value != '' ORDER BY created_at DESC LIMIT 1`).get(availId);
  return r?.new_value || null;
};
const claimed = (availId) => {
  try { return !!db.prepare('SELECT 1 FROM tour_cancel_notified WHERE availability_id=?').get(availId); }
  catch { return false; }
};

let withGuide = 0, withoutGuide = 0, missed = [];
L(`  count: ${cancels.length}`);
cancels.forEach(c => {
  const g = guideFor(c.availability_id);
  const cl = claimed(c.availability_id);
  if (g) withGuide++; else withoutGuide++;
  const flag = (g && !cl) ? '  <-- had a guide but NOT emailed (possible miss)' : '';
  L(`  ${c.start_date}  ${c.feed_id}  guide=${g || '(none assigned)'}  emailed=${cl ? 'yes' : 'no'}${flag}`);
  if (g && !cl) missed.push(c);
});

L(`\n=== summary ===`);
L(`  cancellations detected by v2: ${cancels.length}`);
L(`    with a guide assigned:    ${withGuide}   <- these are the ones that email`);
L(`    with NO guide assigned:   ${withoutGuide}  <- correctly send no email`);
L(`  cancellation emails sent:   ${emails.length}`);
if (missed.length) {
  L(`\n  ${missed.length} cancelled tour(s) HAD a guide but weren't emailed — worth a closer look (could be a real gap).`);
} else {
  L(`\n  No missed guided cancellations. The email count matches the number of cancelled tours that had a guide assigned — working as intended.`);
}
L('');
