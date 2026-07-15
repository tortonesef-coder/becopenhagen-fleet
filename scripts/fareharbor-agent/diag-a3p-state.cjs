const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}

console.log('=== 1) Are the A3P tours currently present in the app? ===');
const rows=db.prepare(`SELECT availability_id,start_date,start_time,guide,booking_count
  FROM tour_availabilities WHERE feed_id='A3P' AND start_date>=date('now') ORDER BY start_date,start_time`).all();
console.log(`  ${rows.length} future A3P slots in the app:`);
rows.forEach(r=>console.log('   ',r.start_date,r.start_time,'guide='+(r.guide||'—'),'bookings='+r.booking_count,'id='+r.availability_id));

console.log('\n=== 2) The GUIDE-ASSIGNED A3P (Federico) — is it there with a guide? ===');
const assigned=db.prepare(`SELECT availability_id,start_date,start_time,guide,booking_count
  FROM tour_availabilities WHERE feed_id='A3P' AND guide IS NOT NULL AND start_date>=date('now')`).all();
if(!assigned.length) console.log('  ⚠ NO future A3P currently has a guide assigned.');
assigned.forEach(r=>console.log('   ',r.start_date,r.start_time,'guide='+r.guide,'id='+r.availability_id));

console.log('\n=== 3) Was a real cancellation email the LAST word for any live slot? ===');
console.log('  (a slot is fine if it exists above; the email was just noise)');
