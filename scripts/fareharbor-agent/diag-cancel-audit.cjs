const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}

console.log('=== 1) APP vs FareHarbor calendar (screenshot: 15th Monica, 17th Ibrahim, 22nd Andrew) ===');
['2026-07-15','2026-07-17','2026-07-22'].forEach(d=>{
  const rows=db.prepare(`SELECT feed_id,start_time,guide,booking_count,availability_id
    FROM tour_availabilities WHERE start_date=? AND (guide IS NOT NULL OR feed_id LIKE '%P') ORDER BY start_time`).all(d);
  console.log(`\n  ${d}:`);
  if(!rows.length) console.log('     (nothing)');
  rows.forEach(r=>console.log(`     ${r.feed_id} ${r.start_time} guide=${r.guide||'—'} bookings=${r.booking_count} id=${r.availability_id}`));
});

console.log('\n\n=== 2) Who got a "Tour cancelled" email, and for which slot? ===');
try{
  db.prepare(`SELECT to_name,subject,sent_at,ok FROM emails_sent
    WHERE category='tour_cancelled' ORDER BY sent_at DESC LIMIT 25`).all()
    .forEach(r=>console.log(`  ${r.sent_at}  ${(r.to_name||'?').padEnd(12)} ${r.ok?'':'(FAILED) '}${r.subject}`));
}catch(e){console.log('  (emails_sent:',e.message,')');}

console.log('\n\n=== 3) Cross-check: was that cancelled slot a real cancel or a reissue? ===');
console.log('  (if the same date/time still exists with a guide above, the cancel email was phantom)');
