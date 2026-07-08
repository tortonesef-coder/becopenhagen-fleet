#!/usr/bin/env node
// One-off fix: two separate bugs surfaced bad bike counts sitting in the DB:
// 1. A group tour (L3) showed 0.24 bikes — frozen stale data from before
//    v2's bike-authority was scoped to private tours only. Once scoped off,
//    v2 stopped touching group tours entirely, so it could never correct
//    the bad value it had written earlier — it just sat there forever.
// 2. A private tour (A3P) showed 31 bikes for 6 people — turned out to
//    exactly match the fleet's total Adult Bike count. The generic "Adult
//    Bike" resource apparently sometimes reports pool capacity instead of a
//    per-booking count, unlike the dedicated "Guided Tour Bikes" resource
//    (the only one we've actually confirmed reliable).
//
// The code is now fixed to only ever trust "Guided Tour Bikes" specifically.
// This script resets every tour's stored bike data to empty so the very
// next sync cycle recomputes cleanly: private tours using Guided Tour Bikes
// get a correct number again within the hour; everything else correctly
// shows "own bikes" until proven otherwise, instead of a wrong number.
//
// Safe to run multiple times — idempotent, just resets state.
//
// Usage: node scripts/fixes/reset-tour-bike-data.js

const { getDb } = require('../../src/db/schema');

const db = getDb();

const result = db.prepare(`
  UPDATE tour_availabilities
  SET bikes_needed = '{}', total_bikes = 0
  WHERE feed_type = 'tour' AND total_bikes != 0
`).run();

console.log(`Reset bike data on ${result.changes} tour rows. Next sync (v2 hourly, iCal 90s) will recompute correctly.`);
