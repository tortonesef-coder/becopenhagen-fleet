/**
 * Tour reminders — emails assigned guides ~16 hours before their tour.
 *
 * Runs every hour. Uses tour_reminders table to ensure each tour is
 * only notified once even across server restarts.
 */

const { getDb, isNotifEnabled } = require('./db/schema');
const { sendEmail, EMAIL_FOOTER } = require('./email');
const { guideMatches } = require('./guide-name-match');

function db() { return getDb(); }

async function sendReminders() {
  try {
    // Find tours starting between 15h and 17h from now with an assigned guide
    // that haven't been reminded yet. Times stored as ISO UTC strings.
    const rawTours = db().prepare(`
      SELECT * FROM tour_availabilities
      WHERE feed_type = 'tour'
        AND guide IS NOT NULL
        AND booking_count > 0
        AND datetime(replace(replace(start_at,'T',' '),'Z','')) BETWEEN datetime('now', '+15 hours') AND datetime('now', '+17 hours')
        AND availability_id NOT IN (SELECT availability_id FROM tour_reminders)
    `).all();
    // booking_count > 0: a zero-booking tour is open capacity, not a tour the
    // guide will run — most commonly a private slot whose booking was CANCELLED
    // but whose crew assignment was never removed in FareHarbor (the cancel
    // deletes our row via iCal, then the scraper re-inserts the still-standing
    // slot from the calendar WITH its stale crew → guide set, bookings 0).
    // Ibrahim got a "Reminder — A3P tomorrow, Bookings 0" for exactly that, 3
    // days after the cancellation email. Filtering in the query (rather than
    // claiming+skipping) means a last-minute booking inside the reminder
    // window still gets its reminder on a later hourly pass.

    const activeMembers = db().prepare(`SELECT id, name, email FROM team_members WHERE active=1 AND email IS NOT NULL`).all();

    const tours = rawTours.map(t => {
      const member = activeMembers.find(m => guideMatches(t.guide, m.name));
      if (!member) return null;
      return { ...t, guide_id: member.id, guide_name: member.name, guide_email: member.email };
    }).filter(Boolean);

    for (const tour of tours) {
      // Always mark as reminded so we don't retry even if pref is off
      db().prepare(`INSERT OR IGNORE INTO tour_reminders (availability_id) VALUES (?)`).run(tour.availability_id);
      if (!isNotifEnabled(tour.guide_id, 'tour_reminder')) continue;

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
        ${EMAIL_FOOTER}
      `;

      await sendEmail({
        to: tour.guide_email,
        toName: tour.guide_name,
        subject,
        htmlContent,
        category: 'tour_reminder',
      }).catch(e => console.error(`Reminder email failed for ${tour.guide_name}:`, e.message));

      console.log(`Tour reminder sent to ${tour.guide_name} for ${tour.feed_id} on ${tour.start_date}`);
    }
  } catch (e) {
    console.error('Tour reminder error:', e.message);
  }
}

async function sendInvoiceReminders() {
  try {
    const now = new Date();
    if (now.getUTCDate() !== 20) return; // only on the 20th

    const monthName = now.toLocaleString('en-GB', { month: 'long', timeZone: 'Europe/Copenhagen' });
    const year = now.getUTCFullYear();
    const reminderKey = `invoice_reminder_${year}_${now.getUTCMonth()}`;

    // Only send once per month
    const already = db().prepare(`SELECT value FROM app_settings WHERE key=?`).get(reminderKey);
    if (already) return;

    const guides = db().prepare(`SELECT id, name, email FROM team_members WHERE active=1 AND role NOT IN ('admin','mechanic') AND email IS NOT NULL`).all();

    for (const guide of guides) {
      if (!isNotifEnabled(guide.id, 'invoice_reminder')) continue;
      const subject = `Invoice reminder — send by the 23rd`;
      const htmlContent = `
        <p>Hi ${guide.name},</p>
        <p>Just a reminder to send your invoice for <strong>${monthName} ${year}</strong> by the <strong>23rd</strong>.</p>
        <p>You can upload it directly in the app under <strong>Profile → Upload invoice</strong>. Your worked hours for the period are shown there too.</p>
        ${EMAIL_FOOTER}
      `;
      await sendEmail({ to: guide.email, toName: guide.name, subject, htmlContent, category: 'invoice_reminder' })
        .catch(e => console.error(`Invoice reminder failed for ${guide.name}:`, e.message));
      console.log(`Invoice reminder sent to ${guide.name}`);
    }

    // Mark as sent (value defaults to the timestamp; presence of the row is
    // what the check above reads). Previously passed an extra bind param that
    // threw here, so it never got marked -> re-sent every hour on the 20th.
    db().prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, datetime('now'), datetime('now'))`).run(reminderKey);
  } catch (e) {
    console.error('Invoice reminder error:', e.message);
  }
}

function startReminders() {
  sendReminders();
  sendInvoiceReminders();
  setInterval(sendReminders, 60 * 60 * 1000);
  setInterval(sendInvoiceReminders, 60 * 60 * 1000);
}

module.exports = { startReminders };
