#!/usr/bin/env node
// Adds an "External" bike type plus a handful of reusable placeholder bikes
// (EXT1..EXT6) for lifesaver bikes borrowed from the rental shop across the
// street. Checking one out / returning it then works like any other bike, and
// it flows through the Today board. Idempotent — safe to re-run (bump COUNT to
// add more placeholders later).
//
//   node scripts/fixes/add-external-bikes.js

const { getDb } = require('../../src/db/schema');
const db = getDb();
const COUNT = 6;

// 1) The "External" type
const existing = db.prepare(`SELECT id FROM bike_types WHERE id='EXT' OR label='External'`).get();
const typeId = existing?.id || 'EXT';
if (!existing) {
  const maxSort = db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 AS s FROM bike_types`).get().s;
  db.prepare(`INSERT INTO bike_types (id,label,fareharbor_resource,rental_value_dkk,demand_level,sort_order) VALUES (?,?,?,?,?,?)`)
    .run(typeId, 'External', null, 0, 1, maxSort);
  console.log(`Created bike type ${typeId} = "External".`);
} else {
  console.log(`"External" type already exists (${typeId}).`);
}

// 2) Placeholder bikes EXT1..EXTn
let created = 0;
for (let i = 1; i <= COUNT; i++) {
  const id = 'EXT' + i;
  const has = db.prepare(`SELECT 1 FROM bikes WHERE id=?`).get(id);
  if (has) continue;
  db.prepare(`INSERT INTO bikes (id,type_id,name,active) VALUES (?,?,?,1)`).run(id, typeId, `External bike ${i}`);
  db.prepare(`INSERT OR IGNORE INTO bike_status (bike_id,status,updated_by) VALUES (?, 'available', 'setup')`).run(id);
  created++;
}
console.log(`External placeholder bikes: created ${created}, total now ${db.prepare(`SELECT COUNT(*) n FROM bikes WHERE type_id=?`).get(typeId).n}.`);
console.log('Done. Check one out at Action → Rental/Tour → "+ External bike", and return it when it goes back across the street.');
