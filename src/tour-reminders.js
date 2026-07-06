/**
 * Tour reminders — emails assigned guides ~16 hours before their tour.
 *
 * Runs every hour. Uses tour_reminders table to ensure each tour is
 * only notified once even across server restarts.
 */

const { getDb } = require('./db/schema');
const { sendEmail } = require('./email');

function db() { return getDb(); }

async function sendReminders() {
  try {
    // Find tours starting between 15h and 17h from now with an assigned guide
    // that haven't been reminded yet. Times stored as ISO UTC strings.
    const tours = db().prepare(`
      SELECT ta.*, tm.name as guide_name, tm.email as guide_email
      FROM tour_availabilities ta
      JOIN team_members tm ON (tm.name = ta.guide OR tm.name LIKE '%' || ta.guide || '%')
      WHERE ta.feed_type = 'tour'
        AND ta.guide IS NOT NULL
        AND tm.email IS NOT NULL
        AND tm.active = 1
        AND datetime(replace(replace(ta.start_at,'T',' '),'Z','')) BETWEEN datetime('now', '+15 hours') AND datetime('now', '+17 hours')
        AND ta.availability_id NOT IN (SELECT availability_id FROM tour_reminders)
    `).all();

    for (const tour of tours) {
      const bookings = JSON.parse(tour.bookings_json || '[]');
      const dateLabel = new Date(tour.start_date).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });

      const bikesNeeded = JSON.parse(tour.bikes_needed || '{}');
      const bikeLines = Object.entries(bikesNeeded)
        .filter(([, n]) => n > 0)
        .map(([type, n]) => `${n}× ${type}`)
        .join(', ') || 'None';

      const bookingRows = bookings.length === 0
        ? '<tr><td colspan="2" style="color:#888;padding:4px 0">No bookings yet</td></tr>'
        : bookings.map(b => `
            <tr>
              <td style="padding:4px 12px 4px 0;font-weight:600">${b.name || 'Unknown'}</td>
              <td style="padding:4px 0;color:#555">${b.what || ''}</td>
            </tr>`).join('');

      const subject = `Reminder — ${tour.feed_id} tomorrow at ${tour.start_time}`;
      const htmlContent = `
        <p>Hi ${tour.guide_name},</p>
        <p>Reminder — you have a tour tomorrow:</p>
        <table style="border-collapse:collapse;margin:0.5rem 0 1rem">
          <tr><td style="padding:3px 12px 3px 0;color:#888">Tour</td><td>${tour.feed_label || tour.feed_id}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLabel}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#888">Time</td><td>${tour.start_time}${tour.end_time ? ' – ' + tour.end_time : ''}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#888">Bookings</td><td>${bookings.length}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#888">Bikes needed</td><td>${bikeLines}</td></tr>
        </table>
        ${bookings.length > 0 ? `
          <p style="font-weight:600;margin-bottom:0.25rem">Guest list:</p>
          <table style="border-collapse:collapse">
            ${bookingRows}
          </table>` : ''}
        <p style="margin-top:1rem">See full details in the app.</p>
        <p style="color:#888;font-size:0.9em">— BeCopenhagen</p>
      `;

      await sendEmail({
        to: tour.guide_email,
        toName: tour.guide_name,
        subject,
        htmlContent,
      }).catch(e => console.error(`Reminder email failed for ${tour.guide_name}:`, e.message));

      // Mark as reminded
      db().prepare(`INSERT OR IGNORE INTO tour_reminders (availability_id) VALUES (?)`).run(tour.availability_id);
      console.log(`Tour reminder sent to ${tour.guide_name} for ${tour.feed_id} on ${tour.start_date}`);
    }
  } catch (e) {
    console.error('Tour reminder error:', e.message);
  }
}

function startReminders() {
  // Run immediately on startup then every hour
  sendReminders();
  setInterval(sendReminders, 60 * 60 * 1000);
}

module.exports = { startReminders };
