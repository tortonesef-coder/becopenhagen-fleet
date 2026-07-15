// Scraper heartbeat watchdog.
//
// The FareHarbor scraper writes app_settings.scraper_last_success on every CLEAN
// completion (a crash exits before stamping it). This watcher checks that stamp
// periodically and alerts Federico if it goes stale — so a silently-dead scraper
// is caught the same day, instead of surfacing as "a booked August tour never
// showed up" days later (which is exactly what happened on 2026-07-15).

const { getDb } = require('./db/schema');
const { createNotification } = require('./routes/admin-notifs');
const { sendEmail } = require('./email');

const CHECK_EVERY_MS = 60 * 60 * 1000; // check hourly
const STALE_HOURS = 3;                 // scraper runs hourly, so 3h = several misses
const REALERT_EVERY_HOURS = 12;        // don't nag more than twice a day
const ALERT_TO = 'federico@becopenhagen.dk';

function getSetting(key) {
  try { return getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value || null; }
  catch { return null; }
}
function setSetting(key, value) {
  try {
    getDb().prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  } catch {}
}
const hoursSince = (iso) => iso ? (Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 3.6e6 : Infinity;

async function checkHeartbeat() {
  const last = getSetting('scraper_last_success');
  const staleFor = hoursSince(last);

  // Recovered since the last alert? Note it and clear the alert marker.
  if (staleFor < STALE_HOURS) {
    if (getSetting('scraper_alert_sent')) {
      setSetting('scraper_alert_sent', '');
      console.log('[heartbeat] scraper healthy again.');
    }
    return;
  }

  // Stale. Alert, but not more than once per REALERT window.
  const lastAlert = getSetting('scraper_alert_sent');
  if (lastAlert && hoursSince(lastAlert) < REALERT_EVERY_HOURS) return;

  const lastText = last ? `${last} UTC (${Math.floor(staleFor)}h ago)` : 'never';
  console.error(`[heartbeat] scraper STALE — last clean run: ${lastText}`);

  try {
    createNotification(
      'scraper_stale',
      'Tour sync may be down',
      `The FareHarbor scraper hasn't completed a clean run in ${Math.floor(staleFor)} hours (last success: ${lastText}). New bookings and guide assignments may not be reaching the app. Check the scraper on the server.`,
      'scraper_heartbeat'
    );
  } catch (e) { console.error('[heartbeat] could not create notification:', e.message); }

  try {
    await sendEmail({
      to: ALERT_TO,
      toName: 'Federico',
      subject: 'BeCopenhagen Fleet — tour sync may be down',
      htmlContent: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#222">
        <p>The FareHarbor tour scraper hasn't completed a clean run in <strong>${Math.floor(staleFor)} hours</strong>.</p>
        <p>Last successful run: <strong>${lastText}</strong>.</p>
        <p>While it's down, new bookings and guide assignments won't appear in the app, and bike counts won't update. Worth checking the scraper on the server.</p>
        <p style="color:#888;font-size:12px">You'll get at most one of these every ${REALERT_EVERY_HOURS}h until it recovers.</p>
      </div>`,
      category: 'scraper_heartbeat',
    });
  } catch (e) { console.error('[heartbeat] alert email failed:', e.message); }

  setSetting('scraper_alert_sent', new Date().toISOString().replace('T', ' ').substring(0, 19));
}

function startHeartbeat() {
  // First check a few minutes after boot (let an in-flight scrape finish first).
  setTimeout(checkHeartbeat, 5 * 60 * 1000);
  setInterval(checkHeartbeat, CHECK_EVERY_MS);
  console.log('[heartbeat] scraper watchdog started (stale threshold: ' + STALE_HOURS + 'h).');
}

module.exports = { startHeartbeat, checkHeartbeat };
