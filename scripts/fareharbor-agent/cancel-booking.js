#!/usr/bin/env node
/**
 * FareHarbor Cancel Booking Agent
 *
 * Cancels a real FareHarbor booking by booking reference number.
 *
 * Usage:
 *   node cancel-booking.js --booking=359158707
 *
 * Required env vars:
 *   FAREHARBOR_EMAIL, FAREHARBOR_PASSWORD
 */

const { chromium } = require('playwright');

const FAREHARBOR_EMAIL = process.env.FAREHARBOR_EMAIL;
const FAREHARBOR_PASSWORD = process.env.FAREHARBOR_PASSWORD;
const COMPANY_SLUG = 'becopenhagen';

async function loginToDashboard(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://fareharbor.com/login/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Shortname step
  if (await page.locator('text="Shortname"').count() > 0) {
    const field = page.locator('text="Shortname"').locator('xpath=following::input[1]').first();
    await field.fill(COMPANY_SLUG);
    await page.locator('button:has-text("Next")').first().click();
    await page.waitForTimeout(2000);
  }

  // Email
  const emailSelectors = ['input[name="email"]','input[type="email"]','input[name="username"]','input[placeholder*="mail" i]'];
  let emailField = null;
  for (const sel of emailSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) { emailField = loc; break; }
  }
  if (!emailField) throw new Error('Could not find email field');
  await emailField.fill(FAREHARBOR_EMAIL);

  // Password
  const passField = page.locator('input[type="password"]').first();
  if (await passField.count() === 0) throw new Error('Could not find password field');
  await passField.fill(FAREHARBOR_PASSWORD);

  // Submit
  const submitSelectors = ['button:has-text("Log in")','button:has-text("Sign in")','button[type="submit"]'];
  let submitBtn = null;
  for (const sel of submitSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) { submitBtn = loc; break; }
  }
  if (!submitBtn) throw new Error('Could not find login button');
  await submitBtn.click();
  await page.waitForTimeout(3000);

  if (!page.url().includes('dashboard')) {
    throw new Error('Login failed — not on dashboard after login. URL: ' + page.url());
  }

  return { context, page };
}

async function cancelBooking(bookingRef) {
  if (!FAREHARBOR_EMAIL || !FAREHARBOR_PASSWORD) {
    throw new Error('FAREHARBOR_EMAIL and FAREHARBOR_PASSWORD env vars required');
  }

  const browser = await chromium.launch({ headless: true });

  try {
    console.log('Logging into FareHarbor dashboard...');
    const { page } = await loginToDashboard(browser);
    console.log('Logged in. Navigating to booking', bookingRef, '...');

    // FareHarbor booking detail URL
    const bookingUrl = `https://fareharbor.com/${COMPANY_SLUG}/manage/bookings/${bookingRef}/`;
    await page.goto(bookingUrl, { waitUntil: 'networkidle', timeout: 20000 });
    console.log('Booking page URL:', page.url());

    // Check we landed on the right page
    if (!page.url().includes(bookingRef)) {
      await page.screenshot({ path: `/tmp/fh-cancel-debug-${bookingRef}.png`, fullPage: true });
      throw new Error(`Could not navigate to booking ${bookingRef}. See /tmp/fh-cancel-debug-${bookingRef}.png`);
    }

    // Find the cancel button — FareHarbor uses various labels
    const cancelSelectors = [
      'button:has-text("Cancel booking")',
      'button:has-text("Cancel Booking")',
      'a:has-text("Cancel booking")',
      'a:has-text("Cancel Booking")',
      'button:has-text("Cancel")',
    ];
    let cancelBtn = null;
    for (const sel of cancelSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) { cancelBtn = loc; console.log('Cancel button found:', sel); break; }
    }

    if (!cancelBtn) {
      await page.screenshot({ path: `/tmp/fh-cancel-debug-${bookingRef}.png`, fullPage: true });
      const bodyText = await page.locator('body').innerText();
      console.log('Page text (first 500):', bodyText.substring(0, 500));
      throw new Error(`Could not find cancel button for booking ${bookingRef}. See /tmp/fh-cancel-debug-${bookingRef}.png`);
    }

    await cancelBtn.click();
    await page.waitForTimeout(2000);

    // Confirm dialog — FareHarbor may show a modal asking to confirm
    const confirmSelectors = [
      'button:has-text("Yes, cancel")',
      'button:has-text("Confirm cancellation")',
      'button:has-text("Confirm")',
      'button:has-text("Yes")',
    ];
    for (const sel of confirmSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        console.log('Confirm button found:', sel);
        await loc.click();
        await page.waitForTimeout(2000);
        break;
      }
    }

    // Check for success
    const pageText = await page.locator('body').innerText();
    const success = /cancelled|canceled|cancellation/i.test(pageText);
    if (success) {
      console.log('✅ Booking', bookingRef, 'successfully cancelled');
      return { ok: true, booking_ref: bookingRef };
    } else {
      await page.screenshot({ path: `/tmp/fh-cancel-debug-${bookingRef}.png`, fullPage: true });
      throw new Error(`Cancel may not have worked for ${bookingRef} — check screenshot /tmp/fh-cancel-debug-${bookingRef}.png`);
    }

  } finally {
    await browser.close();
  }
}

// ── CLI entry point ─────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, '').split('='))
);

if (!args.booking) {
  console.error('Usage: node cancel-booking.js --booking=<booking_ref>');
  process.exit(1);
}

cancelBooking(args.booking)
  .then(r => { console.log('Done:', r); process.exit(0); })
  .catch(e => { console.error('Error:', e.message); process.exit(1); });

module.exports = { cancelBooking };
