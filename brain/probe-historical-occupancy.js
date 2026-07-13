// scripts/brain/probe-historical-occupancy.js
//
// THE QUESTION: can we backfill occupancy for dates before the fleet app
// existed? That depends entirely on whether FareHarbor's calendar API still
// returns departures that sold ZERO bookings for past months. If it only
// returns the ones that sold, historical occupancy is unrecoverable and we
// should stop rather than build a backfill that produces garbage.
//
// This probe is READ-ONLY. It writes nothing, to any database.
//
// It fetches a recent month (control — we know it has empties) and several
// historical months, and reports for each: how many departures came back,
// how many had zero bookings, and how many had bookings. If historical months
// come back with ~0 empty departures while the recent month has plenty, the
// data has been purged and backfill is off.
//
// Run:
//   cd /var/www/becopenhagen-fleet
//   export $(grep -E '^FAREHARBOR_(EMAIL|PASSWORD)=' /etc/environment | xargs)
//   node scripts/brain/probe-historical-occupancy.js

const { chromium } = require('../weekly-report/node_modules/playwright');

const COMPANY_SLUG = 'becopenhagen';

// Months to probe: a recent control, then progressively older.
const PROBE_MONTHS = [
  [2026, 6],  // control: recent, fleet app era — should show empties
  [2025, 7],  // peak season last year
  [2025, 3],  // shoulder season last year
  [2024, 7],  // two summers ago
  [2023, 7],  // three summers ago
];

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
  if (/login/i.test(page.url())) throw new Error('Login failed (2FA?): ' + page.url());
  console.log('Logged in OK.\n');
  return page;
}

// Discover item IDs the same way the existing scraper does.
async function getItemIds(page) {
  const url = `https://fareharbor.com/api/v1/companies/${COMPANY_SLUG}/items/`;
  const resp = await page.request.get(url, { timeout: 30000 });
  if (!resp.ok()) throw new Error('items API returned ' + resp.status());
  const json = await resp.json();
  const items = json.items || json || [];
  const ids = items.map((i) => i.pk || i.id).filter(Boolean);
  console.log(`Found ${ids.length} items.\n`);
  return ids.join(',');
}

async function probeMonth(page, itemIds, year, month) {
  const mm = String(month).padStart(2, '0');
  const url =
    `https://fareharbor.com/api/v1/companies/${COMPANY_SLUG}/items/${itemIds}` +
    `/calendar/${year}/${mm}/?allow_grouped=yes&include_resource_use_summaries=yes&path=2`;

  let json;
  try {
    const resp = await page.request.get(url, { timeout: 60000 });
    if (!resp.ok()) {
      console.log(`${year}-${mm}:  HTTP ${resp.status()} — no data returned`);
      return;
    }
    json = await resp.json();
  } catch (e) {
    console.log(`${year}-${mm}:  request failed — ${e.message.slice(0, 50)}`);
    return;
  }

  // Walk the calendar structure the same way the real scraper does.
  const weeks = json?.calendar?.weeks || [];
  let total = 0, empty = 0, sold = 0, totalBookings = 0;

  for (const week of weeks) {
    for (const day of week.days || []) {
      for (const av of day.availabilities || []) {
        total++;
        const n =
          av.bookings_count ??
          av.customer_count ??
          (Array.isArray(av.bookings) ? av.bookings.length : 0);
        totalBookings += n || 0;
        if (!n) empty++; else sold++;
      }
    }
  }

  const pctEmpty = total ? Math.round((empty / total) * 100) : 0;
  const verdict =
    total === 0 ? 'NO DATA — nothing returned'
    : empty === 0 ? 'ONLY SOLD departures — empties appear purged'
    : `has ${empty} EMPTY departures — BACKFILLABLE`;

  console.log(
    `${year}-${mm}:  ${String(total).padStart(4)} departures  |  ` +
    `${String(sold).padStart(4)} sold  |  ${String(empty).padStart(4)} empty (${pctEmpty}%)  |  ` +
    `${totalBookings} bookings  ->  ${verdict}`
  );
}

(async () => {
  if (!process.env.FAREHARBOR_EMAIL || !process.env.FAREHARBOR_PASSWORD) {
    throw new Error('FAREHARBOR_EMAIL and FAREHARBOR_PASSWORD required');
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await login(browser);
    const itemIds = await getItemIds(page);

    console.log('Probing whether unsold historical departures still exist:\n');
    for (const [y, m] of PROBE_MONTHS) {
      await probeMonth(page, itemIds, y, m);
    }

    console.log(`
INTERPRETING THIS:
- If the historical months show EMPTY departures like the 2026 control does,
  the data is intact and a full occupancy backfill will work.
- If historical months return only SOLD departures (empty = 0) while the
  control has many, FareHarbor has purged unsold past availabilities and
  historical occupancy is NOT recoverable. Occupancy then starts from when
  the fleet app began, and that's simply a limit we live with.
- If they return NO DATA at all, the calendar API may not serve months that
  far back.

Paste this output back.`);
  } finally {
    await browser.close();
  }
})();
