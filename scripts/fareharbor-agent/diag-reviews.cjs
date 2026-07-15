const {DatabaseSync}=require('node:sqlite');
let db;
for (const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']) {
  try { db=new DatabaseSync(p,{readOnly:true}); console.log('db:',p,'\n'); break; } catch {}
}
if(!db){console.log('no db locally — run this on the server');process.exit(0);}
console.log('=== raw guide_reviews rows ===');
db.prepare('SELECT id, guide_id, review_date, platform, booking_type FROM guide_reviews ORDER BY id DESC LIMIT 10').all()
  .forEach(r=>console.log(' ',JSON.stringify(r)));
console.log('\n=== the JOIN the API does — any rows LOST? ===');
const joined=db.prepare('SELECT gr.id, gr.guide_id, tm.name FROM guide_reviews gr JOIN team_members tm ON tm.id=gr.guide_id').all();
const all=db.prepare('SELECT id, guide_id FROM guide_reviews').all();
console.log('  total reviews:', all.length, ' | rows surviving the JOIN:', joined.length);
const survivors=new Set(joined.map(r=>r.id));
all.filter(r=>!survivors.has(r.id)).forEach(r=>console.log('  DROPPED by JOIN:', JSON.stringify(r), '-> guide_id not in team_members'));
console.log('\n=== Monica in team_members? ===');
db.prepare("SELECT id,name,active FROM team_members WHERE name LIKE '%onica%' OR id LIKE '%onica%'").all().forEach(r=>console.log(' ',JSON.stringify(r)));
