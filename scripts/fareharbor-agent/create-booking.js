#!/usr/bin/env node
/**
 * FareHarbor Booking Agent
 *
 * Creates a real booking on FareHarbor for a walk-in rental, using a
 * logged-in staff session. Marks payment as Cash or Previously paid (POS),
 * fills the staff-only Bike IDs field, and respects FareHarbor's own
 * "Overbooking" threshold per resource type (never books past it).
 *
 * Usage (manual test):
 *   node create-booking.js --item=190975 --date=2026-07-02 --time=10:00 \
 *     --bikeType="Adult's Bikes" --qty=1 --bikeIds=A22 \
 *     --customerName="Test Customer" --payment=cash
 *
 * Required env vars:
 *   FAREHARBOR_EMAIL, FAREHARBOR_PASSWORD
 */

const { chromium } = require('playwright');

const FAREHARBOR_EMAIL = process.env.FAREHARBOR_EMAIL;
const FAREHARBOR_PASSWORD = process.env.FAREHARBOR_PASSWORD;
const COMPANY_SLUG = 'becopenhagen';
const DASHBOARD_LOGIN_URL = 'https://fareharbor.com/login/';

// ── Step 1: find the availability ID using an ANONYMOUS context ──────────
// The public booking widget requires being logged out, so we use a
// separate, fully isolated browser context (no cookies shared with the
// authenticated dashboard context) purely to discover the availability_id
// for a given item + date + time.
async function findAvailabilityId(browser, { itemId, date, time }) {
  const context = await browser.newContext(); // fresh, anonymous, no auth
  const page = await context.newPage();

  try {
    const [year, month, dayNum] = date.split('-').map(s => parseInt(s, 10));

    // Navigate directly to the correct month's calendar view via URL —
    // more reliable than clicking "Next Month" repeatedly.
    const url = `https://fareharbor.com/embeds/book/${COMPANY_SLUG}/items/${itemId}/calendar/${year}/${String(month).padStart(2,'0')}/`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    console.log('Page title:', await page.title());
    console.log('Page URL:', page.url());

    // Each day cell shows the day number, then a button labeled with the
    // item name (e.g. "1-Day Rentals") underneath it — THAT button is what
    // actually opens the time slot list, not the bare day number.
    // We find the day-number text, then look for the nearest following
    // button/link containing the item's display name.
    const dayNumberLocator = page.locator(`text="${dayNum}"`).first();
    const dayCount = await dayNumberLocator.count();
    console.log(`Day number matches for "${dayNum}":`, dayCount);
    if (dayCount === 0) {
      await page.screenshot({ path: '/tmp/fh-debug-2-no-day-found.png', fullPage: true });
      throw new Error(`Could not find day cell "${dayNum}" on the calendar page.`);
    }

    // The item button sits in the same calendar cell, just below the day number.
    // Use XPath to go to the day number's container, then find a button within it.
    const dayCellButton = dayNumberLocator.locator(
      'xpath=ancestor::*[self::div or self::td][1]//button | ancestor::*[self::div or self::td][1]//a[contains(@class,"item") or self::a]'
    ).first();

    let clicked = false;
    if (await dayCellButton.count() > 0) {
      await dayCellButton.click();
      clicked = true;
    } else {
      // Fallback: click whatever button/link is immediately after the day number in DOM order
      const fallbackBtn = dayNumberLocator.locator('xpath=following::button[1] | following::a[1]').first();
      if (await fallbackBtn.count() > 0) {
        await fallbackBtn.click();
        clicked = true;
      }
    }

    if (!clicked) {
      await page.screenshot({ path: '/tmp/fh-debug-2b-no-button-found.png', fullPage: true });
      throw new Error(`Found day "${dayNum}" but no clickable item button near it.`);
    }

    await page.waitForTimeout(1500);
    await page.screenshot({ path: '/tmp/fh-debug-3-after-day-click.png', fullPage: true });
    console.log('Saved debug screenshot: /tmp/fh-debug-3-after-day-click.png');
    console.log('URL after day click:', page.url());

    // Some days/items land directly on the booking page after the day click
    // (e.g. when only one time slot exists for that date). Most days show a
    // time-slot LIST first (confirmed: even 4-Day Rentals show multiple times
    // like 09:30, 10:00, 10:30, 11:00 — this is not purely a single-day-vs-
    // multi-day distinction). So: check for a direct landing first, but don't
    // assume it based on item type — only based on what's actually on screen.
    let match = page.url().match(/availability\/(\d+)/);
    if (match) {
      console.log('Day click landed directly on booking page (single available time slot) — skipping time-slot step.');
      return match[1];
    }

    // Now look for the time slot matching `time` (e.g. "10:00")
    const timeLocator = page.locator(`text="${time}"`).first();
    const timeCount = await timeLocator.count();
    console.log('Time text matches found on page:', timeCount);
    if (timeCount === 0) {
      await page.screenshot({ path: '/tmp/fh-debug-4-no-time-found.png', fullPage: true });
      console.log('Saved debug screenshot: /tmp/fh-debug-4-no-time-found.png');
      const bodyText = await page.locator('body').innerText();
      console.log('--- Page text (first 1500 chars) ---');
      console.log(bodyText.substring(0, 1500));
      console.log('--- end page text ---');
    }
    await timeLocator.waitFor({ timeout: 10000 });
    await timeLocator.click();
    await page.waitForTimeout(1500);

    // After clicking, the URL or an inner link should contain availability/<id>
    const currentUrl = page.url();
    match = currentUrl.match(/availability\/(\d+)/);

    if (!match) {
      // Sometimes the click opens a panel with a "Book Now" link containing the ID
      const bookLink = await page.locator('a[href*="/availability/"]').first();
      if (await bookLink.count() > 0) {
        const href = await bookLink.getAttribute('href');
        match = href.match(/availability\/(\d+)/);
      }
    }

    if (!match) {
      throw new Error(`Could not find availability ID for item ${itemId} on ${date} ${time}. The page structure may have changed.`);
    }

    return match[1];
  } finally {
    await context.close();
  }
}

// ── Step 2: log into the staff dashboard (AUTHENTICATED context) ─────────
async function loginToDashboard(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(DASHBOARD_LOGIN_URL, { waitUntil: 'networkidle' });
  console.log('Login page title:', await page.title());
  console.log('Login page URL:', page.url());

  // The login page is a JS app — give it a moment to actually render
  // past any "Loading..." state before we check what's on screen.
  await page.waitForTimeout(2000);
  const earlyText = await page.locator('body').innerText();
  console.log('--- Initial login page text ---');
  console.log(earlyText.substring(0, 300));
  console.log('--- end ---');

  // Step 1 of 2: FareHarbor first asks for the company "Shortname" before
  // showing the actual email/password form for that company.
  const hasShortnameStep = await page.locator('text="Shortname"').count() > 0;
  console.log('Shortname text present on page:', hasShortnameStep);
  if (hasShortnameStep) {
    console.log('Shortname step detected, filling:', COMPANY_SLUG);
    // Target the input specifically associated with the Shortname label,
    // not just "the first input on the page" which can grab the wrong field.
    const shortnameField = page.locator('text="Shortname"').locator('xpath=following::input[1]').first();
    const fieldCount = await shortnameField.count();
    console.log('Shortname input field found:', fieldCount > 0);
    if (fieldCount === 0) throw new Error('Shortname label found but no associated input field.');

    await shortnameField.click();
    await shortnameField.fill(COMPANY_SLUG);
    const typedValue = await shortnameField.inputValue();
    console.log('Shortname field now contains:', JSON.stringify(typedValue));

    const nextBtn = page.locator('button:has-text("Next")').first();
    await nextBtn.click();
    await page.waitForTimeout(2000);
    console.log('URL after Next click:', page.url());
  }

  await page.screenshot({ path: '/tmp/fh-debug-5-login-page.png', fullPage: true });
  console.log('Saved debug screenshot: /tmp/fh-debug-5-login-page.png');

  // Try a broad set of likely selectors for the email field, including
  // label-based lookup since FareHarbor's form may not use name/id/type=email.
  const emailSelectors = [
    'input[name="email"]', 'input[type="email"]', 'input[name="username"]',
    'input#id_email', 'input#email', 'input[placeholder*="mail" i]',
    'input[placeholder*="username" i]',
  ];
  let emailField = null;
  for (const sel of emailSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) { emailField = loc; console.log('Email field matched selector:', sel); break; }
  }
  if (!emailField) {
    // Fallback: find the input that follows the "Email" label text
    const byLabel = page.locator('text="Email"').locator('xpath=following::input[1]').first();
    if (await byLabel.count() > 0) { emailField = byLabel; console.log('Email field matched via label fallback'); }
  }
  if (!emailField) {
    const bodyText = await page.locator('body').innerText();
    console.log('--- Login page text (first 1000 chars) ---');
    console.log(bodyText.substring(0, 1000));
    throw new Error('Could not find email field on login page. See /tmp/fh-debug-5-login-page.png');
  }
  await emailField.fill(FAREHARBOR_EMAIL);

  const passwordSelectors = ['input[name="password"]', 'input[type="password"]', 'input#id_password', 'input#password'];
  let passwordField = null;
  for (const sel of passwordSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) { passwordField = loc; console.log('Password field matched selector:', sel); break; }
  }
  if (!passwordField) {
    const byLabel = page.locator('text="Password"').locator('xpath=following::input[1]').first();
    if (await byLabel.count() > 0) { passwordField = byLabel; console.log('Password field matched via label fallback'); }
  }
  if (!passwordField) throw new Error('Could not find password field on login page.');
  await passwordField.fill(FAREHARBOR_PASSWORD);

  const submitSelectors = ['button:has-text("Log in")', 'button:has-text("Sign in")', 'button[type="submit"]', 'input[type="submit"]'];
  let submitBtn = null;
  for (const sel of submitSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) { submitBtn = loc; console.log('Submit button matched selector:', sel); break; }
  }
  if (!submitBtn) throw new Error('Could not find login submit button.');
  await submitBtn.click();

  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/fh-debug-6-after-login.png', fullPage: true });
  console.log('Saved debug screenshot: /tmp/fh-debug-6-after-login.png');
  console.log('URL after login attempt:', page.url());

  return { context, page };
}

// ── Step 3: check the quantity dropdown for the real (non-overbooking) max ─
async function getMaxAvailable(page, bikeTypeLabel) {
  // Find the <select> associated with the bike type row by its visible label text.
  // Search up through several ancestor levels since the label and the
  // dropdown can be nested a few divs apart depending on the row layout.
  const row = page.locator(`text="${bikeTypeLabel}"`).first();
  const rowCount = await row.count();
  console.log(`Bike type label "${bikeTypeLabel}" found:`, rowCount);
  if (rowCount === 0) {
    throw new Error(`Could not find bike type "${bikeTypeLabel}" on the booking page at all.`);
  }

  let select = null;
  for (let depth = 1; depth <= 6; depth++) {
    const candidate = row.locator(`xpath=ancestor::*[${depth}]//select`).first();
    if (await candidate.count() > 0) { select = candidate; console.log(`Select found at ancestor depth ${depth}`); break; }
  }
  if (!select) {
    throw new Error(`Found bike type label "${bikeTypeLabel}" but no <select> nearby in any ancestor up to depth 6.`);
  }

  const options = await select.locator('option').allTextContents();
  console.log('Raw dropdown options:', JSON.stringify(options));

  // Options appear in order: 0,1,2,...N, then "Overbooking:" separator, then more numbers.
  // We only trust options BEFORE any option whose text includes "Overbooking".
  let maxSafe = 0;
  for (const opt of options) {
    const trimmed = opt.trim();
    if (/overbooking/i.test(trimmed)) break;
    const n = parseInt(trimmed, 10);
    if (!isNaN(n)) maxSafe = Math.max(maxSafe, n);
  }
  console.log('Computed maxSafe (non-overbooking):', maxSafe);
  return { select, maxSafe };
}

// ── Step 4: fill and submit the booking ───────────────────────────────────
async function createBooking({
  itemId, availabilityId, items, // items: [{ bikeTypeLabel, qty, bikeIds }, ...]
  customerName, phone, email, paymentMethod, paymentComment,
}) {
  const browser = await chromium.launch({ headless: true });

  try {
    const { page } = await loginToDashboard(browser);

    const bookUrl = `https://fareharbor.com/${COMPANY_SLUG}/items/${itemId}/availability/${availabilityId}/book/`;
    await page.goto(bookUrl, { waitUntil: 'networkidle', timeout: 20000 });
    console.log('Booking page URL:', page.url());
    await page.screenshot({ path: '/tmp/fh-debug-7-booking-page.png', fullPage: true });
    console.log('Saved debug screenshot: /tmp/fh-debug-7-booking-page.png');

    // Customer details — match ONLY by exact placeholder text, since broader
    // attribute-substring selectors can accidentally hit hidden form fields
    // (FareHarbor's booking form has many hidden inputs with "name" in their
    // own internal field names, e.g. "affiliateCompanyShortname").
    const nameField = page.locator('input[placeholder="Full name"]').first();
    const nameFieldCount = await nameField.count();
    console.log('Full name field found:', nameFieldCount);
    if (nameFieldCount === 0) {
      throw new Error('Could not find "Full name" input on booking page. See /tmp/fh-debug-7-booking-page.png');
    }
    await nameField.fill(customerName);

    if (phone) {
      const phoneField = page.locator('input[placeholder="Phone number"]').first();
      if (await phoneField.count() > 0) await phoneField.fill(phone);
    }
    if (email) {
      const emailField = page.locator('input[placeholder="Email Address"]').first();
      if (await emailField.count() > 0) await emailField.fill(email);
    }

    // Set quantity for EACH bike type in this booking — respecting the
    // overbooking guard independently for each one.
    const allBikeIds = [];
    for (const item of items) {
      const { select, maxSafe } = await getMaxAvailable(page, item.bikeTypeLabel);
      if (item.qty > maxSafe) {
        throw new Error(`Only ${maxSafe} of "${item.bikeTypeLabel}" available without overbooking (requested ${item.qty}).`);
      }
      await select.selectOption(String(item.qty));
      await page.waitForTimeout(500);
      if (item.bikeIds && item.bikeIds.length > 0) allBikeIds.push(...item.bikeIds);
    }
    await page.waitForTimeout(800); // let FareHarbor recalculate price/payment panel after all quantities set

    // Bike IDs (staff-only field) — one combined list across all bike types
    if (allBikeIds.length > 0) {
      const bikeIdsLabel = page.locator('text="Bike IDs"').first();
      const bikeIdsTextarea = bikeIdsLabel.locator('xpath=following::textarea[1]');
      await bikeIdsTextarea.fill(allBikeIds.join('\n'));
    }

    // Payment method
    const paymentLabel = paymentMethod === 'cash' ? 'Cash' : 'Previously paid';
    await page.locator(`text="${paymentLabel}"`).first().click();

    // Ensure "Pay in full" is selected (not partial/no payment)
    const payInFull = page.locator('text="Pay in full"').first();
    if (await payInFull.count() > 0) await payInFull.click();

    // Payment comment (only visible to staff)
    if (paymentComment) {
      const addComment = page.locator('text="Add comment to payment"').first();
      if (await addComment.count() > 0) {
        await addComment.click();
        await page.waitForTimeout(300);
        const commentBox = page.locator('textarea[placeholder*="Payment comment"]').first();
        await commentBox.fill(paymentComment);
      }
    }

    // Final submit
    const completeBtn = page.locator('button:has-text("Complete booking")').first();
    await completeBtn.waitFor({ timeout: 10000 });
    await completeBtn.click();

    // Wait for confirmation and extract the real booking reference from the
    // page text itself ("Booking #359158707"), which is far more reliable
    // than guessing at a URL pattern.
    await page.waitForTimeout(3000);
    const finalUrl = page.url();

    let bookingRef = null;
    const refLocator = page.locator('text=/Booking #\\d+/').first();
    if (await refLocator.count() > 0) {
      const refText = await refLocator.innerText();
      const m = refText.match(/Booking #(\d+)/);
      if (m) bookingRef = m[1];
    }
    if (!bookingRef) {
      // Fallback: scan the whole page body text for the same pattern
      const bodyText = await page.locator('body').innerText();
      const m = bodyText.match(/Booking #(\d+)/);
      if (m) bookingRef = m[1];
    }

    return { ok: true, booking_ref: bookingRef, final_url: finalUrl };

  } finally {
    await browser.close();
  }
}

// ── CLI entry point for manual testing ────────────────────────────────────
async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.join('=')];
    })
  );

  if (!FAREHARBOR_EMAIL || !FAREHARBOR_PASSWORD) {
    console.error('Missing FAREHARBOR_EMAIL / FAREHARBOR_PASSWORD environment variables.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  let availabilityId = args.availabilityId;

  if (!availabilityId) {
    console.log('Looking up availability ID...');
    availabilityId = await findAvailabilityId(browser, {
      itemId: args.item, date: args.date, time: args.time,
    });
    console.log('Found availability ID:', availabilityId);
  }
  await browser.close();

  console.log('Creating booking...');

  // Support two CLI shapes:
  // 1. Simple single-type: --bikeType=... --qty=... --bikeIds=A,B,C
  // 2. Multi-type: --items='[{"bikeTypeLabel":"Adult'\''s Bikes","qty":1,"bikeIds":["A22"]},...]'
  let items;
  if (args.items) {
    items = JSON.parse(args.items);
  } else {
    items = [{
      bikeTypeLabel: args.bikeType,
      qty: parseInt(args.qty, 10),
      bikeIds: args.bikeIds ? args.bikeIds.split(',') : [],
    }];
  }

  const result = await createBooking({
    itemId: args.item,
    availabilityId,
    items,
    customerName: args.customerName,
    phone: args.phone,
    email: args.email,
    paymentMethod: args.payment || 'cash',
    paymentComment: args.payment === 'card' ? 'POS' : undefined,
  });

  console.log('Result:', JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { findAvailabilityId, createBooking, getMaxAvailable };
