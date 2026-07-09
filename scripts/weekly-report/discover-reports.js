// scripts/weekly-report/discover-reports.js
//
// WATCHED FIRST RUN — discovery only. Does not download a final dataset;
// its job is to log into FareHarbor and report back, for each weekly-core
// report, exactly how that report exposes a CSV/Excel export (a link? a
// button? a background network call?). The output of this run tells us how
// to build the real, robust fetcher.
//
// Run it HEADED so you can watch:
//   HEADED=1 node scripts/weekly-report/discover-reports.js
// On a headless VPS with no display, run it on your laptop instead (same
// repo, same FAREHARBOR_EMAIL / FAREHARBOR_PASSWORD env vars), or via
// `xvfb-run -a node scripts/weekly-report/discover-reports.js`.
//
// Reuses the exact login flow from scrape-guide-schedule-v2.js.

// Playwright is this module's own dependency (scripts/weekly-report/
// node_modules), installed via `npm install` in this folder — so the module
// is self-contained and can be split into its own repo later.
const { chromium } = require('playwright');

const COMPANY_SLUG = 'becopenhagen';
const HEADED = !!process.env.HEADED;

const REPORTS = [
  ['Sales by item',        'https://fareharbor.com/becopenhagen/dashboard/reports/advanced/payments-and-refunds/?suggested=sales-by-item'],
  ['Bookings by item',     'https://fareharbor.com/becopenhagen/dashboard/reports/advanced/bookings/?suggested=bookings-by-item'],
  ['Item occupancy',       'https://fareharbor.com/becopenhagen/dashboard/reports/item-occupancy/'],
  ['Affiliates and agents','https://fareharbor.com/becopenhagen/dashboard/reports/advanced/bookings/?suggested=agents'],
  ['Booking source',       'https://fareharbor.com/becopenhagen/dashboard/reports/advanced/bookings/?suggested=source'],
  ['Pace Report',          'https://fareharbor.com/becopenhagen/dashboard/reports/pace-report/'],
  ['Cancelled bookings',   'https://fareharbor.com/becopenhagen/dashboard/reports/advanced/bookings/?suggested=cancelled'],
  ['Crew',                 'https://fareharbor.com/becopenhagen/dashboard/reports/crew-summary/'],
  ['Revenue by type',      'https://fareharbor.com/becopenhagen/dashboard/reports/advanced/payments-and-refunds/?suggested=revenue-by-type'],
  ['Sales-Payout Reconciliation','https://fareharbor.com/becopenhagen/dashboard/reports/advanced/payments-and-refunds/?suggested=sales-payout-reconciliation'],
  ['Underpaid',            'https://fareharbor.com/becopenhagen/dashboard/reports/advanced/bookings/?suggested=future-underpaid'],
];

async function login(browser) {
  const ctx = await browser.newContext({ acceptDownloads: true });
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
  if (/login/i.test(page.url())) {
    throw new Error('Still on login page after submit — check credentials or a 2FA prompt appeared. URL: ' + page.url());
  }
  console.log('Logged in OK. Landed on:', page.url());
  return { ctx, page };
}

async function inspectReport(page, name, url) {
  console.log('\n=== ' + name + ' ===');
  console.log('URL:', url);

  // Watch for any CSV-ish network responses while the report loads.
  const csvResponses = [];
  const onResp = async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const cd = (resp.headers()['content-disposition'] || '').toLowerCase();
      if (ct.includes('csv') || ct.includes('excel') || ct.includes('spreadsheet') || cd.includes('attachment')) {
        csvResponses.push(resp.url() + '  [' + ct + ']');
      }
    } catch (_) {}
  };
  page.on('response', onResp);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(4000);
  } catch (e) {
    console.log('  ! navigation issue:', e.message.slice(0, 80));
  }

  console.log('  page title:', (await page.title()).slice(0, 80));

  // Find any export/download affordances by text.
  const candidates = await page.evaluate(() => {
    const out = [];
    const wanted = /download|export|csv|excel|spreadsheet|\.xls/i;
    document.querySelectorAll('a,button,[role="button"]').forEach(el => {
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
      const href = el.getAttribute('href') || '';
      const aria = el.getAttribute('aria-label') || '';
      if (wanted.test(txt) || wanted.test(href) || wanted.test(aria)) {
        out.push({ tag: el.tagName.toLowerCase(), txt: txt.slice(0, 40), href: href.slice(0, 120), aria: aria.slice(0, 40) });
      }
    });
    return out.slice(0, 12);
  });

  if (candidates.length) {
    console.log('  export affordances found:');
    candidates.forEach(c => console.log('   -', c.tag, JSON.stringify(c.txt), c.aria ? ('aria=' + c.aria) : '', c.href ? ('href=' + c.href) : ''));
  } else {
    console.log('  no obvious export link/button found by text.');
  }

  // Try the quick-win: does appending format=csv just return a CSV?
  const sep = url.includes('?') ? '&' : '?';
  const tryUrl = url + sep + 'format=csv';
  try {
    const resp = await page.request.get(tryUrl, { timeout: 20000 });
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const body = await resp.text();
    const looksCsv = ct.includes('csv') || (body.includes(',') && body.split('\n')[0].split(',').length > 2 && !body.trim().startsWith('<'));
    console.log('  format=csv probe:', resp.status(), ct || '(no ct)', looksCsv ? 'LOOKS LIKE CSV ✓' : 'not csv');
    if (looksCsv) console.log('    first line:', body.split('\n')[0].slice(0, 100));
  } catch (e) {
    console.log('  format=csv probe failed:', e.message.slice(0, 60));
  }

  if (csvResponses.length) {
    console.log('  CSV-ish network responses seen while loading:');
    csvResponses.forEach(r => console.log('   -', r.slice(0, 140)));
  }

  page.off('response', onResp);
}

(async () => {
  if (!process.env.FAREHARBOR_EMAIL || !process.env.FAREHARBOR_PASSWORD) {
    throw new Error('FAREHARBOR_EMAIL and FAREHARBOR_PASSWORD env vars required');
  }
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 300 : 0 });
  try {
    const { page } = await login(browser);
    for (const [name, url] of REPORTS) {
      await inspectReport(page, name, url);
    }
    console.log('\n=== discovery complete ===');
    console.log('Paste this whole output back so the real fetcher can be built to match.');
    if (HEADED) { console.log('\n(Leaving browser open 20s so you can look around.)'); await page.waitForTimeout(20000); }
  } finally {
    await browser.close();
  }
})();
