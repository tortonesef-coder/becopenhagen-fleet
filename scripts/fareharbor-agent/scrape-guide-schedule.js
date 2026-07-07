#!/usr/bin/env node
/**
 * FareHarbor Guide Schedule Scraper
 *
 * For each tour item:
 *   1. Scrapes the public booking widget calendar to discover all upcoming
 *      availability IDs (including slots with zero bookings).
 *   2. Logs into the FareHarbor dashboard and fetches each availability's
 *      detail overlay to extract the assigned guide (from the Crew note field),
 *      booking count, and start/end time.
 *   3. Upserts the result into tour_availabilities so guides can see their
 *      upcoming slots even before any booking arrives.
 *
 *   Run via cron every few hours (example):
 *   0 slash-3 slash-star slash-star slash-star  node scrape-guide-schedule.js
 */

const { chromium } = require('playwright');
const path = require('path');
const { getDb, isNotifEnabled } = require('../../src/db/schema');
const { sendEmail, EMAIL_FOOTER } = require('../../src/email');

const COMPANY_SLUG = 'becopenhagen';
const DAYS_AHEAD = 30;

// Random delay between requests to avoid rate limiting
const delay = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

const TOUR_ITEMS = [
  { id: '707493', feed_id: 'L3',  label: 'Liveable City Tour (3h)',       duration_h: 3   },
  { id: '709131', feed_id: 'A3',  label: 'Architecture Tour (3h)',         duration_h: 3   },
  { id: '729348', feed_id: 'F3',  label: 'Food Tour (3h)',                 duration_h: 3.5 },
  { id: '741878', feed_id: 'H3',  label: 'History Tour (3h)',              duration_h: 3   },
  { id: '713560', feed_id: 'L3P', label: 'Private Liveable City (3h)',     duration_h: 3   },
  { id: '713563', feed_id: 'A3P', label: 'Private Architecture (3h)',      duration_h: 3   },
  { id: '730640', feed_id: 'F3P', label: 'Private Food Tour (3h)',         duration_h: 3.5 },
  { id: '712177', feed_id: 'L2P', label: 'Private Liveable City (2h)',     duration_h: 2   },
  { id: '650858', feed_id: 'CUSTOM', label: 'Custom Tour',                 duration_h: 3   },
];

// ── Login to FareHarbor dashboard ─────────────────────────────────────────
async function loginToDashboard(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

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

  if (!page.url().includes('dashboard') && !page.url().includes('fareharbor.com/becopenhagen')) {
    throw new Error('Dashboard login failed. URL: ' + page.url());
  }

  console.log('Logged into dashboard:', page.url());
  return { context, page };
}

// ── Scrape public widget calendar for availability IDs ────────────────────
async function scrapeAvailabilityIds(browser, itemId, daysAhead) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = []; // [{ date, availabilityId, startTime }]

  try {
    const now = new Date();
    const months = new Set();
    for (let d = 0; d <= daysAhead; d++) {
      const dt = new Date(now);
      dt.setDate(dt.getDate() + d);
      months.add(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2,'0')}`);
    }

    for (const ym of months) {
      const [year, month] = ym.split('-');
      const url = `https://fareharbor.com/embeds/book/${COMPANY_SLUG}/items/${itemId}/calendar/${year}/${month}/`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      // Find all clickable day buttons that have an availability
      const dayButtons = await page.locator('button[data-href], a[data-href], button, a').all();

      for (const btn of dayButtons) {
        const href = await btn.getAttribute('data-href') || await btn.getAttribute('href') || '';
        // Availability URLs look like: /embeds/book/becopenhagen/items/709131/availability/2118223227/
        const match = href.match(/\/availability\/(\d+)\//);
        if (!match) continue;

        const availId = match[1];
        // Extract date from nearby context or from the URL
        // Try to get date from the parent cell
        const cell = btn.locator('xpath=ancestor::td[1] | ancestor::div[contains(@class,"day")][1]').first();
        let dateStr = null;
        if (await cell.count() > 0) {
          const dataDate = await cell.getAttribute('data-date') || await cell.getAttribute('data-day') || '';
          if (dataDate) dateStr = dataDate;
        }

        if (!results.find(r => r.availabilityId === availId)) {
          results.push({ availabilityId: availId, date: dateStr });
        }
      }

      // Alternative: look for any link with /availability/ in href
      const links = await page.locator('a').all();
      for (const link of links) {
        const href = await link.getAttribute('href') || '';
        const match = href.match(/\/availability\/(\d+)\//);
        if (match && !results.find(r => r.availabilityId === match[1])) {
          results.push({ availabilityId: match[1], date: null });
        }
      }
    }
  } catch (e) {
    console.error(`  Error scraping widget for item ${itemId}:`, e.message);
  } finally {
    await context.close();
  }

  return results;
}

// ── Fetch guide + details from dashboard overlay ──────────────────────────
async function fetchAvailabilityDetails(page, itemId, availabilityId) {
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const url = `https://fareharbor.com/${COMPANY_SLUG}/dashboard/bookings/calendar/${year}/${month}/?overlay=/items/${itemId}/availabilities/${availabilityId}/`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const text = await page.locator('body').innerText();

    // Extract guide name from Crew table "Crew 1 Guide <name>"
    const crewMatch = text.match(/Crew\s+\d+\s+Guide\s+([^\n]+)/i);
    const guide = crewMatch ? crewMatch[1].trim() : null;

    // Extract booking count: "7 booked"
    const bookedMatch = text.match(/(\d+)\s+booked/i);
    const bookingCount = bookedMatch ? parseInt(bookedMatch[1]) : 0;

    // Extract start/end time: "Thursday, 9 July 2026 @ 10:00 – 13:00"
    const timeMatch = text.match(/(\w+),\s+(\d+)\s+(\w+)\s+(\d{4})\s+@\s+(\d+:\d+)\s*[–-]\s*(\d+:\d+)/);
    let startAt = null, endAt = null, startDate = null, startTime = null, endTime = null;
    if (timeMatch) {
      const [, , day, monthName, yearStr, start, end] = timeMatch;
      const months = {January:1,February:2,March:3,April:4,May:5,June:6,July:7,August:8,September:9,October:10,November:11,December:12};
      const m = months[monthName];
      if (m) {
        startDate = `${yearStr}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        startTime = start;
        endTime = end;
        startAt = `${startDate}T${start}:00+02:00`;
        endAt = `${startDate}T${end}:00+02:00`;
      }
    }

    return { guide, bookingCount, startAt, endAt, startDate, startTime, endTime };
  } catch (e) {
    console.error(`  Error fetching availability ${availabilityId}:`, e.message);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.FAREHARBOR_EMAIL || !process.env.FAREHARBOR_PASSWORD) {
    throw new Error('FAREHARBOR_EMAIL and FAREHARBOR_PASSWORD env vars required');
  }

  const db = getDb();
  const browser = await chromium.launch({ headless: true });

  // Login once, re-login if session dies
  let dashContext, dashPage;
  async function ensureLoggedIn() {
    try {
      if (dashPage) await dashPage.locator('body').innerText().catch(() => { throw new Error('dead'); });
    } catch {
      console.log('  Re-logging into dashboard...');
      dashContext = null; dashPage = null;
    }
    if (!dashPage) {
      const result = await loginToDashboard(browser);
      dashContext = result.context;
      dashPage = result.page;
    }
  }

  try {
    await ensureLoggedIn();
    let totalUpserted = 0;

    // Step 1: Collect ALL availability IDs from the public widget for all items first
    // This is fast (no login needed) and gives us the full picture
    console.log('\nCollecting availability IDs from public widget...');
    const allAvailabilities = []; // { availabilityId, item, date }

    for (const item of TOUR_ITEMS) {
      const avails = await scrapeAvailabilityIds(browser, item.id, DAYS_AHEAD);
      avails.forEach(a => allAvailabilities.push({ ...a, item }));
      console.log(`  ${item.feed_id}: ${avails.length} IDs`);
    }

    // Step 2: Sort by date so we process nearest days first across all tour types
    // IDs without a date go at the end
    allAvailabilities.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    console.log(`\nTotal: ${allAvailabilities.length} availabilities to check (sorted by date)`);

    // Step 3: Hit dashboard for each, nearest dates first
    for (const { availabilityId, item } of allAvailabilities) {
      await ensureLoggedIn();
      console.log(`  Fetching ${item.feed_id} availability ${availabilityId}...`);
      const details = await fetchAvailabilityDetails(dashPage, item.id, availabilityId);
      if (!details) { dashPage = null; continue; }

      const { guide, bookingCount, startAt, endAt, startDate, startTime, endTime } = details;
      if (!startDate) { console.log(`  Skipping ${availabilityId} — could not parse date`); continue; }

      const endUtc = endAt ? new Date(endAt) : null;
      if (endUtc && endUtc < new Date()) continue;

        const durationMinutes = Math.round(item.duration_h * 60) + 30; // + 15min buffer each side

        // Check if this is a new assignment or a guide change
        const existing = db.prepare(`SELECT guide FROM tour_availabilities WHERE availability_id=?`).get(availabilityId);
        const isNewAssignment = guide && (!existing || !existing.guide);
        const isReassignment = guide && existing?.guide && existing.guide !== guide;

        // Upsert into tour_availabilities
        db.prepare(`
          INSERT INTO tour_availabilities
            (availability_id, feed_id, feed_label, feed_type, guide, start_at, end_at,
             start_date, start_time, end_time, booking_count, last_synced)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(availability_id) DO UPDATE SET
            guide=COALESCE(excluded.guide, guide),
            start_at=excluded.start_at, end_at=excluded.end_at,
            start_date=excluded.start_date, start_time=excluded.start_time, end_time=excluded.end_time,
            booking_count=excluded.booking_count, last_synced=excluded.last_synced
        `).run(availabilityId, item.feed_id, item.label, 'tour',
               guide, startAt, endAt, startDate, startTime, endTime, bookingCount);

        // Also upsert into guide_tour_hours if guide is assigned
        if (guide) {
          db.prepare(`
            INSERT INTO guide_tour_hours
              (availability_id, guide, feed_id, feed_label, start_at, end_at, start_date, duration_minutes, last_synced)
            VALUES (?,?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(availability_id) DO UPDATE SET
              guide=excluded.guide, start_at=excluded.start_at, end_at=excluded.end_at,
              start_date=excluded.start_date, duration_minutes=excluded.duration_minutes,
              last_synced=excluded.last_synced
          `).run(availabilityId, guide, item.feed_id, item.label, startAt, endAt, startDate, durationMinutes);
        }

        // Email guide if newly assigned or reassigned
        if ((isNewAssignment || isReassignment) && guide) {
          const member = db.prepare(`SELECT id, name, email FROM team_members WHERE active=1 AND (name=? OR name LIKE ?)`)
            .get(guide, `%${guide}%`);
          if (member?.email && isNotifEnabled(member.id, 'tour_assigned')) {
            const dateLabel = new Date(startDate).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
            const subject = isReassignment
              ? `Tour update — ${item.feed_id} on ${dateLabel}`
              : `New tour assigned — ${item.feed_id} on ${dateLabel}`;
            const htmlContent = `
              <p>Hi ${member.name},</p>
              <p>${isReassignment ? 'Your assignment has been updated:' : 'You have been assigned to a new tour:'}</p>
              <table style="border-collapse:collapse;margin:0.5rem 0">
                <tr><td style="padding:3px 12px 3px 0;color:#888">Tour</td><td>${item.label}</td></tr>
                <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLabel}</td></tr>
                <tr><td style="padding:3px 12px 3px 0;color:#888">Time</td><td>${startTime}${endTime ? ' – ' + endTime : ''}</td></tr>
                <tr><td style="padding:3px 12px 3px 0;color:#888">Bookings</td><td>${bookingCount} so far</td></tr>
                ${isReassignment ? `<tr><td style="padding:3px 12px 3px 0;color:#888">Previously</td><td>${existing.guide}</td></tr>` : ''}
              </table>
              <p>You can see all your upcoming tours in the app.</p>
              ${EMAIL_FOOTER}
            `;
            await sendEmail({ to: member.email, toName: member.name, subject, htmlContent })
              .catch(e => console.error(`  Email failed for ${member.name}:`, e.message));
            console.log(`  📧 Email sent to ${member.name} (${isReassignment ? 'reassignment' : 'new assignment'})`);
          }
        }

        console.log(`  ✓ ${startDate} ${startTime} ${item.feed_id} guide=${guide || 'unassigned'} bookings=${bookingCount}`);
        totalUpserted++;

        // Random delay 2-5s to avoid rate limiting
        await delay(2000, 5000);
      }

    console.log(`\nDone. ${totalUpserted} availabilities upserted.`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
