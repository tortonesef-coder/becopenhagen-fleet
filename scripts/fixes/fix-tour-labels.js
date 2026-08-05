#!/usr/bin/env node
// One-off fix: iCal's TOUR_FEEDS labels had drifted from the scraper's
// TOUR_ITEMS labels, so rows that iCal inserted first got the wrong feed_label
// — most visibly the Liveable City tours (L3/L2P/L3P) mislabeled "History Tour",
// e.g. a reminder email reading "Reminder — L3 …" with body "Tour: History Tour
// (3h)". Neither writer updates feed_label on conflict, so the wrong label is
// frozen on those rows and the ical.js config fix alone can't repair them.
//
// This rewrites feed_label from feed_id using the canonical labels (the ones the
// scraper and the corrected ical.js config now agree on), in both tables that
// carry feed_label. Rentals are left untouched (iCal-only, no conflict). Only
// rows whose label is already wrong are changed.
//
// Idempotent. Dry-run by default (prints what WOULD change); pass --commit to write.
//
// Usage:
//   node scripts/fixes/fix-tour-labels.js            # dry run
//   node scripts/fixes/fix-tour-labels.js --commit   # apply

const { getDb } = require('../../src/db/schema');

// Canonical tour label per feed_id (matches scraper TOUR_ITEMS and the
// corrected ical.js TOUR_FEEDS). feed_ids not listed here are left alone.
const CANONICAL = {
  L3:  'Liveable City Tour (3h)',
  L2P: 'Private Liveable City (2h)',
  L3P: 'Private Liveable City (3h)',
  A3:  'Architecture Tour (3h)',
  A3P: 'Private Architecture (3h)',
  F3:  'Food Tour (3h)',
  F3P: 'Private Food Tour (3h)',
  H3:  'History Tour (3h)',
  H3P: 'Private History (3h)',
  A3G: 'Architecture Tour German (3h)',
  A3F: 'Architecture Tour French (3h)',
  CUSTOM: 'Custom Tour',
};

const commit = process.argv.includes('--commit');
const db = getDb();
const TABLES = ['tour_availabilities', 'guide_tour_hours'];

let totalWrong = 0;
const plan = [];
for (const table of TABLES) {
  for (const [feedId, label] of Object.entries(CANONICAL)) {
    const rows = db.prepare(
      `SELECT feed_label, COUNT(*) n FROM ${table}
       WHERE feed_id = ? AND (feed_label IS NULL OR feed_label != ?)
       GROUP BY feed_label`
    ).all(feedId, label);
    for (const r of rows) {
      totalWrong += r.n;
      plan.push({ table, feedId, from: r.feed_label, to: label, n: r.n });
    }
  }
}

if (plan.length === 0) {
  console.log('Nothing to fix — all tour feed_labels already canonical.');
  process.exit(0);
}

console.log(`${commit ? 'APPLYING' : 'DRY RUN'} — ${totalWrong} row(s) to relabel:\n`);
for (const p of plan) {
  console.log(`  [${p.table}] ${p.feedId}: ${JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}  (${p.n})`);
}

if (!commit) {
  console.log('\nDry run only. Re-run with --commit to apply.');
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
try {
  let changed = 0;
  for (const table of TABLES) {
    for (const [feedId, label] of Object.entries(CANONICAL)) {
      const res = db.prepare(
        `UPDATE ${table} SET feed_label = ?
         WHERE feed_id = ? AND (feed_label IS NULL OR feed_label != ?)`
      ).run(label, feedId, label);
      changed += res.changes;
    }
  }
  db.exec('COMMIT');
  console.log(`\nDone. ${changed} row(s) relabeled.`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Rolled back:', e.message);
  process.exit(1);
}
