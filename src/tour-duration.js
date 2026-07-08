// Single source of truth for a tour's buffered duration in minutes, used for
// guide worked-hours. Imported by BOTH ical.js and the v2 scraper so the two
// can never drift apart — the F3 duration bug came from each keeping its own
// copy of this sum.
//
// Duration = tour length + prep buffer. Food Tour (F3/F3P) needs 30 min before
// and after (60 total); every other tour keeps 15+15 (30 total). When the
// start/end times are missing or invalid, fall back to a sensible whole-tour
// estimate rather than 0 so a malformed slot doesn't silently zero a guide's
// hours.
function computeBufferedMinutes(startIso, endIso, feedId) {
  const isFoodTour = feedId === 'F3' || feedId === 'F3P';
  const buffer = isFoodTour ? 60 : 30;
  const fallback = isFoodTour ? 240 : 210;
  if (!startIso || !endIso) return fallback;
  const raw = Math.round((new Date(endIso) - new Date(startIso)) / 60000);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return raw + buffer;
}

module.exports = { computeBufferedMinutes };
