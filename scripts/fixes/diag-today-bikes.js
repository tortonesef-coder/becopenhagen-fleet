#!/usr/bin/env node
// DIAGNOSTIC ONLY — read-only. Verifies the Today board's "Bikes needed today"
// numbers against the raw data: shows each of today's tours/rentals, the
// bikes_needed each one carries, and recomputes the peak by hand so we can see
// whether the total is right and where each category comes from.
//
//   node scripts/fixes/diag-today-bikes.js [YYYY-MM-DD]

const { getDb } = require('../../src/db/schema');
const db = getDb();
const day = process.argv[2] || new Date().toISOString().substring(0, 10);

const CAT = { A:'Adult regular bike', E:'E-bike', B:'Child bike', AC:'Child seat', AT:'Toddler seat', GT:'Guided-tour bike', SA:'Small adult' };
const hhmm = (t) => { const m = String(t||'').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1])*60 + (+m[2]) : null; };

const rows = db.prepare(`
  SELECT availability_id, feed_id, feed_type, start_date, start_time, end_time,
         booking_count, bikes_needed, total_bikes, summary
  FROM tour_availabilities WHERE start_date = ? ORDER BY start_time
`).all(day);

if (!rows.length) { console.log(`\nNothing scheduled on ${day}.\n`); process.exit(0); }

console.log(`\n=== ${day} — raw rows ===\n`);
const tours = [], rentals = [];
rows.forEach(r => {
  let bn = {};
  try { bn = JSON.parse(r.bikes_needed || '{}'); } catch {}
  const nonZero = Object.entries(bn).filter(([,n]) => n > 0);
  const kind = r.feed_type === 'rental' ? 'RENTAL' : 'TOUR';
  (r.feed_type === 'rental' ? rentals : tours).push({ ...r, bn });
  console.log(`  [${kind}] ${r.feed_id.padEnd(7)} ${(r.start_time||'??').padEnd(5)}–${(r.end_time||'??').padEnd(5)}  bookings=${r.booking_count}  total_bikes=${r.total_bikes}`);
  console.log(`      bikes_needed: ${nonZero.length ? nonZero.map(([k,n]) => `${k}=${n} (${CAT[k]||'UNKNOWN CODE'})`).join(', ') : '(none)'}`);
  if (nonZero.some(([k]) => !CAT[k])) console.log(`      ⚠ UNKNOWN CATEGORY CODE — would render with a wrong/blank label`);
  if (r.summary) console.log(`      summary: ${String(r.summary).substring(0,110)}`);
});

// Recompute the peak exactly as the Today board does
console.log(`\n=== peak calc for TOURS (hold bikes from start-10min to end+20min) ===\n`);
const cats = new Set();
tours.forEach(t => Object.entries(t.bn).forEach(([k,n]) => { if (n>0) cats.add(k); }));
if (!cats.size) console.log('  (no tour needs any bikes today)');
cats.forEach(cat => {
  const evs = [];
  tours.forEach(t => {
    const n = t.bn[cat] || 0; if (n <= 0) return;
    const s = hhmm(t.start_time), e = hhmm(t.end_time);
    if (s == null || e == null) { console.log(`  ⚠ ${t.feed_id} has no usable start/end time — EXCLUDED from the peak`); return; }
    evs.push([s-10, n, `${t.feed_id} ${t.start_time} +${n}`]);
    evs.push([e+20, -n, `${t.feed_id} ends → -${n}`]);
  });
  evs.sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  let cur = 0, peak = 0, at = '';
  evs.forEach(([mins,d,label]) => { cur += d; if (cur > peak) { peak = cur; at = label; } });
  console.log(`  ${cat} (${CAT[cat]||'UNKNOWN'}): peak = ${peak}   [highest at: ${at}]`);
});

console.log(`\n=== rentals (summed — each ties up its bikes all day) ===\n`);
const rentalTot = {};
rentals.forEach(r => { if (r.booking_count > 0) Object.entries(r.bn).forEach(([k,n]) => { if (n>0) rentalTot[k] = (rentalTot[k]||0)+n; }); });
if (!Object.keys(rentalTot).length) console.log('  (no rental bikes today)');
Object.entries(rentalTot).forEach(([k,n]) => console.log(`  ${k} (${CAT[k]||'UNKNOWN'}): ${n}`));

console.log(`\n=== sanity checks ===`);
const zeroTime = rows.filter(r => !r.start_time || !r.end_time);
if (zeroTime.length) console.log(`  ⚠ ${zeroTime.length} row(s) missing start/end time — silently excluded from the tour peak:`), zeroTime.forEach(r => console.log(`      ${r.feed_id} ${r.start_date} (start=${r.start_time||'null'}, end=${r.end_time||'null'})`));
const unknown = new Set();
rows.forEach(r => { try { Object.entries(JSON.parse(r.bikes_needed||'{}')).forEach(([k,n]) => { if (n>0 && !CAT[k]) unknown.add(k); }); } catch {} });
if (unknown.size) console.log(`  ⚠ unknown category codes in data: ${[...unknown].join(', ')}`);
if (!zeroTime.length && !unknown.size) console.log('  All rows have times and known categories.');
console.log('');
