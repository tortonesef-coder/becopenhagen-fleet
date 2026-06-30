# FareHarbor Booking Agent — Manual Test

This is a standalone script, **not yet wired into the main app**. Test it
manually first to confirm every step works against real FareHarbor, before
we connect it to the rental checkout flow.

## Setup on the VPS

```bash
cd /var/www/becopenhagen-fleet/scripts/fareharbor-agent
npm install
npx playwright install chromium --with-deps
```

The `--with-deps` flag installs system libraries Chromium needs (fonts,
codecs etc.) — required once per VPS, not per deploy.

## Credentials

Add to `/etc/environment` (never commit these, never paste in chat):

```bash
echo 'FAREHARBOR_EMAIL=your-login-email' >> /etc/environment
echo 'FAREHARBOR_PASSWORD=your-password' >> /etc/environment
source /etc/environment
```

## Manual test run

Pick a REAL upcoming date/time on a rental item, with a bike type that has
genuine availability. Start small — 1 bike, a name like "Test Agent" so
it's obvious in your bookings list, and Cash payment so there's no card
complexity yet.

```bash
cd /var/www/becopenhagen-fleet/scripts/fareharbor-agent
FAREHARBOR_EMAIL=... FAREHARBOR_PASSWORD=... node create-booking.js \
  --item=190975 \
  --date=2026-07-02 \
  --time=10:00 \
  --bikeType="Adult's Bikes" \
  --qty=1 \
  --bikeIds=A22 \
  --customerName="Test Agent" \
  --payment=cash
```

Watch the console output. It will:
1. Open an anonymous browser context, find the matching time slot, extract
   the availability ID
2. Open a second, separate authenticated context, log into the dashboard
3. Navigate to the booking form for that exact availability
4. Fill name, quantity (checking the real non-overbooking max first), bike
   IDs, payment method
5. Click "Complete booking"
6. Print the resulting booking reference

**This creates a REAL booking** — go check it on the FareHarbor dashboard
afterward and cancel/delete it if it was just a test.

## What to report back if something breaks

This script is built from screenshots of the live FareHarbor UI taken on
30 June 2026. If FareHarbor changes their layout, the most likely failure
points are the `page.locator(...)` selectors in `create-booking.js` —
share the console error and a fresh screenshot of whatever step failed,
and the selector can be patched.

## Known gaps before this is production-ready

- The availability-ID lookup (`findAvailabilityId`) was written from the
  documented URL pattern and FareHarbor's standard widget structure, but
  was NOT verified end-to-end live (the test session hit Chrome permission
  issues mid-walkthrough). **Test this function specifically first** —
  if it fails to find the time slot, the selectors for the calendar/date
  click and time-slot click will need adjusting based on what you see.
- Login form selectors (`input[name="email"]` etc.) are best-guess
  standard patterns, not confirmed against FareHarbor's actual login page.
- Booking reference extraction after submit is a best-effort guess at the
  URL pattern — confirm what the actual post-submit URL/page looks like
  and adjust if needed.
