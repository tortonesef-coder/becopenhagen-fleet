// Logs every meaningful change to a tour_availabilities row (guide, booking
// count, cancellation) so we can trace exactly what happened and when —
// which sync wrote which value, in what order. This is what would have let
// us find the "Spanish tour" oscillation bug in minutes instead of hours.

function logTourChange(db, { availability_id, feed_id, start_date, field, old_value, new_value, source }) {
  // Skip no-op logs (both null/undefined, or identical values)
  if ((old_value ?? null) === (new_value ?? null)) return;
  try {
    db.prepare(`
      INSERT INTO tour_change_log (availability_id, feed_id, start_date, field, old_value, new_value, source)
      VALUES (?,?,?,?,?,?,?)
    `).run(availability_id, feed_id || null, start_date || null, field, old_value ?? null, new_value ?? null, source || null);
  } catch (e) {
    console.error('Failed to log tour change:', e.message);
  }
}

module.exports = { logTourChange };
