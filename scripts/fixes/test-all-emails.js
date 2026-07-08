#!/usr/bin/env node
// Sends one of EVERY email notification type to the address you pass, and ONLY
// that address. Lets you eyeball that each type delivers and renders correctly.
// No guide is ever emailed. Safe, repeatable.
//
//   node scripts/fixes/test-all-emails.js you@example.com
//
// The first-booking email uses the real production path (test mode) against a
// real upcoming tour; the rest are representative samples with the real footer.

const { getDb } = require('../../src/db/schema');
const { guideMatches } = require('../../src/guide-name-match');
const { notifyFirstBooking } = require('../../src/notify-first-booking');
const { sendEmail, sendPasswordResetEmail, sendVerificationCodeEmail, EMAIL_FOOTER } = require('../../src/email');

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/fixes/test-all-emails.js you@example.com');
  process.exit(1);
}
const db = getDb();
const tag = (s) => `[TEST] ${s}`;
const P = (b) => `<p>Hi there (test copy — this went only to you),</p>${b}${EMAIL_FOOTER}`;

(async () => {
  const results = [];
  const send = async (label, fn) => {
    try { await fn(); results.push(`  ✓ ${label}`); }
    catch (e) { results.push(`  ✗ ${label} — ${e.message}`); }
  };

  // 1. Transactional (real functions)
  await send('verification_code', () => sendVerificationCodeEmail(email, 'You', '123456'));
  await send('password_reset', () => sendPasswordResetEmail(email, 'You', 'https://app.becopenhagen.dk/reset?token=TEST'));

  // 2. First booking — REAL production path via test mode, real upcoming tour
  const today = new Date().toISOString().substring(0, 10);
  const members = db.prepare("SELECT id,name,email FROM team_members WHERE active=1 AND email IS NOT NULL").all();
  const tours = db.prepare("SELECT availability_id, feed_id, start_date, guide FROM tour_availabilities WHERE feed_type='tour' AND guide IS NOT NULL AND start_date >= ? ORDER BY start_date").all(today);
  const picked = tours.find(r => members.some(m => guideMatches(r.guide, m.name)));
  if (picked) {
    await send(`first_booking (real template, ${picked.feed_id} ${picked.start_date})`,
      async () => { if (!notifyFirstBooking(String(picked.availability_id), { testEmailTo: email })) throw new Error('notifier returned false'); });
  } else {
    results.push('  · first_booking — skipped (no upcoming tour with a matching guide; representative sample sent instead)');
    await send('first_booking (sample)', () => sendEmail({ to: email, toName: 'You', subject: tag('First booking — L3 on Monday'), htmlContent: P('<p>Your first booking just came in for a tour.</p>'), category: 'first_booking' }));
  }

  // 3. Representative samples of the rest (real footer, real categories)
  await send('zero_bookings', () => sendEmail({ to: email, toName: 'You', subject: tag('No more bookings — L3 on Monday'), htmlContent: P('<p>All bookings for your tour have been cancelled. The slot is still open.</p>'), category: 'zero_bookings' }));
  await send('tour_reminder', () => sendEmail({ to: email, toName: 'You', subject: tag('Reminder — L3 tomorrow at 10:30'), htmlContent: P('<p>Reminder: you have a tour tomorrow. Guest list and bikes needed shown in the app.</p>'), category: 'tour_reminder' }));
  await send('tour_cancelled', () => sendEmail({ to: email, toName: 'You', subject: tag('Tour cancelled — L3 on Monday'), htmlContent: P('<p>The following tour has been cancelled.</p>'), category: 'tour_cancelled' }));
  await send('tour_assigned', () => sendEmail({ to: email, toName: 'You', subject: tag('You have been assigned to a tour'), htmlContent: P('<p>You have been assigned to a new tour. See details in the app.</p>'), category: 'tour_assigned' }));
  await send('invoice_reminder', () => sendEmail({ to: email, toName: 'You', subject: tag('Invoice reminder — send by the 23rd'), htmlContent: P('<p>Reminder to send your invoice for this month by the 23rd.</p>'), category: 'invoice_reminder' }));
  await send('new_review', () => sendEmail({ to: email, toName: 'You', subject: tag('New 5⭐ review for you'), htmlContent: P('<p>You just got a new 5-star review!</p>'), category: 'new_review' }));
  await send('invoice_to_soren', () => sendEmail({ to: email, toName: 'You', subject: tag('Invoice from a guide'), htmlContent: P('<p>This is the email Søren receives when a guide submits an invoice (attachment omitted in test).</p>'), category: 'invoice_to_soren' }));

  console.log(`Sent test emails to ${email}:`);
  results.forEach(r => console.log(r));
  console.log('\nCheck that inbox — you should have one message per type above.');
  setTimeout(() => process.exit(0), 6000); // let SMTP flush
})();
