#!/usr/bin/env node
/**
 * Availability ID Pre-Scraper
 *
 * Assumes each rental item has been collapsed to a SINGLE daily time slot
 * (e.g. 9:30) on FareHarbor. Scrapes the next 90 days of availability IDs
 * for every rental item and caches them in the database, so the live
 * booking flow never needs to do a slow calendar lookup.
 *
 * Run manually once after the FareHarbor schedule change is live, then
 * scheduled via cron to run daily (keeps the rolling 90-day window topped up).
 *
 * Usage: node scrape-availability.js
 */

const { chromium } = require('playwright');
const path = require('path');
const { getDb } = require('../../src/db/schema');

const COMPANY_SLUG = 'becopenhagen';
const DAYS_AHEAD = 90;
const FIXED_TIME = '09:30'; // the single collapsed daily slot

const RENTAL_ITEMS = [
  { id: '190975', label: '1-Day Rentals' },
  { id: '190977', label: '2-Day Rentals' },
  { id: '190978', label: '3-Day Rentals' },
  { id: '190980', label: '4-Day Rentals' },
  { id: '651114', label: '5-Day Rentals' },
  { id: '651124', label: '6-Day Rentals' },
  { id: '190983', label: '7-Day Rentals' },
  { id: '651812', label: '8-Day Rentals' },
  { id: '652669', label: '9-Day Rentals' },
  { id: '652693', label: '10-Day Rentals' },
  { id: '652695', label: '11-Day Rentals' },
  { id: '652697', label: '12-Day Rentals' },
  { id: '652699', label: '13-Day Rentals' },
  { id: '652703', label: '14-Day Rentals' },
];

function ensureCacheTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fareharbor_availability_cache (
      item_id TEXT NOT NULL,
      date TEXT NOT NULL,
      availability_id TEXT NOT NULL,
      scraped_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (item_id, date)
    )
  `);
}

async function scrapeMonth(browser, itemId, year, month) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = {}; // date -> availability_id

  try {
    const url = `https://fareharbor.com/embeds/book/${COMPANY_SLUG}/items/${itemId}/calendar/${year}/${String(month).padStart(2,'0')}/`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

    // Find every day cell that has a clickable item button (i.e. has availability)
    const dayButtons = await page.locator('button, a').filter({ hasText: /Rentals?$/ }).all();

    for (const btn of dayButtons) {
      try {
        await btn.click();
        await page.waitForTimeout(800);

        let availId = null;
        const directMatch = page.url().match(/availability\/(\d+)/);
        if (directMatch) {
          availId = directMatch[1];
        } else {
          // Time slot list shown — click the fixed time we collapsed everything to
          const timeLocator = page.locator(`text="${FIXED_TIME}"`).first();
          if (await timeLocator.count() > 0) {
            await timeLocator.click();
            await page.waitForTimeout(800);
            const m = page.url().match(/availability\/(\d+)/);
            if (m) availId = m[1];
          }
        }

        if (availId) {
          // Extract the date from the page heading or URL
          const dateMatch = page.url().match(/date\/(\d{4}-\d{2}-\d{2})/);
          const heading = await page.locator('h1, h2, h3').filter({ hasText: /\d{4}/ }).first().innerText().catch(() => '');
          const date = dateMatch ? dateMatch[1] : null;
          if (date) results[date] = availId;
        }

        // Go back to the calendar to click the next day
        await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
      } catch (e) {
        console.error(`  Error on a day button for item ${itemId}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`Failed to scrape ${itemId} ${year}-${month}:`, e.message);
  } finally {
    await context.close();
  }

  return results;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.join('=')];
    })
  );

  const db = getDb();
  ensureCacheTable(db);

  const browser = await chromium.launch({ headless: true });
  const upsert = db.prepare(`
    INSERT INTO fareharbor_availability_cache (item_id, date, availability_id, scraped_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(item_id, date) DO UPDATE SET availability_id=excluded.availability_id, scraped_at=excluded.scraped_at
  `);

  // --item=190975 --month=2026-07  → test mode, one item one month only
  // (no flags) → full sweep, all items, next 90 days
  let itemsToScrape = RENTAL_ITEMS;
  let monthsToScrape = new Set();

  if (args.item && args.month) {
    console.log('TEST MODE: single item, single month');
    itemsToScrape = RENTAL_ITEMS.filter(i => i.id === args.item);
    if (itemsToScrape.length === 0) itemsToScrape = [{ id: args.item, label: 'custom' }];
    monthsToScrape.add(args.month.replace('-0', '-')); // normalize "2026-07" -> "2026-7"
  } else {
    const today = new Date();
    for (let d = 0; d <= DAYS_AHEAD; d++) {
      const date = new Date(today.getTime() + d * 86400000);
      monthsToScrape.add(`${date.getFullYear()}-${date.getMonth() + 1}`);
    }
  }

  let totalCached = 0;
  for (const item of itemsToScrape) {
    console.log(`\nScraping ${item.label} (${item.id})...`);
    for (const monthKey of monthsToScrape) {
      const [year, month] = monthKey.split('-').map(Number);
      const results = await scrapeMonth(browser, item.id, year, month);
      Object.entries(results).forEach(([date, availId]) => {
        upsert.run(item.id, date, availId);
        totalCached++;
      });
      console.log(`  ${year}-${String(month).padStart(2,'0')}: ${Object.keys(results).length} days found`);
    }
  }

  await browser.close();
  console.log(`\nDone. ${totalCached} availability IDs cached.`);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { ensureCacheTable };
