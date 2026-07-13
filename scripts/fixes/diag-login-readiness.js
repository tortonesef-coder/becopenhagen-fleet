#!/usr/bin/env node
// DIAGNOSTIC ONLY — read-only. Before switching the login screen from
// "pick your name" to "email + password", check nobody gets locked out:
// everyone active needs (a) an email on file and (b) a password already set.
//
//   node scripts/fixes/diag-login-readiness.js

const { getDb } = require('../../src/db/schema');
const db = getDb();

const team = db.prepare(`
  SELECT id, name, role, email, needs_password_setup, (password_hash IS NOT NULL) AS has_pw
  FROM team_members WHERE active=1 ORDER BY role, name
`).all();

console.log('\nActive team — readiness for email+password login:\n');
const blocked = [];
const dupes = {};
team.forEach(m => {
  const e = (m.email || '').trim().toLowerCase();
  if (e) dupes[e] = (dupes[e] || 0) + 1;
  const issues = [];
  if (!e) issues.push('NO EMAIL');
  if (m.needs_password_setup || !m.has_pw) issues.push('NO PASSWORD SET');
  if (issues.length) blocked.push({ ...m, issues });
  console.log(`  ${(m.name||'').padEnd(12)} ${(m.role||'').padEnd(9)} ${(m.email||'—').padEnd(32)} ${issues.length ? '⚠ ' + issues.join(' + ') : 'ok'}`);
});

const dupeList = Object.entries(dupes).filter(([, n]) => n > 1);
console.log(`\nSummary: ${team.length} active, ${blocked.length} would be LOCKED OUT.`);
if (dupeList.length) {
  console.log('\nDUPLICATE EMAILS (email login would be ambiguous):');
  dupeList.forEach(([e, n]) => console.log(`  ${e} — used by ${n} people`));
}
if (blocked.length) {
  console.log('\nThese people cannot log in with email+password until fixed:');
  blocked.forEach(m => console.log(`  ${m.name}: ${m.issues.join(' + ')}${m.email ? '' : '  (add an email first)'}`));
  console.log('\nOptions: add their emails + have them set a password BEFORE the switch,');
  console.log('or keep a "first time here? set your password" link on the new login screen.');
} else {
  console.log('\nEveryone can log in with email + password. Safe to switch.');
}
console.log('');
