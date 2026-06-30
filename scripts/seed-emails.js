const { getDb } = require('../src/db/schema');
const db = getDb();

const emails = {
  fede: 'federico@becopenhagen.dk',
  hassan: 'hassan@becopenhagen.dk',
  zac: 'zacharie.bedecarrax@gmail.com',
  pam: 'palomalopezgp@gmail.com',
  feidhlim: 'gleesol@tcd.ie',
  ibrahim: 'ibrahim-kb@posteo.de',
  monica: 'monicadelbasso17@gmail.com',
  andrew: 'armiller825@gmail.com',
};

const upd = db.prepare('UPDATE team_members SET email=? WHERE id=?');
let count = 0;
for (const [id, email] of Object.entries(emails)) {
  const result = upd.run(email, id);
  if (result.changes > 0) { console.log(`Set ${id} -> ${email}`); count++; }
  else console.log(`WARNING: ${id} not found in team_members`);
}
console.log(`Done. ${count} emails set.`);
