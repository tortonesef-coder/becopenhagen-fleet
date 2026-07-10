#!/usr/bin/env node
// Recode guided-tour bike IDs:
//   "Guided Bike"       GTn -> Gn   (keeps the number)
//   "Guided Bike Small" GTn -> GSn  (renumbered GS1, GS2, ... by current id)
// The bike id is a primary key referenced by six tables, so this updates all of
// them atomically (foreign keys are ON, so we toggle them off for the swap).
//
// DRY RUN BY DEFAULT — prints the mapping and what it would touch, writes nothing.
// Add --commit to apply.
//
//   node scripts/fixes/recode-guided-bikes.js
//   node scripts/fixes/recode-guided-bikes.js --commit

const { getDb } = require('../../src/db/schema');
const db = getDb();
const COMMIT = process.argv.includes('--commit');

// tables/columns that reference a bike id
const REFS = [
  ['bike_status', 'bike_id'],
  ['bike_configurations', 'bike_id'],
  ['batteries', 'paired_bike_id'],
  ['action_log', 'bike_id'],
  ['repair_tickets', 'bike_id'],
  ['assignment_bikes', 'bike_id'],
];

// Guided bikes, with their type label.
const bikes = db.prepare(`
  SELECT b.id, b.name, b.type_id, t.label AS type_label
  FROM bikes b JOIN bike_types t ON t.id = b.type_id
  WHERE t.label LIKE 'Guided%'
  ORDER BY b.id
`).all();

if (bikes.length === 0) {
  console.log('No bikes found under a "Guided..." type. Nothing to do.');
  console.log('Types present:', db.prepare("SELECT id,label FROM bike_types ORDER BY sort_order").all().map(t => `${t.id}=${t.label}`).join(', '));
  process.exit(0);
}

const numOf = (id) => { const m = String(id).match(/(\d+)\s*$/); return m ? m[1] : null; };

// Build mapping. Small bikes get sequential GS numbers; regular keep their number.
let smallSeq = 0;
const mapping = [];
for (const b of bikes) {
  const isSmall = /small/i.test(b.type_label);
  let newId;
  if (isSmall) { smallSeq += 1; newId = 'GS' + smallSeq; }
  else { const n = numOf(b.id); newId = n ? 'G' + n : null; }
  mapping.push({ ...b, newId, isSmall });
}

// Validate: every bike got a new id, no collisions among new ids, and no new id
// already exists on a bike that isn't in this rename set.
const problems = [];
const renameOld = new Set(mapping.map(m => m.id));
const seenNew = new Set();
for (const m of mapping) {
  if (!m.newId) { problems.push(`Could not derive a new id for ${m.id} (no trailing number).`); continue; }
  if (seenNew.has(m.newId)) problems.push(`Two bikes map to the same new id ${m.newId}.`);
  seenNew.add(m.newId);
  const clash = db.prepare('SELECT 1 FROM bikes WHERE id=?').get(m.newId);
  if (clash && !renameOld.has(m.newId)) problems.push(`New id ${m.newId} already exists on another bike.`);
}

console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${mapping.length} guided bikes:\n`);
for (const m of mapping) {
  const refCounts = REFS.map(([t, c]) => {
    let n = 0; try { n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(m.id).n; } catch {}
    return n ? `${t}:${n}` : null;
  }).filter(Boolean);
  console.log(`  ${m.id.padEnd(6)} -> ${(m.newId||'??').padEnd(6)}  [${m.type_label}]  ${m.name || ''}${refCounts.length ? '   refs: ' + refCounts.join(', ') : ''}`);
}

if (problems.length) {
  console.log('\nCANNOT PROCEED:');
  problems.forEach(p => console.log('  - ' + p));
  process.exit(1);
}

if (!COMMIT) {
  console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
  process.exit(0);
}

// Apply: FK off, one transaction, update bikes + every referencing table.
db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  for (const m of mapping) {
    db.prepare('UPDATE bikes SET id=? WHERE id=?').run(m.newId, m.id);
    for (const [t, c] of REFS) {
      try { db.prepare(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`).run(m.newId, m.id); } catch (e) { console.error(`  (skip ${t}.${c}: ${e.message})`); }
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  db.exec('PRAGMA foreign_keys = ON');
  console.error('\nFAILED, rolled back:', e.message);
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON');

// Verify no dangling references remain to the old ids.
let dangling = 0;
for (const m of mapping) for (const [t, c] of REFS) {
  try { dangling += db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(m.id).n; } catch {}
}
console.log(`\nDone. Renamed ${mapping.length} bikes. Dangling old references remaining: ${dangling} (should be 0).`);
