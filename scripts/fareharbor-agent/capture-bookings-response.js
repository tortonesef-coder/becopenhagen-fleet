const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  let bookingsResponseBody = null;

  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/availabilities/2030110329/bookings/')) {
      try {
        bookingsResponseBody = await resp.text();
        console.log('CAPTURED bookings response, status:', resp.status(), 'size:', bookingsResponseBody.length);
      } catch(e) { console.log('Error capturing:', e.message); }
    }
  });

  await page.goto('https://fareharbor.com/login/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  if (await page.locator('text="Shortname"').count() > 0) {
    await page.locator('text="Shortname"').locator('xpath=following::input[1]').first().fill('becopenhagen');
    await page.locator('button:has-text("Next")').first().click();
    await page.waitForTimeout(2000);
  }
  await page.locator('input[type="email"],input[name="email"]').first().fill(process.env.FAREHARBOR_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.FAREHARBOR_PASSWORD);
  await page.locator('button:has-text("Log in")').first().click();
  await page.waitForTimeout(5000);

  const url = 'https://fareharbor.com/becopenhagen/dashboard/bookings/?overlay=/items/707493/availabilities/2030110329/';
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
  await page.waitForTimeout(5000);

  if (bookingsResponseBody) {
    require('fs').writeFileSync('/tmp/bookings-response.json', bookingsResponseBody);
    console.log('\nSaved to /tmp/bookings-response.json');
    console.log('\nFirst 3000 chars:');
    console.log(bookingsResponseBody.substring(0, 3000));
  } else {
    console.log('Never captured that response.');
  }

  await browser.close();
})();
