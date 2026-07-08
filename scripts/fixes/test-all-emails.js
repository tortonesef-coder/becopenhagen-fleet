#!/usr/bin/env node
// Sends one of EVERY email notification type to the address you pass, and ONLY
// that address. Each sample carries the same detail guides really receive
// (tour name, date, time, guest list, review text). No guide is ever emailed.
//
//   node scripts/fixes/test-all-emails.js you@example.com
//
// The first-booking email uses the real production code path (test mode); the
// rest mirror the real templates, filled with a real upcoming tour's data.

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

// Pull a real upcoming tour so the samples look like the genuine article.
const today = new Date().toISOString().substring(0, 10);
const members = db.prepare("SELECT id,name,email FROM team_members WHERE active=1 AND email IS NOT NULL").all();
const tours = db.prepare("SELECT * FROM tour_availabilities WHERE feed_type='tour' AND guide IS NOT NULL AND start_date >= ? ORDER BY start_date").all(today);
const sampleTour = tours.find(r => members.some(m => guideMatches(r.guide, m.name))) || tours[0] || {
  feed_id: 'L3', feed_label: 'History Tour (3h)', start_date: today, start_time: '10:30', end_time: '13:30', booking_count: 2,
  bookings_json: '[{"name":"Kris Pathuis","what":"2 Adults incl. bikes for the tour"}]', bikes_needed: '{"A":2}', availability_id: null,
};
const dateLong = new Date(sampleTour.start_date).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
const timeStr = `${sampleTour.start_time || ''}${sampleTour.end_time ? ' – ' + sampleTour.end_time : ''}`;
const bookings = (() => { try { return JSON.parse(sampleTour.bookings_json || '[]'); } catch { return []; } })();
const bikes = (() => { try { return Object.entries(JSON.parse(sampleTour.bikes_needed || '{}')).filter(([,n])=>n>0).map(([t,n])=>`${n}× ${t}`).join(', ') || 'None'; } catch { return 'None'; } })();
const tourRow = (label, val) => `<tr><td style="padding:3px 12px 3px 0;color:#888">${label}</td><td>${val}</td></tr>`;
const tourTable = (extra='') => `<table style="border-collapse:collapse;margin:0.5rem 0">
  ${tourRow('Tour', sampleTour.feed_label || sampleTour.feed_id)}
  ${tourRow('Date', dateLong)}
  ${tourRow('Time', timeStr)}${extra}</table>`;
const wrap = (name, body) => `<p>Hi ${name} (test copy — sent only to you),</p>${body}${EMAIL_FOOTER}`;
const T = (s) => `[TEST] ${s}`;

(async () => {
  const results = [];
  const send = async (label, fn) => {
    try { const r = await fn(); if (r === false) throw new Error('notifier returned false'); results.push(`  \u2713 ${label}`); }
    catch (e) { results.push(`  \u2717 ${label} — ${e.message}`); }
  };

  await send('verification_code', () => sendVerificationCodeEmail(email, 'You', '123456'));
  await send('password_reset', () => sendPasswordResetEmail(email, 'You', 'https://app.becopenhagen.dk/reset?token=TEST'));

  // first_booking — REAL production template via test mode
  if (sampleTour.availability_id) {
    await send(`first_booking (real template, ${sampleTour.feed_id} ${sampleTour.start_date})`,
      () => notifyFirstBooking(String(sampleTour.availability_id), { testEmailTo: email }));
  } else {
    await send('first_booking (sample)', () => sendEmail({ to: email, toName: 'You', subject: T(`First booking — ${sampleTour.feed_id} on ${dateLong}`),
      htmlContent: wrap('You', `<p>Your first booking just came in for:</p>${tourTable(tourRow('Bookings', sampleTour.booking_count))}`), category: 'first_booking' }));
  }

  await send('zero_bookings', () => sendEmail({ to: email, toName: 'You', subject: T(`No more bookings — ${sampleTour.feed_id} on ${dateLong}`),
    htmlContent: wrap('You', `<p>All bookings have been cancelled or rebooked for your tour. The slot is still open and may get new bookings.</p>${tourTable()}`), category: 'zero_bookings' }));

  const guestList = bookings.length ? `<p style="font-weight:600;margin:0.75rem 0 0.25rem">Guest list:</p><table style="border-collapse:collapse">${bookings.map(b=>`<tr><td style="padding:4px 12px 4px 0;font-weight:600">${b.name||'Unknown'}</td><td style="padding:4px 0;color:#555">${b.what||''}</td></tr>`).join('')}</table>` : '';
  await send('tour_reminder', () => sendEmail({ to: email, toName: 'You', subject: T(`Reminder — ${sampleTour.feed_id} tomorrow at ${sampleTour.start_time}`),
    htmlContent: wrap('You', `<p>Reminder — you have a tour tomorrow:</p>${tourTable(tourRow('Bookings', bookings.length) + tourRow('Bikes needed', bikes))}${guestList}`), category: 'tour_reminder' }));

  await send('tour_cancelled', () => sendEmail({ to: email, toName: 'You', subject: T(`Tour cancelled — ${sampleTour.feed_id} on ${dateLong}`),
    htmlContent: wrap('You', `<p>The following tour has been cancelled:</p>${tourTable()}`), category: 'tour_cancelled' }));

  const assignRow = `<tr><td style="padding:7px 14px 7px 0;color:#888">${new Date(sampleTour.start_date).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})}</td><td style="padding:7px 14px 7px 0;font-weight:700">${sampleTour.feed_id}</td><td style="padding:7px 14px 7px 0">${timeStr}</td><td style="padding:7px 14px 7px 0;color:#888">${sampleTour.booking_count} booking(s)</td><td style="padding:7px 0"><span style="font-size:0.7rem;font-weight:600;color:#2E7D32;background:#E8F5E9;padding:2px 8px;border-radius:10px">new</span></td></tr>`;
  await send('tour_assigned', () => sendEmail({ to: email, toName: 'You', subject: T(`Tour assigned — ${sampleTour.feed_id} on ${new Date(sampleTour.start_date).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}`),
    htmlContent: wrap('You', `<p>You've been assigned to a new tour:</p><table style="border-collapse:collapse;margin:0.75rem 0">${assignRow}</table><p>You can see all your upcoming tours in the app.</p>`), category: 'tour_assigned' }));

  await send('invoice_reminder', () => sendEmail({ to: email, toName: 'You', subject: T('Invoice reminder — send by the 23rd'),
    htmlContent: wrap('You', `<p>Just a reminder to send your invoice for <strong>this month</strong> by the <strong>23rd</strong>. Upload it in the app under <strong>Profile → Upload invoice</strong>; your worked hours are shown there too.</p>`), category: 'invoice_reminder' }));

  const reviewText = 'Absolutely brilliant tour! Our guide was knowledgeable, funny, and showed us parts of Copenhagen we never would have found. The bikes were great and the pace was perfect. Highlight of our trip!';
  await send('new_review', () => sendEmail({ to: email, toName: 'You', subject: T('New 5⭐ review for you — GetYourGuide'),
    htmlContent: wrap('You', `<p>You just got a new <strong>5-star review</strong>! Here are the details:</p>
      <table style="border-collapse:collapse;margin:0.5rem 0">${tourRow('Date', dateLong)}${tourRow('Platform','GetYourGuide')}${tourRow('Type', sampleTour.feed_id)}${tourRow('Reviewer','Sarah M.')}</table>
      <blockquote style="border-left:3px solid #e0e0e0;margin:0.75rem 0;padding:0.5rem 1rem;color:#555;font-style:italic">${reviewText}</blockquote>
      <p>You can see all your reviews in the app under <strong>Profile</strong>.</p>`), category: 'new_review' }));

  await send('invoice_to_soren', () => sendEmail({ to: email, toName: 'You', subject: T('Invoice from a guide — June 2026'),
    htmlContent: wrap('Søren', `<p>Please find attached the invoice from <strong>a guide</strong> — June 2026. <em>(In production the PDF is attached; omitted in this test.)</em></p>`), category: 'invoice_to_soren' }));

  console.log(`Sample tour used: ${sampleTour.feed_id} ${sampleTour.start_date} ${timeStr} (guide ${sampleTour.guide || 'n/a'})`);
  console.log(`Sent test emails to ${email}:`);
  results.forEach(r => console.log(r));
  console.log('\nCheck that inbox — one message per type, each with real detail.');
  setTimeout(() => process.exit(0), 6000);
})();
