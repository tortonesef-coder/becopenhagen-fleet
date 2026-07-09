#!/usr/bin/env node
// DIAGNOSTIC ONLY — read-only. Explains the duplicated "tour cancelled" email:
// was it a one-time deploy-window artifact, or an ongoing tug-of-war where iCal
// keeps re-adding a slot the v2 scraper keeps "cancelling"?
//
//   node scripts/fixes/diag-tour-cancel-dupe.js

const { getDb } = require('../../src/db/schema');
const db = getDb();
const L = (s) => console.log(s);

L('\n=== tour_cancelled emails sent (most recent 15) ===');
const es = db.prepare(`SELECT sent_at, to_email, subject, ok FROM emails_sent WHERE category='tour_cancelled' ORDER BY sent_at DESC LIMIT 15`).all();
if (!es.length) L('  none');
es.forEach(e => L(`  ${e.sent_at}  ok=${e.ok}  ${e.to_email}  ${e.subject}`));

L('\n=== tour_cancel_notified claims (most recent 15) ===');
let tcn = [];
try { tcn = db.prepare(`SELECT availability_id, notified_at FROM tour_cancel_notified ORDER BY notified_at DESC LIMIT 15`).all(); }
catch (e) { L('  TABLE MISSING: ' + e.message + '  <-- claim can never persist; that is the bug'); }
if (tcn.length === 0 && !tcn.error) L('  (empty — no cancellation has been claimed; if emails were sent, the claim is not persisting)');
tcn.forEach(r => L(`  ${r.notified_at}  ${r.availability_id}`));

L('\n=== "cancelled" events in tour_change_log, grouped by slot (last 3 days) ===');
const changes = db.prepare(`
  SELECT availability_id, feed_id, start_date, COUNT(*) n, GROUP_CONCAT(source) sources, MIN(created_at) first, MAX(created_at) last
  FROM tour_change_log
  WHERE field='status' AND new_value='cancelled' AND created_at >= datetime('now','-3 days')
  GROUP BY availability_id ORDER BY n DESC LIMIT 15`).all();
if (!changes.length) L('  none');
changes.forEach(c => {
  const flag = c.n > 1 ? '  <-- cancelled MULTIPLE times = tug-of-war (iCal re-adds, v2 re-cancels)' : '';
  L(`  ${c.feed_id} ${c.start_date}  avail=${c.availability_id}  cancelled ${c.n}× [${c.sources}]  ${c.first}..${c.last}${flag}`);
});

L('\n=== is any cancelled slot currently back in tour_availabilities? (iCal re-added) ===');
if (changes.length) {
  for (const c of changes) {
    const row = db.prepare(`SELECT availability_id, last_synced, guide FROM tour_availabilities WHERE availability_id=?`).get(c.availability_id);
    if (row) L(`  ${c.feed_id} ${c.start_date}  STILL PRESENT (last_synced ${row.last_synced}, guide ${row.guide || 'none'})  <-- iCal is re-adding it`);
  }
} 

L('\n=== interpretation ===');
L('  - A slot cancelled ONCE, with a matching tour_cancel_notified claim, and NOT');
L('    back in tour_availabilities  => healthy; the earlier double was a deploy artifact.');
L('  - A slot cancelled MULTIPLE times and/or STILL PRESENT in tour_availabilities');
L('    => tug-of-war: v2 keeps cancelling a slot iCal keeps re-adding. Needs a fix so');
L('       v2 only cancels when iCal has also stopped seeing it (stale last_synced).');
L('');
