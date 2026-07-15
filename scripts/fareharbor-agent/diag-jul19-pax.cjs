const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}
console.log('19 Jul L3 + 31 Aug A3P — stored booking_count (should be PAX):');
db.prepare(`SELECT feed_id,start_date,start_time,guide,booking_count,total_bikes,bikes_needed
  FROM tour_availabilities WHERE (feed_id='L3' AND start_date='2026-07-19') OR (feed_id='A3P' AND start_date='2026-08-31' AND start_time IN ('13.45','13:45'))`).all()
  .forEach(r=>console.log(`  ${r.start_date} ${r.feed_id} ${r.start_time} guide=${r.guide} booking_count=${r.booking_count} total_bikes=${r.total_bikes} bikes=${r.bikes_needed}`));
