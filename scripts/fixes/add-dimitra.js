#!/usr/bin/env node
// Add Dimitra as a new team member — GUIDE + SHOP, the same capability set as
// Hassan (leads tours AND works the rental shop). She's already the crew on many
// August F3 tours in FareHarbor, so she just needs her app account.
//
// Capabilities (see the roles->capabilities->views model):
//   role='guide'        — base role
//   is_guide=1          — leads tours (Guide view: Action, Tours, Profile, Log)
//   can_shop=1          — shop work (Shop view: Today, Action, Repairs, Tours,
//                         Rentals, Bikes, Log)
//   needs_password_setup=1 — she sets her own password via the emailed link
// With both capabilities she gets a view switcher, exactly like Hassan.
//
// Usage:
//   node scripts/fixes/add-dimitra.js --email=dimitra@example.com [--commit]
// Dry-run by default; prints what it would do. Pass --commit to write.

const { getDb } = require('../../src/db/schema');

const args = process.argv.slice(2);
const emailArg = (args.find(a => a.startsWith('--email=')) || '').split('=')[1];
const commit = args.includes('--commit');

if (!emailArg) {
  console.error('Missing --email. Usage: node scripts/fixes/add-dimitra.js --email=her@email.com [--commit]');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();

const db = getDb();

// Stable, lowercase id like the others ('hassan', 'monica', ...).
const id = 'dimitra';
const name = 'Dimitra';

const existing = db.prepare('SELECT id, name, email FROM team_members WHERE id=? OR lower(email)=lower(?)').get(id, email);
if (existing) {
  console.log(`A member already exists (${existing.name}, id=${existing.id}, email=${existing.email || 'none'}).`);
  console.log('Not creating a duplicate. If you need to update her, edit the row directly.');
  process.exit(0);
}

console.log(`Will ${commit ? 'CREATE' : '(dry-run) create'}:`);
console.log(`  id=${id}  name=${name}  email=${email}`);
console.log(`  role=guide  is_guide=1  can_shop=1  active=1  needs_password_setup=1`);
console.log(`  -> same capabilities as Hassan (guide + shop, gets a view switcher)`);

if (!commit) {
  console.log('\nDry-run only. Re-run with --commit to write.');
  process.exit(0);
}

db.prepare(`
  INSERT INTO team_members (id, name, role, active, email, is_guide, can_shop, needs_password_setup)
  VALUES (?, ?, 'guide', 1, ?, 1, 1, 1)
`).run(id, name, email);

console.log('\n✓ Dimitra created.');
console.log('Next: she opens the app, taps "Set up / forgot password", enters this email,');
console.log('and follows the link to choose her password. (Or trigger it from the admin');
console.log('Guides tab.) Her crew name on FareHarbor tours will resolve to this account.');
