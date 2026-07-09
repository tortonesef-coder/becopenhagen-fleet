// scripts/weekly-report/discover-flow.js
//
// Discovery v2 — captures the REAL generate->download flow on a single
// report, so the production fetcher can replicate it exactly.
//
// It: logs in, opens the Sales-by-item builder, clicks Generate, waits for
// the unique /<report-id>/ URL, then enumerates the top toolbar controls and
// captures whatever URL the download control actually hits (and whether a
// menu appears).
//
// Run headless on the VPS (login already proven to work there):
//   export $(grep -E '^FAREHARBOR_(EMAIL|PASSWORD)=' /etc/environment | xargs)
//   node scripts/weekly-report/discover-flow.js 2>&1 | tee /tmp/fh-flow.txt

const { chromium } = require('playwright');
const COMPANY_SLUG = 'becopenhagen';

// Uses the real saved Sales-by-item report so the test reflects production.
const BUILDER_URL =
  'https://fareharbor.com/becopenhagen/dashboard/reports/advanced/payments-and-refunds/?saved=159190';

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
  if (/login/i.test(page.url())) throw new Error('Login blocked (2FA?). URL: ' + page.url());
  console.log('Logged in OK:', page.url());
  return { ctx, page };
}

(async () => {
  if (!process.env.FAREHARBOR_EMAIL || !process.env.FAREHARBOR_PASSWORD) {
    throw new Error('FAREHARBOR_EMAIL and FAREHARBOR_PASSWORD env vars required');
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await login(browser);

    // Capture any downloads and any attachment/csv network responses.
    const downloads = [];
    page.on('download', (d) => { downloads.push({ url: d.url(), filename: d.suggestedFilename() }); });
    const attachmentResponses = [];
    page.on('response', (resp) => {
      const cd = (resp.headers()['content-disposition'] || '').toLowerCase();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (cd.includes('attachment') || ct.includes('csv') || ct.includes('excel') || ct.includes('spreadsheet')) {
        attachmentResponses.push(resp.url() + '  [' + (ct || '?') + ']  ' + (cd || ''));
      }
    });

    console.log('\nOpening builder:', BUILDER_URL);
    await page.goto(BUILDER_URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    console.log('  builder URL now:', page.url());

    // Read what the date range shows BEFORE generating — this tells us
    // whether the saved report keeps a relative preset ("Last 7 Days") or a
    // frozen custom range. Decides whether reports 1 & 2 need date-setting.
    const dateState = await page.evaluate(() => {
      const out = { selects: [], dateInputs: [] };
      document.querySelectorAll('select').forEach(s => {
        const opt = s.options[s.selectedIndex];
        if (opt && /last|this|next|custom|week|day|month/i.test(opt.textContent)) {
          out.selects.push(opt.textContent.trim());
        }
      });
      document.querySelectorAll('input').forEach(i => {
        const v = i.value || '';
        if (/\d{2}\/\d{2}\/\d{4}/.test(v)) out.dateInputs.push(v);
      });
      return out;
    });
    console.log('  date preset(s) shown:', JSON.stringify(dateState.selects));
    console.log('  date input value(s):', JSON.stringify(dateState.dateInputs));

    // Click Generate.
    const gen = page.locator('button:has-text("Generate"), a:has-text("Generate")').first();
    if (await gen.count() === 0) {
      console.log('  ! could not find a Generate button. Dumping top buttons:');
      const btns = await page.evaluate(() =>
        [...document.querySelectorAll('button,a')].map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 30)
      );
      console.log('   ', JSON.stringify(btns));
    } else {
      console.log('  clicking Generate...');
      await gen.click();
      // Wait for the unique report-instance URL (numeric id) or networkidle.
      try {
        await page.waitForURL(/\/payments-and-refunds\/\d+\/?/, { timeout: 30000 });
      } catch (_) {
        await page.waitForTimeout(6000);
      }
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(3000);
      console.log('  after Generate, URL is:', page.url());
    }

    // Enumerate toolbar controls (icons included) on the generated page.
    const controls = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a,button,[role="button"]').forEach(el => {
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const href = el.getAttribute('href') || '';
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const cls = el.getAttribute('class') || '';
        // toolbar-ish: has an icon class, or download/share/print/export hints
        const hint = /download|export|csv|excel|share|print/i;
        const hasIcon = /icon|fa-|glyph|material|svg/i.test(cls) || el.querySelector('svg,i,use');
        if (hint.test(txt) || hint.test(aria) || hint.test(title) || hint.test(href) || (hasIcon && txt.length < 3)) {
          out.push({
            tag: el.tagName.toLowerCase(),
            txt: txt.slice(0, 30),
            aria: aria.slice(0, 40),
            title: title.slice(0, 40),
            href: href.slice(0, 140),
            cls: cls.slice(0, 60),
          });
        }
      });
      return out.slice(0, 25);
    });
    console.log('\n  toolbar / icon controls on generated page:');
    controls.forEach(c => console.log('   -', c.tag,
      c.txt ? 'txt=' + JSON.stringify(c.txt) : '',
      c.aria ? 'aria=' + JSON.stringify(c.aria) : '',
      c.title ? 'title=' + JSON.stringify(c.title) : '',
      c.href ? 'href=' + c.href : '',
      c.cls ? 'cls=' + c.cls : ''));

    // Try to trigger the download control and see what fires.
    const dl = page.locator('[title*="Download" i], [aria-label*="Download" i], a:has-text("Download"), button:has-text("Download")').first();
    if (await dl.count() > 0) {
      console.log('\n  clicking the Download control to see what happens...');
      await dl.click().catch(e => console.log('   click error:', e.message.slice(0, 60)));
      await page.waitForTimeout(4000);
      // A menu may have appeared — enumerate any CSV/Excel options now visible.
      const menu = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('a,button,[role="menuitem"]').forEach(el => {
          const t = (el.textContent || '').trim();
          if (/csv|excel|\.xls|spreadsheet|comma/i.test(t)) out.push({ txt: t.slice(0, 30), href: (el.getAttribute('href')||'').slice(0,140) });
        });
        return out.slice(0, 10);
      });
      if (menu.length) {
        console.log('  a format menu appeared with options:');
        menu.forEach(m => console.log('   -', JSON.stringify(m.txt), m.href ? ('href=' + m.href) : ''));
      } else {
        console.log('  no format menu detected (download may have started directly).');
      }
    } else {
      console.log('\n  ! no Download control found on the generated page by title/aria/text.');
    }

    await page.waitForTimeout(3000);
    console.log('\n=== RESULTS ===');
    console.log('downloads captured:', JSON.stringify(downloads, null, 2));
    console.log('attachment/csv network responses:', JSON.stringify(attachmentResponses, null, 2));
    console.log('\nPaste this whole output back.');
  } finally {
    await browser.close();
  }
})();
