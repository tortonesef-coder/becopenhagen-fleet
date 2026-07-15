const {DatabaseSync}=require('node:sqlite');
const {guideMatches}=require('/var/www/becopenhagen-fleet/src/guide-name-match');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}

const members=db.prepare('SELECT id,name,email,active FROM team_members WHERE active=1').all();

console.log('=== The 3 imminent tours — will the assigned guide actually SEE them? ===\n');
const slots=[['2026-07-15','Monica'],['2026-07-17','Ibrahim'],['2026-07-22','Andrew']];
slots.forEach(([date])=>{
  const rows=db.prepare(`SELECT feed_id,start_time,guide,booking_count,end_at,start_at
    FROM tour_availabilities WHERE start_date=? AND guide IS NOT NULL AND booking_count>0`).all(date);
  rows.forEach(r=>{
    // does the endpoint's guide filter resolve this crew name to a real member?
    const matched=members.find(m=>guideMatches(r.guide,m.name));
    // will the time-window keep it? (end_at >= now-90min)
    const endOk=new Date(r.end_at.replace('Z','')) >= new Date(Date.now()-90*60000);
    // private + 0 bookings would be filtered — but these have bookings
    const privFiltered = r.feed_id.endsWith('P') && r.booking_count===0;
    console.log(`  ${date} ${r.feed_id} ${r.start_time}  crew-note guide="${r.guide}"`);
    console.log(`     -> matches team member: ${matched?('✓ '+matched.name+' <'+(matched.email||'no email')+'>'):'✗ NO MATCH — guide would NOT see this tour!'}`);
    console.log(`     -> within app time window: ${endOk?'✓':'✗ (too old / filtered)'}   private-zero-filtered: ${privFiltered?'✗ HIDDEN':'no'}`);
  });
});

console.log('\n=== sanity: do these exact guide names resolve cleanly? ===');
['Monica','Ibrahim','Andrew'].forEach(n=>{
  const m=members.find(mm=>guideMatches(n,mm.name));
  console.log(`  "${n}" -> ${m?m.name:'NO MATCH'}`);
});
