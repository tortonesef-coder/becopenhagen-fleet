#!/usr/bin/env node
// One-off fix: bookings made before our webhook went live never had their true
// creation date captured, so the app fell back to `first_seen_at` (the moment we
// first synced them — clustered around ~7 July). That made the "Can keep bikes
// after tour" flag wrong: customers who actually booked before 1 July looked
// like post-1-July bookings and lost the flag.
//
// FareHarbor's per-availability bookings API returns the real `created_at` (and
// `original_created_at`) per booking. This pulls it for every booking that is
// currently missing a created_at and backfills it into both
// tour_availabilities.bookings_json and the bookings ledger. Only fills gaps —
// never overwrites an existing created_at. Idempotent.
//
// DRY RUN BY DEFAULT: shows what it would change and writes nothing. Add
// --commit to actually write.
//
//   node scripts/fixes/backfill-real-created-at-from-fareharbor.js            (dry run)
//   node scripts/fixes/backfill-real-created-at-from-fareharbor.js --commit   (writes)

// playwright is installed for scripts in scripts/fareharbor-agent/, not for
// scripts/fixes/. Resolve it from that directory's perspective so this works
// regardless of exactly where the module is hoisted.
const path = require('path');
const { chromium } = require(require.resolve('playwright', { paths: [path.join(__dirname, '..', 'fareharbor-agent')] }));
const { getDb } = require('../../src/db/schema');

const COMMIT = process.argv.includes('--commit');
const COMPANY_SLUG = 'becopenhagen';
const CUTOFF = new Date('2026-07-01T00:00:00+02:00'); // keep-bikes threshold, for reporting

const ITEM_BY_FEED = {
  L2P: '712177', L3: '707493', L3P: '713560', A3: '709131', A3P: '713563',
  F3: '729348', F3P: '730640', H3: '741878', CUSTOM: '650858',
};

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

function extractBookings(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.bookings)) return json.bookings;
  if (Array.isArray(json?.results)) return json.results;
  return [];
}

(async () => {
  const db = getDb();

  // Collect availabilities (present in tour_availabilities) that have at least
  // one booking with no created_at, with the item id needed for the API URL.
  const taRows = db.prepare(
    `SELECT availability_id, feed_id, start_date, bookings_json
       FROM tour_availabilities
      WHERE feed_type='tour' AND bookings_json IS NOT NULL AND bookings_json != '[]'`
  ).all();

  const targets = [];
  for (const r of taRows) {
    const itemId = ITEM_BY_FEED[r.feed_id];
    if (!itemId) continue;
    let bookings;
    try { bookings = JSON.parse(r.bookings_json); } catch { continue; }
    const missing = bookings.filter(b => b.ref && !b.created_at).map(b => String(b.ref));
    if (missing.length) targets.push({ availId: String(r.availability_id), itemId, feed_id: r.feed_id, start_date: r.start_date, missing });
  }

  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${targets.length} availabilities have bookings missing created_at.`);
  if (targets.length === 0) { console.log('Nothing to do.'); return; }

  const browser = await chromium.launch({ headless: true });
  const page = await login(browser);

  const createdByRef = {};   // ref -> created_at
  const origByRef = {};      // ref -> original_created_at
  let apiFail = 0, apiOk = 0;

  for (const t of targets) {
    const url = `https://fareharbor.com/api/v1/companies/${COMPANY_SLUG}/items/${t.itemId}/availabilities/${t.availId}/bookings/`;
    try {
      const resp = await page.request.get(url, { timeout: 30000 });
      if (!resp.ok()) { console.log(`  API ${resp.status()} for avail ${t.availId}`); apiFail++; continue; }
      const bookings = extractBookings(await resp.json());
      for (const b of bookings) {
        const ref = String(b.pk ?? b.ref ?? '');
        if (!ref) continue;
        if (b.created_at) createdByRef[ref] = b.created_at;
        if (b.original_created_at) origByRef[ref] = b.original_created_at;
      }
      apiOk++;
    } catch (e) { console.log(`  API error avail ${t.availId}: ${e.message.substring(0, 60)}`); apiFail++; }
  }
  await browser.close();
  console.log(`Fetched ${apiOk} availabilities OK, ${apiFail} failed. Real dates found for ${Object.keys(createdByRef).length} booking refs.\n`);

  // Apply to tour_availabilities.bookings_json
  let taUpdated = 0, bookingsFixed = 0, unmatched = 0, beforeCutoff = 0;
  const sample = [];
  for (const t of targets) {
    const row = db.prepare('SELECT bookings_json FROM tour_availabilities WHERE availability_id=?').get(t.availId);
    if (!row) continue;
    let bookings; try { bookings = JSON.parse(row.bookings_json); } catch { continue; }
    let changed = false;
    for (const b of bookings) {
      if (!b.ref || b.created_at) continue;
      const real = createdByRef[String(b.ref)];
      if (!real) { unmatched++; continue; }
      const orig = origByRef[String(b.ref)];
      // Effective date for the keep-bikes condition: the EARLIER of created_at
      // and original_created_at, so a customer who first booked before 1 July
      // and later rescheduled still counts as an old-conditions booking.
      const effective = orig && new Date(orig) < new Date(real) ? orig : real;
      b.created_at = effective;
      changed = true; bookingsFixed++;
      if (new Date(effective) < CUTOFF) beforeCutoff++;
      if (sample.length < 12) sample.push(`${t.feed_id} ${t.start_date}  #${b.ref}  ${effective}${orig && orig !== real ? `  (rebooked; current ${real}, original ${orig})` : ''}  ${new Date(effective) < CUTOFF ? '→ KEEP-BIKES' : ''}`);
    }
    if (changed) {
      if (COMMIT) db.prepare('UPDATE tour_availabilities SET bookings_json=? WHERE availability_id=?').run(JSON.stringify(bookings), t.availId);
      taUpdated++;
    }
  }

  // Apply to the bookings ledger too (permanent record)
  let ledgerFixed = 0;
  for (const ref of Object.keys(createdByRef)) {
    const real = createdByRef[ref];
    const orig = origByRef[ref];
    const effective = orig && new Date(orig) < new Date(real) ? orig : real;
    const led = db.prepare('SELECT booking_created_at FROM bookings WHERE ref=?').get(ref);
    if (led && !led.booking_created_at) {
      if (COMMIT) db.prepare('UPDATE bookings SET booking_created_at=? WHERE ref=?').run(effective, ref);
      ledgerFixed++;
    }
  }

  console.log('Sample of resolved bookings:');
  for (const s of sample) console.log('  ' + s);
  console.log('');
  console.log(`tour_availabilities: ${taUpdated} tours, ${bookingsFixed} bookings ${COMMIT ? 'updated' : 'would be updated'}.`);
  console.log(`  of those, ${beforeCutoff} were booked before 1 July → keep-bikes flag ${COMMIT ? 'now shows' : 'would show'}.`);
  console.log(`  ${unmatched} bookings had no match in the FareHarbor response (ref mismatch — worth a look if non-zero).`);
  console.log(`bookings ledger: ${ledgerFixed} rows ${COMMIT ? 'updated' : 'would be updated'}.`);
  console.log(COMMIT ? '\nDone (written).' : '\nDRY RUN — nothing written. Re-run with --commit to apply.');
})();
