const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}

console.log('=== Where did Federico last appear as an A3P guide? ===');
// guide assignments are also tracked in guide_tour_hours; and the assignment email log
try{
  console.log('\n-- guide_tour_hours for Federico / A3P --');
  db.prepare(`SELECT availability_id, guide, feed_id, start_date, start_at
    FROM guide_tour_hours WHERE feed_id LIKE 'A3%' AND (guide LIKE '%ederico%' OR guide LIKE '%ede%')
    ORDER BY start_date DESC LIMIT 10`).all().forEach(r=>console.log('  ',JSON.stringify(r)));
}catch(e){console.log('  (guide_tour_hours:',e.message,')');}

console.log('\n-- "Tour assigned" emails sent to Federico (the assignment that triggered the screenshot) --');
try{
  db.prepare(`SELECT subject, sent_at FROM emails_sent
    WHERE to_name LIKE '%ederico%' AND subject LIKE '%assigned%A3%' ORDER BY sent_at DESC LIMIT 10`).all()
    .forEach(r=>console.log('  ',r.sent_at,'|',r.subject));
}catch(e){console.log('  (emails_sent:',e.message,')');}

console.log('\n-- ANY A3P slot whose assignment history mentions Federico (change log) --');
try{
  db.prepare(`SELECT availability_id,start_date,field,old_value,new_value,created_at
    FROM tour_changes WHERE feed_id LIKE 'A3%' AND (new_value LIKE '%ede%' OR old_value LIKE '%ede%')
    ORDER BY created_at DESC LIMIT 10`).all().forEach(r=>console.log('  ',JSON.stringify(r)));
}catch(e){console.log('  (tour_changes table not present:',e.message,')');}

console.log('\nNOTE: if nothing shows, the assignment may only ever have existed on the now-deleted old-ID row.');
