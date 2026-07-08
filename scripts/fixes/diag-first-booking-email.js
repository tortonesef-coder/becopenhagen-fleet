#!/usr/bin/env node
// DIAGNOSTIC ONLY — read-only, writes nothing.
// Traces the full history of one booking to explain why its first-booking
// email/alert did or didn't fire.
//
//   node scripts/fixes/diag-first-booking-email.js [bookingRef]
// defaults to the L3 9 Jul booking that missed its email.

const { getDb } = require('../../src/db/schema');
const db = getDb();
const REF = process.argv[2] || '361195224';

const line = (s) => console.log(s);
const j = (v) => { try { return JSON.stringify(JSON.parse(v)); } catch { return v; } };

line(`\n===== Booking #${REF} =====\n`);

// 1) The tour_availabilities row this booking belongs to
const ta = db.prepare(`SELECT * FROM tour_availabilities WHERE bookings_json LIKE ?`).get(`%${REF}%`);
if (!ta) {
  line('No tour_availabilities row currently contains this ref (may have been purged if past). Searching bookings ledger + logs only.');
} else {
  line('TOUR (tour_availabilities):');
  line(`  avail=${ta.availability_id}  ${ta.feed_id}  ${ta.start_date} ${ta.start_time}`);
  line(`  guide (stored now): ${ta.guide || '(none)'}`);
  line(`  booking_count (stored now): ${ta.booking_count}`);
  const bk = (() => { try { return JSON.parse(ta.bookings_json).find(b => String(b.ref) === REF); } catch { return null; } })();
  line(`  this booking in bookings_json: ${bk ? JSON.stringify(bk) : '(not found)'}`);
}

// 2) Did the webhook fire? (raw webhook_log + action_log)
line('\nWEBHOOK / booking events:');
const wl = db.prepare(`SELECT id, event_type, created_at, substr(raw_body,1,120) AS head FROM webhook_log WHERE raw_body LIKE ? ORDER BY created_at`).all(`%${REF}%`);
if (wl.length === 0) line('  webhook_log: NO raw webhook ever received mentioning this ref  <-- webhook likely never fired for it');
else wl.forEach(w => line(`  webhook_log #${w.id}  ${w.created_at}  type=${w.event_type}`));
const al = db.prepare(`SELECT action, created_at, details FROM action_log WHERE booking_ref=? ORDER BY created_at`).all(REF);
if (al.length === 0) line('  action_log: no booking_received/cancelled entries for this ref');
else al.forEach(a => { let d={}; try{d=JSON.parse(a.details||'{}')}catch{}; line(`  action_log  ${a.created_at}  ${a.action}  created_at=${d.created_at||'?'}`); });

// 3) How did booking_count / guide change over time? (tour_change_log)
if (ta) {
  line('\nCHANGE LOG for this availability (what iCal/v2 actually saw change):');
  const cl = db.prepare(`SELECT field, old_value, new_value, source, created_at FROM tour_change_log WHERE availability_id=? ORDER BY created_at`).all(String(ta.availability_id));
  if (cl.length === 0) line('  (no logged changes — note: the webhook does NOT write to tour_change_log, so a webhook-driven count bump leaves no entry here)');
  else cl.forEach(c => line(`  ${c.created_at}  [${c.source}] ${c.field}: ${c.old_value} -> ${c.new_value}`));
}

// 4) Was any email attempted? (emails_sent)
line('\nEMAILS SENT (first_booking category, most recent 15):');
const es = db.prepare(`SELECT sent_at, to_email, to_name, subject, category, ok, error FROM emails_sent WHERE category='first_booking' ORDER BY sent_at DESC LIMIT 15`).all();
if (es.length === 0) line('  NONE — no first_booking email has ever been logged as sent  <-- trigger never called sendEmail');
else es.forEach(e => line(`  ${e.sent_at}  ${e.category}  -> ${e.to_name} <${e.to_email}>  ok=${e.ok}${e.error?'  ERR='+e.error:''}`));

// 5) Guide + notification preference
line('\nGUIDE + notification preference:');
const g = (ta && ta.guide) ? ta.guide : 'Feidhlim';
const members = db.prepare(`SELECT id, name, email, active FROM team_members`).all();
const norm = (s) => (s||'').toLowerCase().replace(/[^a-z]/g,'');
const member = members.find(m => norm(m.name).includes('feidhlim') || norm(m.name).includes('feidhelm') || norm(m.name)===norm(g));
if (!member) line('  Could not find a team member matching the guide.');
else {
  line(`  member: ${member.name}  id=${member.id}  email=${member.email || '(NO EMAIL)'}  active=${member.active}`);
  const pref = db.prepare(`SELECT enabled FROM notification_prefs WHERE member_id=? AND notification_type='first_booking'`).get(member.id);
  line(`  first_booking pref: ${pref === undefined ? 'default (ON)' : (pref.enabled ? 'ON' : 'OFF')}`);
}

line('\n===== interpretation guide =====');
line('  - webhook fired + NO first_booking email + no iCal 0->1 count change logged');
line('      => the webhook bumped booking_count to 1 before the 90s iCal sync,');
line('         so iCal never saw the 0->1 transition and skipped the email/alert.');
line('  - email present with ok=0 => SMTP/delivery problem, not a trigger problem.');
line('  - pref OFF or NO EMAIL on member => that is the cause instead.');
line('');
