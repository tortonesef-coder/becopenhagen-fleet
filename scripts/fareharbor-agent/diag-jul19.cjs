const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}
console.log('=== the two L3 tours from the screenshot ===');
db.prepare(`SELECT availability_id,start_date,start_time,guide,booking_count,bikes_needed,total_bikes
  FROM tour_availabilities WHERE feed_id='L3' AND start_date IN ('2026-07-17','2026-07-19') ORDER BY start_date`).all()
  .forEach(r=>{
    console.log(`\n  ${r.start_date} ${r.start_time} guide=${r.guide}`);
    console.log(`     booking_count(pax)=${r.booking_count}  total_bikes=${r.total_bikes}`);
    console.log(`     bikes_needed=${r.bikes_needed}`);
  });
console.log('\n=== does booking_count look like PAX now, or still reservations? ===');
console.log('  (screenshot L3 19 Jul had 3 bookings earlier; if pax, could be 3+ people)');
