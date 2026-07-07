#!/usr/bin/env node
/**
 * FareHarbor Guide Schedule Sync (v2 — JSON API interception)
 *
 * Logs into the FareHarbor dashboard once, loads the calendar month view
 * for the current and next month, and intercepts the internal JSON API
 * responses which contain EVERY availability with dates, times, booking
 * counts, and crew assignments (guide name lives in the crew note field,
 * or the user's real name for guides with their own FareHarbor account).
 *
 * Replaces the old per-availability page scraper: 2 page loads instead
 * of ~260, ~30 seconds instead of ~40 minutes.
 *
 * Cron (single entry, every hour is fine at this speed):
 *   0 * * * * cd /var/www/becopenhagen-fleet/scripts/fareharbor-agent && node scrape-guide-schedule.js >> /var/log/bc-schedule-scraper.log 2>&1
 */

const { chromium } = require('playwright');
const { getDb, isNotifEnabled } = require('../../src/db/schema');
const { sendEmail, EMAIL_FOOTER } = require('../../src/email');

const COMPANY_SLUG = 'becopenhagen';

// Item PK → feed config. Only these tour items are synced.
const TOUR_ITEMS = {
  707493: { feed_id: 'L3',  label: 'Liveable City Tour (3h)' },
  709131: { feed_id: 'A3',  label: 'Architecture Tour (3h)' },
  729348: { feed_id: 'F3',  label: 'Food Tour (3h)' },
  741878: { feed_id: 'H3',  label: 'History Tour (3h)' },
  713560: { feed_id: 'L3P', label: 'Private Liveable City (3h)' },
  713563: { feed_id: 'A3P', label: 'Private Architecture (3h)' },
  730640: { feed_id: 'F3P', label: 'Private Food Tour (3h)' },
  712177: { feed_id: 'L2P', label: 'Private Liveable City (2h)' },
  650858: { feed_id: 'CUSTOM', label: 'Custom Tour' },
};

// Map crew user names to guide names. 'Crew 1' means the real guide name
// is in the crew note. Guides with their own accounts map directly.
function resolveGuideName(crewMember) {
  let userName = crewMember?.user?.name || '';
  // Abbreviated user objects only have a uri like /users/crew1/ — extract username
  if (!userName && crewMember?.user?.uri) {
    const m = crewMember.user.uri.match(/\/users\/([^/]+)\//);
    if (m) userName = m[1];
  }
  const note = (crewMember?.note || '').trim();
  if (/^crew\s*\d*$/i.test(userName)) {
    return note || null; // generic crew account — real name is the note
  }
  return userName || note || null;
}

async function login(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('https://fareharbor.com/login/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (await page.locator('text="Shortname"').count() > 0) {
    await page.locator('text="Shortname"').locator('xpath=following::input[1]').first().fill(COMPANY_SLUG);
    await page.locator('button:has-text("Next")').first().click();
    await page.waitForTimeout(2000);
  }

  await page.locator('input[type="email"],input[name="email"]').first().fill(process.env.FAREHARBOR_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.FAREHARBOR_PASSWORD);
  await page.locator('button:has-text("Log in"),button[type="submit"]').first().click();
  await page.waitForTimeout(5000);

  return page;
}

// All item IDs from the discovered API URL (tours + rentals; harmless to request all)
const ALL_ITEM_IDS = '712177,707493,713560,709131,713563,729348,730640,650858,190975,190977,190978,190980,651114,651124,190983,651812,652669,652693,652695,652697,652699,652703,190987,702701,706960,583653,190971,201570,201571';

// Fetch one calendar month by calling the internal API directly (authenticated
// via the logged-in page's cookies). Deterministic — no response interception.
async function fetchMonth(page, year, month) {
  const results = [];
  for (let week = 1; week <= 6; week++) {
    const url = `https://fareharbor.com/api/v1/companies/${COMPANY_SLUG}/items/${ALL_ITEM_IDS}/calendar/${year}/${String(month).padStart(2, '0')}/?allow_grouped=yes&include_resource_use_summaries=yes&path=2&week_number=${week}`;
    try {
      const resp = await page.request.get(url, { timeout: 30000 });
      if (!resp.ok()) { console.log(`  week ${week}: HTTP ${resp.status()}`); continue; }
      const json = await resp.json();
      results.push(json);
    } catch (e) {
      console.log(`  week ${week}: ${e.message.substring(0, 60)}`);
    }
  }
  if (results.length === 0) throw new Error(`No calendar data for ${year}-${month}`);
  console.log(`  (${results.length} week responses fetched)`);
  return results;
}

function extractAvailabilities(calendarJson) {
  const out = [];
  const weeks = calendarJson?.calendar?.weeks || [];
  for (const week of weeks) {
    for (const day of week.days || []) {
      for (const av of day.availabilities || []) {
        // FareHarbor abbreviates repeated objects: item may be {cls, uri} only.
        // Parse the item pk from the availability URI: /items/709131/availabilities/...
        let itemPk = av.item?.pk;
        if (!itemPk) {
          const m = (av.uri || av.item?.uri || '').match(/\/items\/(\d+)\//);
          itemPk = m ? parseInt(m[1], 10) : null;
        }
        if (!TOUR_ITEMS[itemPk]) continue; // skip rentals, gift certs, etc.

        // Extract guide from crew members (first Guide-role crew member)
        let guide = null;
        for (const group of av.grouped_crew_members || []) {
          const roleName = group.role?.short_name || group.role?.unicode || '';
          for (const cm of group.crew_members || []) {
            const name = resolveGuideName(cm);
            if (name) { guide = name; break; }
          }
          if (guide) break;
        }

        out.push({
          availability_id: String(av.pk),
          item: TOUR_ITEMS[itemPk],
          start_at: av.utc_start_at || av.start_at,
          end_at: av.utc_end_at || av.end_at,
          start_date: day.at,
          booking_count: av.booking_count ?? 0,
          customer_count: av.customer_count ?? 0,
          guide,
        });
      }
    }
  }
  return out;
}

function hhmm(iso) {
  // Convert ISO datetime to local Copenhagen HH:MM
  try {
    return new Date(iso).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });
  } catch (e) { return null; }
}

async function main() {
  if (!process.env.FAREHARBOR_EMAIL || !process.env.FAREHARBOR_PASSWORD) {
    throw new Error('FAREHARBOR_EMAIL and FAREHARBOR_PASSWORD env vars required');
  }

  const db = getDb();
  const browser = await chromium.launch({ headless: true });

  try {
    console.log(new Date().toISOString(), '— logging in...');
    const page = await login(browser);

    // Current month + next month covers 30+ days ahead
    const now = new Date();
    const months = [
      [now.getFullYear(), now.getMonth() + 1],
      [now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear(), (now.getMonth() + 1) % 12 + 1],
    ];

    let all = [];
    for (const [y, m] of months) {
      console.log(`Fetching calendar ${y}-${String(m).padStart(2, '0')}...`);
      const jsonResponses = await fetchMonth(page, y, m);
      let monthCount = 0;
      for (const json of jsonResponses) {
        const avs = extractAvailabilities(json);
        monthCount += avs.length;
        all = all.concat(avs);
      }
      console.log(`  ${monthCount} tour availabilities found (before dedup)`);
    }

    // Dedupe (overlapping weeks between months)
    const seen = new Set();
    all = all.filter(a => { if (seen.has(a.availability_id)) return false; seen.add(a.availability_id); return true; });

    const todayStr = new Date().toISOString().substring(0, 10);
    let upserted = 0;

    for (const av of all) {
      if (av.start_date < todayStr) continue; // skip past

      const startTime = hhmm(av.start_at);
      const endTime = hhmm(av.end_at);
      const durationMinutes = av.start_at && av.end_at
        ? Math.round((new Date(av.end_at) - new Date(av.start_at)) / 60000) + 30
        : 210;

      // Previous state for notification triggers
      const prev = db.prepare('SELECT guide FROM tour_availabilities WHERE availability_id=?').get(av.availability_id);
      const isNewAssignment = av.guide && (!prev || !prev.guide);
      const isReassignment = av.guide && prev?.guide && prev.guide !== av.guide;

      db.prepare(`
        INSERT INTO tour_availabilities
          (availability_id, feed_id, feed_label, feed_type, guide, start_at, end_at,
           start_date, start_time, end_time, booking_count, last_synced)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(availability_id) DO UPDATE SET
          guide=excluded.guide,
          start_at=excluded.start_at, end_at=excluded.end_at,
          start_date=excluded.start_date, start_time=excluded.start_time, end_time=excluded.end_time,
          booking_count=excluded.booking_count, last_synced=excluded.last_synced
      `).run(av.availability_id, av.item.feed_id, av.item.label, 'tour',
             av.guide, av.start_at, av.end_at, av.start_date, startTime, endTime, av.booking_count);

      if (av.guide) {
        db.prepare(`
          INSERT INTO guide_tour_hours
            (availability_id, guide, feed_id, feed_label, start_at, end_at, start_date, duration_minutes, last_synced)
          VALUES (?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(availability_id) DO UPDATE SET
            guide=excluded.guide, start_at=excluded.start_at, end_at=excluded.end_at,
            start_date=excluded.start_date, duration_minutes=excluded.duration_minutes,
            last_synced=excluded.last_synced
        `).run(av.availability_id, av.guide, av.item.feed_id, av.item.label, av.start_at, av.end_at, av.start_date, durationMinutes);
      }

      // Assignment email
      if ((isNewAssignment || isReassignment)) {
        const member = db.prepare(`SELECT id, name, email FROM team_members WHERE active=1 AND (name=? OR name LIKE ?)`)
          .get(av.guide, `%${av.guide}%`);
        if (member?.email && isNotifEnabled(member.id, 'tour_assigned')) {
          const dateLabel = new Date(av.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
          const subject = isReassignment
            ? `Tour update — ${av.item.feed_id} on ${dateLabel}`
            : `New tour assigned — ${av.item.feed_id} on ${dateLabel}`;
          const htmlContent = `
            <p>Hi ${member.name},</p>
            <p>${isReassignment ? 'Your assignment has been updated:' : 'You have been assigned to a new tour:'}</p>
            <table style="border-collapse:collapse;margin:0.5rem 0">
              <tr><td style="padding:3px 12px 3px 0;color:#888">Tour</td><td>${av.item.label}</td></tr>
              <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLabel}</td></tr>
              <tr><td style="padding:3px 12px 3px 0;color:#888">Time</td><td>${startTime}${endTime ? ' – ' + endTime : ''}</td></tr>
              <tr><td style="padding:3px 12px 3px 0;color:#888">Bookings</td><td>${av.booking_count} so far</td></tr>
              ${isReassignment ? `<tr><td style="padding:3px 12px 3px 0;color:#888">Previously</td><td>${prev.guide}</td></tr>` : ''}
            </table>
            <p>You can see all your upcoming tours in the app.</p>
            ${EMAIL_FOOTER}`;
          await sendEmail({ to: member.email, toName: member.name, subject, htmlContent })
            .catch(e => console.error(`Email failed for ${member.name}:`, e.message));
          console.log(`📧 ${isReassignment ? 'Reassignment' : 'Assignment'} email → ${member.name} (${av.item.feed_id} ${av.start_date})`);
        }
      }

      console.log(`✓ ${av.start_date} ${startTime} ${av.item.feed_id} guide=${av.guide || 'unassigned'} bookings=${av.booking_count}`);
      upserted++;
    }

    console.log(`\nDone. ${upserted} availabilities synced in one pass.`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
