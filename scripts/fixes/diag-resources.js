#!/usr/bin/env node
// DIAGNOSTIC ONLY — read-only, writes nothing.
//
// Question: can we trust FareHarbor's resource_use_summaries for EVERY bike type
// (adult, touring, cargo, child-seat…), not just "Guided Tour Bikes"?
//
// Why this matters: today only Guided Tour Bikes is trusted. The v2 scraper's own
// comments say earlier work observed (a) the generic Adult Bike pool reporting
// total FLEET CAPACITY instead of a per-booking count, and (b) the Electric Cargo
// Bike reporting FRACTIONAL values. So everything else is ignored on purpose.
// Fede wants resources used everywhere (right instinct: resources record the bike
// ACTUALLY assigned, whereas booking text only says what the customer ordered).
// Before switching, prove whether those old anomalies are real and still present.
//
//   node scripts/fixes/diag-resources.js [days]     (default 4)

const { chromium } = require('playwright');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const COMPANY_SLUG = 'becopenhagen';
const DAYS = parseInt(process.argv[2], 10) || 4;
const ALL_ITEM_IDS = '712177,707493,713560,709131,713563,729348,730640,650858,190975,190977,190978,190980,651114,651124,190983,651812,652669,652693,652695,652697,652699,652703,190987,702701,706960,583653,190971,201570,201571';

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

(async () => {
  if (!process.env.FAREHARBOR_EMAIL || !process.env.FAREHARBOR_PASSWORD) {
    console.error('FAREHARBOR_EMAIL / FAREHARBOR_PASSWORD not set in .env');
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true });
  const page = await login(browser);

  const now = new Date();
  const months = new Set([`${now.getFullYear()}-${now.getMonth() + 1}`]);
  const later = new Date(Date.now() + DAYS * 864e5);
  months.add(`${later.getFullYear()}-${later.getMonth() + 1}`);

  const avails = [];
  for (const ym of months) {
    const [year, month] = ym.split('-').map(Number);
    for (let week = 1; week <= 6; week++) {
      const url = `https://fareharbor.com/api/v1/companies/${COMPANY_SLUG}/items/${ALL_ITEM_IDS}/calendar/${year}/${String(month).padStart(2,'0')}/?allow_grouped=yes&include_resource_use_summaries=yes&path=2&week_number=${week}`;
      try {
        const resp = await page.request.get(url, { timeout: 60000 });
        if (!resp.ok()) continue;
        const json = await resp.json();
        const walk = (n) => {
          if (!n || typeof n !== 'object') return;
          if (Array.isArray(n)) return n.forEach(walk);
          if (n.resource_use_summaries && n.start_at) avails.push(n);
          Object.values(n).forEach(walk);
        };
        walk(json);
      } catch {}
    }
  }
  await browser.close();

  const from = new Date(Date.now() - 864e5).toISOString();
  const to = new Date(Date.now() + DAYS * 864e5).toISOString();
  const soon = avails.filter(a => a.start_at >= from && a.start_at <= to)
                     .sort((a,b) => a.start_at.localeCompare(b.start_at));

  console.log(`\nFound ${avails.length} availabilities; ${soon.length} within the next ${DAYS} day(s).\n`);

  const paxOf = (av) => av.customer_count
    ?? (av.customer_type_rate_totals || []).reduce((s,r) => s + (r.customer_count || 0), 0)
    ?? null;

  const stats = {};
  soon.slice(0, 45).forEach(av => {
    const when = av.start_at.substring(0,16).replace('T',' ');
    const item = (av.item?.name || av.item?.short_name || '?').substring(0,32);
    const pax = paxOf(av);
    const rus = av.resource_use_summaries || [];
    if (!rus.length) return;
    console.log(`  ${when}  ${item.padEnd(32)} pax=${pax ?? '?'}`);
    rus.forEach(e => {
      const rn = (e.resource?.name || '?').replace(/\s*\(.*\)\s*$/, '').trim();
      const pk = e.resource?.pk ?? '';
      const cnt = e.total_use_count;
      const flags = [];
      if (!Number.isInteger(cnt)) flags.push('⚠FRACTIONAL');
      if (typeof pax === 'number' && pax > 0 && Number.isInteger(cnt) && cnt > pax + 2) flags.push('⚠>PAX+2 (fleet capacity?)');
      console.log(`       ${rn.substring(0,38).padEnd(38)} pk=${String(pk).padEnd(7)} use=${String(cnt).padEnd(7)} ${flags.join(' ')}`);
      const s = stats[rn] || (stats[rn] = { pk, n:0, frac:0, over:0, vals:new Set() });
      s.n++; s.vals.add(cnt);
      if (!Number.isInteger(cnt)) s.frac++;
      if (typeof pax === 'number' && pax > 0 && Number.isInteger(cnt) && cnt > pax + 2) s.over++;
    });
  });

  console.log('\n=== per-resource verdict ===\n');
  Object.entries(stats).sort((a,b) => b[1].n - a[1].n).forEach(([name, s]) => {
    const verdict = s.frac ? '✗ FRACTIONAL — not a per-booking count'
      : s.over ? '✗ exceeds pax — may be reporting FLEET CAPACITY'
      : '✓ clean per-booking count';
    console.log(`  ${name.substring(0,40).padEnd(40)} pk=${String(s.pk).padEnd(7)} seen=${String(s.n).padEnd(3)} ${verdict}`);
    console.log(`      values: ${[...s.vals].slice(0,14).join(', ')}`);
  });
  console.log('\nIf every bike resource shows ✓, we can read ALL bike types from resources');
  console.log('and drop the text parsing. Any ✗ tells us which resource still misbehaves.\n');
})();
