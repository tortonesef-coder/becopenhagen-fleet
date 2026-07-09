#!/usr/bin/env node
// DIAGNOSTIC ONLY — read-only. Shows a guide's guide_tour_hours rows and why the
// "worked" figure is what it is. "Worked" on the card = tours that have already
// started, within the current pay cycle (23rd of last month → 22nd of this).
//
//   node scripts/fixes/diag-guide-hours.js [guideName]   (default Féidhlim)

const { getDb } = require('../../src/db/schema');
const { guideMatches } = require('../../src/guide-name-match');
const db = getDb();
const who = process.argv.slice(2).join(' ') || 'Féidhlim';

// same cycle math as the frontend
const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
const cycleStart = d >= 23 ? `${y}-${String(m+1).padStart(2,'0')}-23` : `${y}-${String(m).padStart(2,'0')}-23`;
const cycleEnd   = d >= 23 ? `${y+(m===11?1:0)}-${String((m+2)%12||12).padStart(2,'0')}-22` : `${y}-${String(m+1).padStart(2,'0')}-22`;
const nowIso = now.toISOString().replace('T',' ').substring(0,19);

console.log(`\nGuide: "${who}"   current cycle: ${cycleStart} .. ${cycleEnd}   now(UTC): ${nowIso}\n`);

const all = db.prepare(`SELECT availability_id, feed_id, start_date, start_at, end_at, duration_minutes, booking_count, guide FROM guide_tour_hours ORDER BY start_at`).all();
const mine = all.filter(r => guideMatches(r.guide, who));

console.log(`guide_tour_hours rows matching "${who}": ${mine.length}`);
let workedAll = 0, workedCycle = 0, upcoming = 0, workedCycleBookings = 0;
mine.forEach(r => {
  const started = r.start_at && new Date(r.start_at) <= now;
  const inCycle = r.start_date >= cycleStart && r.start_date <= cycleEnd;
  if (started) { workedAll += r.duration_minutes || 0; if (inCycle) { workedCycle += r.duration_minutes || 0; workedCycleBookings += r.booking_count || 0; } }
  else upcoming += r.duration_minutes || 0;
  console.log(`  ${r.start_date}  ${r.feed_id}  ${r.duration_minutes}min  bookings=${r.booking_count}  guide="${r.guide}"  ${started ? 'WORKED' : 'upcoming'}${started && inCycle ? ' (this cycle)' : ''}`);
});

// Reviews this cycle (same as the app: /api/reviews?guide_id=..&from=..&to=..)
const member = db.prepare(`SELECT id FROM team_members WHERE name=? OR name LIKE ?`).get(who, who + '%');
let reviewCount = 0;
if (member) {
  reviewCount = db.prepare(`SELECT COUNT(*) n FROM guide_reviews WHERE guide_id=? AND review_date >= ? AND review_date <= ?`).get(member.id, cycleStart, cycleEnd).n;
}

console.log(`\nSummary for "${who}":`);
console.log(`  worked ALL-TIME:   ${(workedAll/60).toFixed(1)}h`);
console.log(`  worked THIS CYCLE: ${(workedCycle/60).toFixed(1)}h`);
console.log(`  upcoming:          ${(upcoming/60).toFixed(1)}h`);
console.log(`  bookings on worked-this-cycle tours: ${workedCycleBookings}`);
console.log(`  reviews this cycle: ${reviewCount}`);
const ratio = workedCycleBookings > 0 && reviewCount > 0 ? Math.round((reviewCount / workedCycleBookings) * 100) : null;
console.log(`  review rate (reviews / bookings): ${ratio === null ? '—' : ratio + '%'}   <- this is what the card shows`);

// For each worked-this-cycle tour, compare the hours booking_count against the
// actual reservations still on tour_availabilities (if the row hasn't been purged).
console.log(`\nWorked-this-cycle tours — hours booking_count vs actual reservations:`);
mine.filter(r => r.start_at && new Date(r.start_at) <= now && r.start_date >= cycleStart && r.start_date <= cycleEnd).forEach(r => {
  const ta = db.prepare(`SELECT booking_count, bookings_json FROM tour_availabilities WHERE availability_id=?`).get(r.availability_id);
  let resv = '(row purged — not in tour_availabilities anymore)';
  if (ta) {
    let list = [];
    try { list = JSON.parse(ta.bookings_json || '[]'); } catch {}
    resv = `tour_availabilities.booking_count=${ta.booking_count}, reservations=${list.length} [${list.map(b => `${b.name || '?'}: ${b.what || ''}`).join(' | ')}]`;
  }
  console.log(`  ${r.start_date} ${r.feed_id} (avail ${r.availability_id}): hours.booking_count=${r.booking_count}`);
  console.log(`    ${resv}`);
});

// Are there started tours THIS CYCLE whose guide does NOT match (mismatch/missing)?
console.log(`\nStarted tours in this cycle whose guide does NOT match "${who}" (possible mis-recorded guide):`);
const cycleStarted = all.filter(r => r.start_at && new Date(r.start_at) <= now && r.start_date >= cycleStart && r.start_date <= cycleEnd && !guideMatches(r.guide, who));
if (!cycleStarted.length) console.log('  none');
else cycleStarted.slice(0, 25).forEach(r => console.log(`  ${r.start_date}  ${r.feed_id}  ${r.duration_minutes}min  guide="${r.guide || '(null)'}"`));

console.log(`\n(If worked THIS CYCLE is 0 and there are no mismatches above, ${who} simply hasn't worked a started tour since ${cycleStart} — the 0 is correct for the cycle.)`);
console.log('');
