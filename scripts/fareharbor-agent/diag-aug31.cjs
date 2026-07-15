const {DatabaseSync}=require('node:sqlite');
const {guideMatches}=require('/var/www/becopenhagen-fleet/src/guide-name-match');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}

console.log('=== 1) What email was sent, exactly? ===');
db.prepare(`SELECT to_name,subject,sent_at FROM emails_sent
  WHERE subject LIKE '%31 Aug%' OR subject LIKE '%31 August%' ORDER BY sent_at DESC`).all()
  .forEach(r=>console.log(`  ${r.sent_at}  ${r.to_name}: ${r.subject}`));

console.log('\n=== 2) ALL A3P slots on 31 Aug in the app right now ===');
const rows=db.prepare(`SELECT availability_id,start_date,start_time,guide,booking_count,last_synced
  FROM tour_availabilities WHERE feed_id='A3P' AND start_date='2026-08-31' ORDER BY start_time`).all();
if(!rows.length) console.log('  ⚠ NO A3P rows on 2026-08-31 at all.');
rows.forEach(r=>console.log(`  ${r.start_time} guide=${r.guide||'—'} bookings=${r.booking_count} id=${r.availability_id} synced=${r.last_synced}`));

console.log('\n=== 3) The email said "13.45". Is there a 13.45 A3P that day? ===');
const s=db.prepare(`SELECT availability_id,guide,booking_count FROM tour_availabilities
  WHERE feed_id='A3P' AND start_date='2026-08-31' AND (start_time='13.45' OR start_time='13:45')`).all();
s.forEach(r=>console.log(`  found: guide=${r.guide||'—'} bookings=${r.booking_count} id=${r.availability_id}`));
if(!s.length) console.log('  (no 13.45 slot — the "assigned then cancelled" pair may have been the reissue)');

console.log('\n=== 4) Any A3P on 31 Aug that resolves to Federico? ===');
const fede=rows.find(r=>r.guide && guideMatches(r.guide,'Federico'));
console.log(fede ? `  ✓ ${fede.start_time} id=${fede.availability_id}` : '  ✗ No A3P on 31 Aug currently has Federico assigned.');

console.log('\n=== 5) Federico as a guide anywhere upcoming (to compare) ===');
db.prepare(`SELECT feed_id,start_date,start_time,guide FROM tour_availabilities
  WHERE guide LIKE '%ederico%' AND start_date>=date('now') ORDER BY start_date LIMIT 10`).all()
  .forEach(r=>console.log(`  ${r.start_date} ${r.feed_id} ${r.start_time} (${r.guide})`));
