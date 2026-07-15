const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}
console.log('=== most recent last_synced across all tours (is the scraper running?) ===');
db.prepare(`SELECT MAX(last_synced) as newest, MIN(last_synced) as oldest, COUNT(*) n FROM tour_availabilities WHERE feed_type='tour'`).all()
  .forEach(r=>console.log(`  newest=${r.newest}  oldest=${r.oldest}  total=${r.n}`));
console.log('\n  (server time now:', new Date().toISOString(), ')');
console.log('\n=== the 10:15 A3P on 31 Aug — its booking_count now ===');
db.prepare(`SELECT start_time,guide,booking_count,last_synced FROM tour_availabilities WHERE feed_id='A3P' AND start_date='2026-08-31'`).all()
  .forEach(r=>console.log(`  ${r.start_time} guide=${r.guide||'—'} bookings=${r.booking_count} synced=${r.last_synced}`));
console.log('\n=== agent run log (recent successes / failures) ===');
try{ db.prepare(`SELECT * FROM fareharbor_agent_log ORDER BY created_at DESC LIMIT 8`).all().forEach(r=>console.log('  ',JSON.stringify(r))); }
catch(e){ try{ db.prepare(`SELECT * FROM agent_log ORDER BY created_at DESC LIMIT 8`).all().forEach(r=>console.log('  ',JSON.stringify(r))); }catch(e2){console.log('  (no agent log table:',e2.message,')');} }
