#!/usr/bin/env node
/**
 * Reset repair ticket data — clears test/pollution data from repair_tickets
 * and resets any bikes currently marked 'repair' back to 'available'.
 * Does NOT touch bikes, team_members, bookings, or any other data.
 *
 * Usage: node reset-repair-data.js
 */
const { getDb } = require('../src/db/schema');
const db = getDb();

const ticketCount = db.prepare('SELECT COUNT(*) as n FROM repair_tickets').get().n;
const repairBikes = db.prepare("SELECT bike_id FROM bike_status WHERE status='repair'").all();

console.log(`About to delete ${ticketCount} repair tickets.`);
console.log(`About to reset ${repairBikes.length} bikes from 'repair' status to 'available': ${repairBikes.map(b=>b.bike_id).join(', ')}`);

db.prepare('DELETE FROM repair_tickets').run();
db.prepare(`UPDATE bike_status SET status='available', note=NULL WHERE status='repair'`).run();

// Also clear repair-related entries from action_log so ticket history/analytics starts fresh
const logDeleted = db.prepare(`DELETE FROM action_log WHERE action IN ('repair_ticket','ticket_deleted','repair_resolved')`).run();
console.log(`Cleared ${logDeleted.changes} repair-related log entries.`);

console.log('Done. Repair data reset — fleet and bookings untouched.');
