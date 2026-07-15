const {DatabaseSync}=require('node:sqlite');
let db; for(const p of ['/var/www/becopenhagen-fleet/data/fleet.db','./data/fleet.db']){try{db=new DatabaseSync(p,{readOnly:true});break;}catch{}}
if(!db){console.log('run on server');process.exit(0);}
console.log('=== Hassan (the template) + is Dimitra already in the table? ===');
db.prepare("SELECT id,name,role,active,is_guide,can_shop,view_mode,email,needs_password_setup FROM team_members WHERE name LIKE '%assan%' OR name LIKE '%imitra%'").all()
  .forEach(r=>console.log(' ',JSON.stringify(r)));
console.log('\n=== all columns on team_members (so we create her correctly) ===');
db.prepare("PRAGMA table_info(team_members)").all().forEach(c=>console.log('  '+c.name+' ('+c.type+')'));
