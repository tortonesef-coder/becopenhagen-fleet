#!/usr/bin/env node
// DIAGNOSTIC ONLY — reads nothing into the DB, writes nothing.
//
// Goal: confirm that FareHarbor gives us the REAL creation date per booking,
// and learn the exact API URL, before we write a backfill. Many tours currently
// show a booking date of ~7 July because those bookings predate our webhook, so
// we never captured their true created_at and fall back to `first_seen_at` (the
// moment we first synced them). This checks whether FareHarbor's per-availability
// bookings endpoint carries the true created_at so we can backfill it.
//
// Usage: node scripts/fareharbor-agent/diag-real-booking-dates.js

const { chromium } = require('playwright');
const { getDb } = require('../../src/db/schema');

const COMPANY_SLUG = 'becopenhagen';

// feed_id -> FareHarbor item id (tours only; rentals have no keep-bikes flag)
const ITEM_BY_FEED = {
  L2P: '712177', L3: '707493', L3P: '713560', A3: '709131', A3P: '713563',
  F3: '729348', F3P: '730640', H3: '741878', CUSTOM: '650858',
};

function pickAffected(db, limit = 3) {
  const rows = db.prepare(
    `SELECT availability_id, feed_id, start_date, bookings_json
       FROM tour_availabilities
      WHERE feed_type='tour' AND bookings_json IS NOT NULL AND bookings_json != '[]'
      ORDER BY start_date`
  ).all();
  const picks = [];
  for (const r of rows) {
    if (!ITEM_BY_FEED[r.feed_id]) continue;
    let bookings;
    try { bookings = JSON.parse(r.bookings_json); } catch { continue; }
    const missing = bookings.filter(b => b.ref && !b.created_at);
    if (missing.length === 0) continue;
    picks.push({
      availability_id: String(r.availability_id),
      item_id: ITEM_BY_FEED[r.feed_id],
      feed_id: r.feed_id,
      start_date: r.start_date,
      refs: bookings.map(b => b.ref),
      missingRefs: missing.map(b => b.ref),
    });
    if (picks.length >= limit) break;
  }
  return picks;
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

// Pull out an array of booking objects from whatever shape the response has.
function extractBookings(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.bookings)) return json.bookings;
  if (Array.isArray(json?.results)) return json.results;
  return [];
}

(async () => {
  const db = getDb();
  const picks = pickAffected(db, 3);
  if (picks.length === 0) { console.log('No affected tours found (all bookings already have created_at?).'); return; }

  console.log(`Affected tours to probe (${picks.length}):`);
  for (const p of picks) console.log(`  ${p.feed_id} ${p.start_date}  avail=${p.availability_id}  bookings=${p.refs.length}  missing_created_at=${p.missingRefs.length}`);

  const browser = await chromium.launch({ headless: true });
  const page = await login(browser);
  let learnedUrl = null;

  for (const p of picks) {
    console.log(`\n=== ${p.feed_id} ${p.start_date} (avail ${p.availability_id}) ===`);
    let captured = null, capturedUrl = null;
    const handler = async (resp) => {
      const u = resp.url();
      if (u.includes('/availabilities/') && u.includes('/bookings/')) {
        try { captured = await resp.text(); capturedUrl = u; } catch {}
      }
    };
    page.on('response', handler);
    const overlay = `https://fareharbor.com/${COMPANY_SLUG}/dashboard/bookings/?overlay=/items/${p.item_id}/availabilities/${p.availability_id}/`;
    await page.goto(overlay, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
    page.off('response', handler);

    if (!captured) { console.log('  Could not capture a bookings response for this availability.'); continue; }
    learnedUrl = capturedUrl;
    console.log('  API URL:', capturedUrl);
    let json; try { json = JSON.parse(captured); } catch { console.log('  (response was not JSON)'); continue; }
    const bookings = extractBookings(json);
    console.log(`  bookings in response: ${bookings.length}`);
    if (bookings.length > 0) {
      console.log('  keys on first booking:', Object.keys(bookings[0]).join(', '));
    }
    for (const b of bookings) {
      const ref = b.pk || b.ref || b.uuid || '(no ref field)';
      const created = b.created_at || b.created || b.booked_at || b.datetime_created || '(NO created_at field)';
      const name = b.contact?.name || b.customer_name || b.name || '';
      console.log(`    ref=${ref}  created_at=${created}  ${name}`);
    }
  }

  // Confirm we can hit the learned URL directly (fast path for a real backfill)
  if (learnedUrl) {
    console.log('\n=== direct API access test (for backfill) ===');
    try {
      const resp = await page.request.get(learnedUrl, { timeout: 30000 });
      console.log('  direct GET status:', resp.status(), resp.ok() ? '(usable directly)' : '(NOT directly usable)');
    } catch (e) { console.log('  direct GET failed:', e.message.substring(0, 80)); }
  }

  await browser.close();
  console.log('\nDone.');
})();
