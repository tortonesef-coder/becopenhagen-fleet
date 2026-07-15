const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}
console.log('=== recent A3P change-log entries ===');
try{
  db.prepare(`SELECT availability_id, field, old_value, new_value, source, created_at
    FROM tour_changes WHERE feed_id='A3P' ORDER BY created_at DESC LIMIT 15`).all()
    .forEach(r=>console.log(' ',JSON.stringify(r)));
}catch(e){console.log('  (tour_changes table:',e.message,')');}
console.log('\n=== A3P rows currently in tour_availabilities ===');
db.prepare(`SELECT availability_id, start_date, start_time, guide, booking_count, last_synced
  FROM tour_availabilities WHERE feed_id='A3P' ORDER BY start_date DESC LIMIT 10`).all()
  .forEach(r=>console.log(' ',JSON.stringify(r)));
console.log('\n=== was a cancel notification claimed for an A3P? ===');
db.prepare(`SELECT * FROM tour_cancel_notified ORDER BY availability_id DESC LIMIT 10`).all()
  .forEach(r=>console.log(' ',JSON.stringify(r)));
