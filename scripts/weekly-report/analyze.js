// scripts/weekly-report/analyze.js
//
// Reads the fleet DB and computes the weekly numbers the report narrates.
// Pure data layer — no Claude, no email. Returns a plain object.
//
// Covers: revenue + bookings totals, week-over-week, year-over-year (when a
// year of history exists), OTA channel mix, per-tour occupancy, and bike
// rental performance.
//
// Capacities for occupancy come from scripts/weekly-report/config.js — edit
// those to match your real per-product seat caps.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { CAPACITIES, RENTAL_FEED_TYPES, TEST_SOURCES } = require('./config');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fleet.db');

function parseMoney(x) {
  if (x == null) return 0;
  const s = String(x).replace(/[^0-9.\-]/g, '');
  const v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

// ISO date string (YYYY-MM-DD) for `daysAgo` days before `ref`.
function isoDaysAgo(ref, days) {
  const d = new Date(ref);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Aggregate a set of booking rows into a summary.
function summarizeBookings(rows) {
  let gross = 0;
  const byProduct = {};
  const bySource = {};
  for (const b of rows) {
    const amt = parseMoney(b.total);
    gross += amt;
    const prod = b.feed_label || b.feed_id || 'Unknown';
    const src = (b.source || 'Direct/Website').trim() || 'Direct/Website';
    byProduct[prod] = byProduct[prod] || { gross: 0, count: 0 };
    byProduct[prod].gross += amt;
    byProduct[prod].count += 1;
    bySource[src] = bySource[src] || { gross: 0, count: 0 };
    bySource[src].gross += amt;
    bySource[src].count += 1;
  }
  return { gross, count: rows.length, byProduct, bySource };
}

function analyze({ asOf } = {}) {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys=ON;');

  const today = asOf ? new Date(asOf) : new Date();
  const todayIso = today.toISOString().slice(0, 10);

  // Booking windows are keyed on booking_created_at (when the sale happened),
  // which is what a "sales this week" report should reflect.
  const thisWeekStart = isoDaysAgo(todayIso, 7);
  const lastWeekStart = isoDaysAgo(todayIso, 14);
  const yoyThisStart = isoDaysAgo(todayIso, 365 + 7);
  const yoyThisEnd = isoDaysAgo(todayIso, 365);

  const allBookings = db
    .prepare(
      `SELECT b.ref, b.availability_id, b.feed_id, b.feed_type, b.source,
              b.total, b.booking_created_at, b.tour_start_date,
              a.feed_label, a.feed_type AS avail_feed_type
       FROM bookings b
       LEFT JOIN tour_availabilities a ON a.availability_id = b.availability_id`
    )
    .all();

  // Drop test bookings by source marker.
  const clean = allBookings.filter(
    (b) => !TEST_SOURCES.includes((b.source || '').trim())
  );

  const inRange = (b, start, end) => {
    const d = (b.booking_created_at || '').slice(0, 10);
    return d && d >= start && d < end;
  };

  const thisWeek = clean.filter((b) => inRange(b, thisWeekStart, todayIso));
  const lastWeek = clean.filter((b) => inRange(b, lastWeekStart, thisWeekStart));
  const yoyWeek = clean.filter((b) => inRange(b, yoyThisStart, yoyThisEnd));

  const tw = summarizeBookings(thisWeek);
  const lw = summarizeBookings(lastWeek);
  const yoy = summarizeBookings(yoyWeek);

  const pct = (cur, prev) =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;

  // --- Occupancy: tours that ran (started) in the last 7 days ---
  const toursRan = db
    .prepare(
      `SELECT availability_id, feed_id, feed_label, feed_type, guide,
              start_date, booking_count, total_bikes
       FROM tour_availabilities
       WHERE start_date >= ? AND start_date < ?`
    )
    .all(thisWeekStart, todayIso);

  const occupancyByProduct = {};
  for (const t of toursRan) {
    if ((t.feed_type || 'tour') === 'rental') continue;
    const key = t.feed_label || t.feed_id || 'Unknown';
    const cap = CAPACITIES[key] || CAPACITIES[t.feed_id] || null;
    occupancyByProduct[key] = occupancyByProduct[key] || {
      departures: 0,
      seats_sold: 0,
      capacity_per_departure: cap,
      seats_available: 0,
      zero_booking_departures: 0,
    };
    const o = occupancyByProduct[key];
    o.departures += 1;
    o.seats_sold += t.booking_count || 0;
    if (cap) o.seats_available += cap;
    if (!t.booking_count) o.zero_booking_departures += 1;
  }
  for (const k of Object.keys(occupancyByProduct)) {
    const o = occupancyByProduct[k];
    o.occupancy_pct = o.seats_available
      ? Math.round((o.seats_sold / o.seats_available) * 1000) / 10
      : null;
  }

  // --- Bike rentals performance ---
  const rentals = clean.filter((b) =>
    RENTAL_FEED_TYPES.includes(b.avail_feed_type || b.feed_type)
  );
  const rentalsThisWeek = rentals.filter((b) =>
    inRange(b, thisWeekStart, todayIso)
  );
  const rentalsLastWeek = rentals.filter((b) =>
    inRange(b, lastWeekStart, thisWeekStart)
  );
  const rentalSummary = {
    this_week: summarizeBookings(rentalsThisWeek),
    last_week: summarizeBookings(rentalsLastWeek),
  };
  rentalSummary.wow_gross_pct = pct(
    rentalSummary.this_week.gross,
    rentalSummary.last_week.gross
  );

  db.close();

  return {
    generated_at: new Date().toISOString(),
    as_of_date: todayIso,
    windows: {
      this_week: { start: thisWeekStart, end: todayIso },
      last_week: { start: lastWeekStart, end: thisWeekStart },
      yoy_week: { start: yoyThisStart, end: yoyThisEnd },
    },
    totals: {
      this_week: { gross: tw.gross, bookings: tw.count },
      last_week: { gross: lw.gross, bookings: lw.count },
      wow_gross_pct: pct(tw.gross, lw.gross),
      wow_bookings_pct: pct(tw.count, lw.count),
      yoy_available: yoy.count > 0,
      yoy: yoy.count > 0 ? { gross: yoy.gross, bookings: yoy.count } : null,
      yoy_gross_pct: yoy.count > 0 ? pct(tw.gross, yoy.gross) : null,
    },
    by_product_this_week: tw.byProduct,
    channel_mix_this_week: tw.bySource,
    occupancy: occupancyByProduct,
    rentals: rentalSummary,
  };
}

module.exports = { analyze, parseMoney };

if (require.main === module) {
  console.log(JSON.stringify(analyze(), null, 2));
}
