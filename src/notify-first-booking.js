// Fires the "first booking" notifications (guide email + admin alert) for a
// tour availability, EXACTLY ONCE, claimed atomically. Both the FareHarbor
// webhook (which knows the instant a booking lands) and the iCal sync (which
// covers Airbnb, since Airbnb never fires our webhook) call this. The atomic
// claim means whichever gets there first sends, and the other is a no-op — so
// no double emails and no missed emails from the old race where the webhook
// bumped booking_count before the 90s sync could see the 0->1 transition.

const { getDb, isNotifEnabled } = require('./db/schema');
const { sendEmail, EMAIL_FOOTER } = require('./email');
const { createNotification } = require('./routes/admin-notifs');
const { guideMatches } = require('./guide-name-match');

function db() { return getDb(); }

// notifyFirstBooking(availabilityId, opts?)
//   opts.testEmailTo — send the guide email to THIS address instead of the
//                      guide's, skip the admin alert, and do NOT set the
//                      "notified" flag (so it's repeatable for testing).
// Returns true if this call did the notifying.
function notifyFirstBooking(availabilityId, opts = {}) {
  const test = opts.testEmailTo || null;
  try {
    if (!test) {
      // Atomic claim: only the first caller to flip 0->1 proceeds.
      const res = db().prepare(
        `UPDATE tour_availabilities SET first_booking_notified=1
          WHERE availability_id=? AND first_booking_notified=0
            AND feed_type='tour' AND booking_count>=1`
      ).run(String(availabilityId));
      if (res.changes === 0) return false; // already notified, no booking, or not a tour
    }

    const t = db().prepare(
      `SELECT availability_id, feed_id, feed_label, guide, start_date, start_time, end_time, booking_count
         FROM tour_availabilities WHERE availability_id=?`
    ).get(String(availabilityId));
    if (!t) return false;

    const todayStr = new Date().toISOString().substring(0, 10);
    if (!test && (!t.start_date || t.start_date < todayStr)) return false; // never notify for past tours

    const dateLbl = t.start_date
      ? new Date(t.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
      : (t.start_date || '');

    // Admin alert — first booking on a tour within the next 7 days.
    if (!test) {
      const sevenDays = new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10);
      if (t.start_date >= todayStr && t.start_date <= sevenDays) {
        createNotification(
          'first_booking_soon',
          `First booking: ${t.feed_id} on ${dateLbl}`,
          `${t.start_time || ''} — ${t.booking_count} booking${t.booking_count !== 1 ? 's' : ''}${t.guide ? ` — guide: ${t.guide}` : ' — no guide assigned yet'}.`,
          t.availability_id
        );
      }
    }

    // Guide email
    if (!t.guide) return true; // no guide yet — admin alert covers it
    const member = db().prepare('SELECT id, name, email FROM team_members WHERE active=1').all()
      .find(m => guideMatches(t.guide, m.name));
    if (!member?.email) return true;
    if (!test && !isNotifEnabled(member.id, 'first_booking')) return true;

    const to = test || member.email;
    const subject = `${test ? '[TEST] ' : ''}First booking — ${t.feed_id} on ${dateLbl}`;
    const htmlContent = `
      <p>Hi ${member.name}${test ? ' (test copy sent to your address)' : ''},</p>
      <p>Your first booking just came in for:</p>
      <table style="border-collapse:collapse;margin:0.5rem 0">
        <tr><td style="padding:3px 12px 3px 0;color:#888">Tour</td><td>${t.feed_label || t.feed_id}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLbl}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#888">Time</td><td>${t.start_time || ''}${t.end_time ? ' – ' + t.end_time : ''}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#888">Bookings</td><td>${t.booking_count}</td></tr>
      </table>
      ${EMAIL_FOOTER}`;
    sendEmail({ to, toName: member.name, subject, htmlContent, category: 'first_booking' })
      .catch(err => console.error('Email error (first booking):', err.message));
    return true;
  } catch (e) {
    console.error('notifyFirstBooking error:', e.message);
    return false;
  }
}

module.exports = { notifyFirstBooking };
