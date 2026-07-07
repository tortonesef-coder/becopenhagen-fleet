/**
 * Log retention — deletes log/audit rows older than RETENTION_DAYS.
 * Runs once on startup, then every 24 hours.
 *
 * Scope: high-volume audit tables only (action_log, tour_change_log,
 * page_views, emails_sent, dismissed admin_notifications, expired
 * tour_reminders). Does NOT touch business data like bookings, invoices,
 * bug_reports, or guide_unavailability — those aren't "log noise" and
 * should be kept regardless of age.
 */

const { getDb } = require('./db/schema');

const RETENTION_DAYS = 120;

function db() { return getDb(); }

function runCleanup() {
  try {
    const cutoff = `-${RETENTION_DAYS} days`;
    const results = {};

    results.action_log = db().prepare(`DELETE FROM action_log WHERE created_at < datetime('now', ?)`).run(cutoff).changes;
    results.tour_change_log = db().prepare(`DELETE FROM tour_change_log WHERE created_at < datetime('now', ?)`).run(cutoff).changes;
    results.page_views = db().prepare(`DELETE FROM page_views WHERE created_at < datetime('now', ?)`).run(cutoff).changes;
    results.emails_sent = db().prepare(`DELETE FROM emails_sent WHERE sent_at < datetime('now', ?)`).run(cutoff).changes;
    // Only clean up admin_notifications that were already dismissed/resolved —
    // never delete something still active and unseen
    results.admin_notifications = db().prepare(`DELETE FROM admin_notifications WHERE dismissed=1 AND created_at < datetime('now', ?)`).run(cutoff).changes;
    // tour_reminders is just a dedup marker table — safe to prune old entries
    results.tour_reminders = db().prepare(`DELETE FROM tour_reminders WHERE sent_at < datetime('now', ?)`).run(cutoff).changes;

    const total = Object.values(results).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log(`Log retention cleanup (${RETENTION_DAYS}d): removed ${total} rows —`, results);
    }
  } catch (e) {
    console.error('Log retention cleanup failed:', e.message);
  }
}

function startLogRetention() {
  runCleanup();
  setInterval(runCleanup, 24 * 60 * 60 * 1000); // every 24h
}

module.exports = { startLogRetention, runCleanup, RETENTION_DAYS };
