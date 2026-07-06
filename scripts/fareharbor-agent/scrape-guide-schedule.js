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
const { getDb, initSchema } = require('../../src/db/schema');

const COMPANY_SLUG = 'becopenhagen';
const DAYS_AHEAD = 60;

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

  initSchema();
  const db = getDb();

  const browser = await chromium.launch({ headless: true });

  try {
    // Step 1: Login to dashboard once, reuse the page for all detail fetches
    const { page: dashPage } = await loginToDashboard(browser);

    let totalUpserted = 0;

    for (const item of TOUR_ITEMS) {
      console.log(`\nScraping ${item.feed_id} (item ${item.id})...`);

      // Step 2: Scrape public widget for availability IDs
      const availabilities = await scrapeAvailabilityIds(browser, item.id, DAYS_AHEAD);
      console.log(`  Found ${availabilities.length} availability IDs from widget`);

      // Step 3: For each, fetch dashboard details
      for (const { availabilityId } of availabilities) {
        console.log(`  Fetching details for availability ${availabilityId}...`);
        const details = await fetchAvailabilityDetails(dashPage, item.id, availabilityId);
        if (!details) continue;

        const { guide, bookingCount, startAt, endAt, startDate, startTime, endTime } = details;
        if (!startDate) { console.log(`  Skipping ${availabilityId} — could not parse date`); continue; }

        // Skip slots in the past
        if (startDate < new Date().toISOString().substring(0, 10)) continue;

        const durationMinutes = Math.round(item.duration_h * 60) + 30; // + 15min buffer each side

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

        console.log(`  ✓ ${startDate} ${startTime} ${item.feed_id} guide=${guide || 'unassigned'} bookings=${bookingCount}`);
        totalUpserted++;

        // Small delay to avoid hammering the dashboard
        await dashPage.waitForTimeout(500);
      }
    }

    console.log(`\nDone. ${totalUpserted} availabilities upserted.`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
