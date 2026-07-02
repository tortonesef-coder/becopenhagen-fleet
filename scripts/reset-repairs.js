#!/usr/bin/env node
/**
 * Reset repair/ticket data — clears all test repair tickets and resets
 * any bike stuck in 'repair' status back to 'available'.
 *
 * Does NOT touch: bikes table itself, bike_status history for non-repair
 * statuses, action_log, or anything unrelated to repairs.
 *
 * Usage: node reset-repairs.js --confirm
 * (requires --confirm to actually run, otherwise just shows what would happen)
 */

const { getDb } = require('../src/db/schema');

function main() {
  const confirmed = process.argv.includes('--confirm');
  const db = getDb();

  const ticketCount = db.prepare('SELECT COUNT(*) as n FROM repair_tickets').get().n;
  const repairBikes = db.prepare(`SELECT bike_id FROM bike_status WHERE status='repair'`).all();

  console.log(`Found ${ticketCount} repair tickets.`);
  console.log(`Found ${repairBikes.length} bikes currently marked 'repair': ${repairBikes.map(b=>b.bike_id).join(', ') || '(none)'}`);

  if (!confirmed) {
    console.log('\nDry run only. Re-run with --confirm to actually reset.');
    return;
  }

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM repair_tickets').run();
    db.prepare(`UPDATE bike_status SET status='available', note=NULL WHERE status='repair'`).run();
  });
  txn();

  console.log(`\nDone. Cleared ${ticketCount} tickets, reset ${repairBikes.length} bikes to available.`);
}

main();
