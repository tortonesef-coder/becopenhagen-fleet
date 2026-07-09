#!/usr/bin/env node
// Splits the "Guided Tour Bikes" fleet category into two:
//   "Guided Bike"        (the existing type, renamed)  — 9 bikes
//   "Guided Bike Small"  (new type)                    — 2 bikes
// This script renames the existing type and CREATES the new one (copying the
// FareHarbor resource + rental value so nothing else changes). It does NOT move
// bikes — do that in the Fleet tab (edit a bike → pick "Guided Bike Small"),
// which is why Zac now has Fleet access. Idempotent.
//
//   node scripts/fixes/split-guided-bike-type.js

const { getDb } = require('../../src/db/schema');
const db = getDb();

// Find the guided-tour type (defined in the live DB, not the seed).
const gt = db.prepare(
  `SELECT * FROM bike_types WHERE label LIKE 'Guided%' ORDER BY sort_order LIMIT 1`
).get();

if (!gt) {
  console.log('No "Guided..." bike type found. Nothing to do.');
  console.log('Existing types:', db.prepare('SELECT id,label FROM bike_types ORDER BY sort_order').all().map(t => `${t.id}=${t.label}`).join(', '));
  process.exit(0);
}

console.log(`Found guided type: id=${gt.id}  label="${gt.label}"  fareharbor_resource="${gt.fareharbor_resource || ''}"`);
const bikes = db.prepare('SELECT id, name, frame_size, active FROM bikes WHERE type_id=? ORDER BY id').all(gt.id);
console.log(`Bikes currently in this type (${bikes.length}):`);
bikes.forEach(b => console.log(`  ${b.id}  ${b.name || ''}  ${b.frame_size ? 'size ' + b.frame_size : ''}${b.active ? '' : '  (inactive)'}`));

// 1) Rename the existing type -> "Guided Bike"
if (gt.label !== 'Guided Bike') {
  db.prepare('UPDATE bike_types SET label=? WHERE id=?').run('Guided Bike', gt.id);
  console.log(`\nRenamed "${gt.label}" -> "Guided Bike" (id ${gt.id} unchanged, so nothing referencing it breaks).`);
} else {
  console.log('\n"Guided Bike" already named.');
}

// 2) Create "Guided Bike Small" if it doesn't exist yet
const smallId = gt.id + 'S';
const existingSmall = db.prepare(`SELECT id FROM bike_types WHERE id=? OR label='Guided Bike Small'`).get(smallId);
if (!existingSmall) {
  db.prepare(`INSERT INTO bike_types (id,label,fareharbor_resource,rental_value_dkk,demand_level,sort_order) VALUES (?,?,?,?,?,?)`)
    .run(smallId, 'Guided Bike Small', gt.fareharbor_resource || null, gt.rental_value_dkk || 0, gt.demand_level || 3, gt.sort_order);
  console.log(`Created new type: id=${smallId}  label="Guided Bike Small" (same FareHarbor resource + rental value as Guided Bike).`);
} else {
  console.log(`"Guided Bike Small" already exists (id ${existingSmall.id}).`);
}

console.log(`\nDone. Next: in the Fleet tab, edit the 2 small bikes and set their type to "Guided Bike Small".`);
console.log(`That leaves ${bikes.length - 2} in "Guided Bike" and 2 in "Guided Bike Small".`);
