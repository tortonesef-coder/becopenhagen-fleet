// scripts/weekly-report/config.js
//
// Edit these to match your business. This is the one file you'll touch when
// products, caps, or channel names change.

// Per-departure seat capacity, keyed by feed_label (as stored in
// tour_availabilities.feed_label) or feed_id. Occupancy = seats_sold /
// (departures * capacity). Products without an entry here are reported with
// raw seats-sold but no occupancy percentage.
//
// TODO CONFIRM: fill in your real caps. F3 is 10 per your food-tour relaunch.
const CAPACITIES = {
  'A3': 12,
  'L3': 12,
  'F3': 10,
  'H3': 12,
  // private tours (A3P/L3P/F3P) are single-group; occupancy % is less
  // meaningful for them, so leave them out unless you want it.
};

// Which feed_type values represent bike rentals (vs guided tours).
const RENTAL_FEED_TYPES = ['rental'];

// bookings.source values that mark internal test bookings to exclude.
const TEST_SOURCES = ['Test', 'test', 'Internal Test'];

module.exports = { CAPACITIES, RENTAL_FEED_TYPES, TEST_SOURCES };
