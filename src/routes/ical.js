const express = require('express');
const router = express.Router();
const { getDb, isNotifEnabled } = require('../db/schema');
const { sendEmail, EMAIL_FOOTER } = require('../email');
const { createNotification, resolveNotification } = require('./admin-notifs');
const { logTourChange } = require('../tour-change-log');
const { computeBufferedMinutes } = require('../tour-duration');
const { notifyFirstBooking } = require('../notify-first-booking');

function db() { return getDb(); }

const TOKEN = 'dbb7dbf5-fa2d-4096-9e8b-dfba97f25352';
const BASE = 'https://fareharbor.com/integrations/ics/becopenhagen/calendar';

const TOUR_FEEDS = [
  { id: 'L2P', itemId: '712177', label: 'Private History Tour (2h)',    type: 'tour' },
  { id: 'L3',  itemId: '707493', label: 'History Tour (3h)',            type: 'tour' },
  { id: 'L3P', itemId: '713560', label: 'Private History Tour (3h)',    type: 'tour' },
  { id: 'A3',  itemId: '709131', label: 'Architecture Tour (3h)',       type: 'tour' },
  { id: 'A3P', itemId: '713563', label: 'Private Architecture Tour (3h)',type: 'tour' },
  { id: 'F3',  itemId: '729348', label: 'Food Tour (3h)',               type: 'tour' },
  { id: 'F3P', itemId: '730640', label: 'Private Food Tour (3h)',       type: 'tour' },
  { id: 'H3',  itemId: '741878', label: 'History Tour New (3h)',        type: 'tour' },
  { id: 'CUSTOM', itemId: '650858', label: 'Custom Tour',               type: 'tour' },
  { id: '1-D', itemId: '190975', label: '1-Day Rental',                 type: 'rental' },
  { id: '2-D', itemId: '190977', label: '2-Day Rental',                 type: 'rental' },
  { id: '3-D', itemId: '190978', label: '3-Day Rental',                 type: 'rental' },
  { id: '4-D', itemId: '190980', label: '4-Day Rental',                 type: 'rental' },
  { id: '5-D',  itemId: '651114', label: '5-Day Rental',  type: 'rental' },
  { id: '6-D',  itemId: '651124', label: '6-Day Rental',  type: 'rental' },
  { id: '7-D',  itemId: '190983', label: '7-Day Rental',  type: 'rental' },
  { id: '8-D',  itemId: '651812', label: '8-Day Rental',  type: 'rental' },
  { id: '9-D',  itemId: '652669', label: '9-Day Rental',  type: 'rental' },
  { id: '10-D', itemId: '652693', label: '10-Day Rental', type: 'rental' },
  { id: '11-D', itemId: '652695', label: '11-Day Rental', type: 'rental' },
  { id: '12-D', itemId: '652697', label: '12-Day Rental', type: 'rental' },
  { id: '13-D', itemId: '652699', label: '13-Day Rental', type: 'rental' },
  { id: '14-D', itemId: '652703', label: '14-Day Rental', type: 'rental' },
];

// ── iCal parser ─────────────────────────────────────────────────────────
function parseIcal(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT').slice(1);

  blocks.forEach(block => {
    const get = (key) => {
      const m = block.match(new RegExp(`^${key}[^:]*:(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };

    const uid = get('UID') || '';
    const summary = get('SUMMARY') || '';
    const location = get('LOCATION') || '';
    const url = get('URL') || '';
    const dtstart = get('DTSTART') || '';
    const dtend = get('DTEND') || '';
    const descRaw = block.match(/^DESCRIPTION:(.+?)(?=\n[A-Z])/ms)?.[1] || '';
    const description = descRaw
      .replace(/\n[ \t]/g, '')  // unfold continuation lines
      .replace(/\\n/g, '\n')     // unescape literal \n to real newlines
      .trim();
    // Debug: log first booking block found
    //console.log('DESC sample:', description.substring(0, 200));

    if (!dtstart) return;

    // Parse dates (format: 20260622T080000Z)
    const parseDate = (s) => {
      if (!s) return null;
      const m = s.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      if (!m) return null;
      return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    };

    let start = parseDate(dtstart);
    let end = parseDate(dtend);
    if (!start) return;
    // FareHarbor iCal is UTC — Copenhagen is UTC+2 in summer (CEST)
    // We store times as local Copenhagen time strings directly
    const offsetMs = 2 * 60 * 60 * 1000;
    const localStart = new Date(start.getTime() + offsetMs);
    const localEnd = end ? new Date(end.getTime() + offsetMs) : null;

    // Extract guide from LOCATION field
    // Formats: "Crew 1 (Guide - Andrew)", "Hasse Sørensen (Guide)", "Federico Tortonese (Guide - Spanish tour)"
    //
    // "Crew N" is a generic placeholder account — when someone books under a
    // shared "Crew 1" login, the REAL guide's name goes in the trailing
    // "Guide - X" text instead. But when a guide is assigned under their own
    // real account (e.g. "Federico Tortonese"), that name IS the guide, and
    // any trailing "Guide - X" text is something else entirely — a language
    // tag, a note, anything — never another person's name. Always prefer the
    // real account name; only fall back to the trailing text for placeholder
    // accounts.
    // `guideConfident` is true only when the guide came from a real account
    // name (the reliable case). The trailing "Guide - X" text and the bare
    // location/placeholder fallbacks are guesses — v2 (crew unicode) is the
    // authority for those, so we mark them not-confident and let v2 own them.
    let guide = null;
    let guideConfident = false;
    if (location) {
      const prefixMatch = location.match(/^([^(]+)\s*\(Guide/i);
      const prefixName = prefixMatch ? prefixMatch[1].trim() : null;
      const isPlaceholder = prefixName && /^crew\s*\d*$/i.test(prefixName);

      if (prefixName && !isPlaceholder) {
        guide = prefixName;
        guideConfident = true;
      } else {
        const noteMatch = location.match(/Guide\s*[-–]\s*([^)]+)\)/i);
        if (noteMatch) guide = noteMatch[1].trim();
        else if (prefixName) guide = prefixName;
        else if (location.includes('Guide')) guide = location.replace(/\(.*?\)/g,'').trim();
      }
    }
    // Also check description for CREW line
    if (!guide) {
      const cm = description.match(/CREW:\s*\n([^\n]+)/i);
      if (cm) {
        const crew = cm[1].trim();
        const prefixMatch = crew.match(/^([^(]+)\s*\(Guide/i);
        const prefixName = prefixMatch ? prefixMatch[1].trim() : null;
        const isPlaceholder = prefixName && /^crew\s*\d*$/i.test(prefixName);

        if (prefixName && !isPlaceholder) {
          guide = prefixName;
          guideConfident = true;
        } else {
          const noteMatch = crew.match(/Guide\s*[-–]\s*([^)]+)\)/i);
          if (noteMatch) guide = noteMatch[1].trim();
          else if (prefixName) guide = prefixName;
        }
      }
    }

    // Parse bike counts from summary
    // "5 Adults incl. bike rentals, 2 Adults incl. e-bike rentals, 1 Child incl. bike rental"
    let bikesNeeded = { A: 0, E: 0, B: 0, AC: 0, AT: 0, GT: 0 };
    const summaryLower = summary.toLowerCase();
    const bikeMatches = summaryLower.matchAll(/(\d+)\s+adult[^,]*(e-bike|electric)[^,]*/gi);
    const regularMatches = summaryLower.matchAll(/(\d+)\s+adult[^,]*(?<!e-bike|electric)[^,]*incl\.[^,]*bike/gi);
    const childMatches = summaryLower.matchAll(/(\d+)\s+child[^,]*incl\.[^,]*bike/gi);

    for (const m of summaryLower.matchAll(/(\d+)\s+adult[^,]*incl[^,]*e-bike[^,]*/gi)) bikesNeeded.E += parseInt(m[1]);
    for (const m of summaryLower.matchAll(/(\d+)\s+adult[^,]*incl[^,]*bike[^,]*(?!e-bike)/gi)) {
      if (!m[0].includes('e-bike') && !m[0].includes('electric')) bikesNeeded.A += parseInt(m[1]);
    }
    for (const m of summaryLower.matchAll(/(\d+)\s+child[^,]*incl[^,]*bike/gi)) bikesNeeded.B += parseInt(m[1]);

    const totalBikesNeeded = Object.values(bikesNeeded).reduce((a,b)=>a+b,0);

    // Parse individual bookings from description
    const bookings = [];
    const bookingBlocks = description.split(/BOOKING #/);
    bookingBlocks.slice(1).forEach(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;

      const ref = lines[0]?.trim();
      if (!ref || !/^\d+$/.test(ref)) return;

      // Name: first non-empty line after ref that isn't a phone/email/total
      const name = lines.slice(1).find(l =>
        l && !l.startsWith('+') && !l.includes('@') &&
        !l.startsWith('Total') && !l.startsWith('Due') &&
        !l.startsWith('#') && !/^\d+\s+(Adult|Child|People)/i.test(l)
      ) || 'Unknown';

      // Phone: line starting with + followed by digits
      const phone = lines.find(l => /^\+[\d\s\-().]{6,}/.test(l)) || null;

      // Email: line with @ — skip relay addresses from GYG/TripAdvisor/Airbnb
      const emailRaw = lines.find(l =>
        l.includes('@') && !l.startsWith('+') &&
        !l.includes('reply.getyourguide') &&
        !l.includes('expmessaging.tripadvisor') &&
        !l.includes('airbnb') &&
        !l.includes('reply.')
      ) || null;

      // Total paid
      const totalLine = lines.find(l => l.startsWith('Total:'));
      const total = totalLine ? totalLine.replace('Total:', '').trim() : null;

      // Due amount
      const dueLine = lines.find(l => l.startsWith('Due:'));
      const due = dueLine ? dueLine.replace('Due:', '').trim() : null;
      const fullyPaid = due === 'DKK0.00' || due === null;

      // What they booked — lines with adult/child/people counts or bike descriptions
      const whatLines = lines.filter(l =>
        (/\d+\s+(Adult|Child|People)/i.test(l) && !l.startsWith('#')) ||
        (/\d+\s+(regular|ebike|e-bike|electric|SA|touring|cargo)/i.test(l))
      );
      const what = whatLines.join(', ') || null;

      // Passenger heights from #### Custom Fields
      const heightMatch = block.match(/Passenger Heights:\s*([^\n#\\]+)/);
      const heights = heightMatch ? heightMatch[1].trim() : null;

      // Comments (filter out empty/boilerplate)
      const commentMatch = block.match(/Comments:\s*\n([^#\\]+)/);
      const comments = commentMatch ?
        commentMatch[1].trim().replace(/\n/g,' ').trim() : null;
      const cleanComments = comments && comments.length > 3 ? comments : null;

      // Language preference
      const langMatch = block.match(/Language Option:\s*\n([^\n#\\]+)/);
      const language = langMatch ? langMatch[1].trim() : null;

      // Source: GYG, TripAdvisor, Viator, Airbnb, direct, etc
      const blockLower = block.toLowerCase();
      let source = 'direct';
      if (blockLower.includes('getyourguide')) source = 'GetYourGuide';
      else if (blockLower.includes('tripadvisor')) source = 'TripAdvisor';
      else if (blockLower.includes('viator')) source = 'Viator';
      else if (blockLower.includes('airbnb')) source = 'Airbnb';
      // Airbnb bookings have no email address in the iCal block
      else if (!emailRaw) source = 'Airbnb';

      bookings.push({
        ref, name, phone,
        email: emailRaw,
        total, due, fullyPaid,
        what, heights,
        comments: cleanComments,
        language,
        source,
      });
    });

    // Extract availability ID from UID
    const availId = uid.match(/availabilities\/(\d+)/)?.[1] || uid;

    events.push({
      uid: availId,
      summary: summary.replace(/\s*\(.*\)/, '').trim(),
      location,
      guide,
      guide_confident: guideConfident,
      start: localStart.toISOString(),
      end: localEnd ? localEnd.toISOString() : null,
      start_date: localStart.toISOString().substring(0,10),
      start_time: localStart.toISOString().substring(11,16),
      end_time: localEnd ? localEnd.toISOString().substring(11,16) : null,
      bikes_needed: bikesNeeded,
      total_bikes: totalBikesNeeded,
      bookings,
      booking_count: bookings.length,
      url,
      description,
      _rawBlock: block.substring(0, 4000), // cap size — full VEVENT text for forensic logging
    });
  });

  return events;
}

// ── DB sync ──────────────────────────────────────────────────────────────
function syncFeedToDB(feed, events) {
  const upsert = db().prepare(`
    INSERT INTO tour_availabilities
      (availability_id, feed_id, feed_label, feed_type, guide, start_at, end_at,
       start_date, start_time, end_time, summary, bikes_needed, total_bikes,
       booking_count, bookings_json, url, last_synced)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(availability_id) DO UPDATE SET
      -- Guide: iCal passes NULL unless its parse is confident, so COALESCE
      -- overwrites with a confident name but keeps v2's value otherwise.
      guide=COALESCE(excluded.guide, guide), start_at=excluded.start_at, end_at=excluded.end_at,
      start_date=excluded.start_date, start_time=excluded.start_time, end_time=excluded.end_time,
      -- iCal owns the non-GT bike categories (parsed from the summary text);
      -- v2 owns GT (from FareHarbor resources). Merge per-key instead of
      -- replacing the whole object, so the two sources stop erasing each
      -- other. GT is left untouched here; the combined total is existing GT
      -- plus iCal's non-GT count. Atomic (single statement) — no read/write
      -- race with the hourly v2 process.
      bikes_needed=CASE WHEN excluded.total_bikes > 0 THEN json_set(
          json(COALESCE(bikes_needed,'{}')),
          '$.A',  COALESCE(json_extract(excluded.bikes_needed,'$.A'),0),
          '$.E',  COALESCE(json_extract(excluded.bikes_needed,'$.E'),0),
          '$.B',  COALESCE(json_extract(excluded.bikes_needed,'$.B'),0),
          '$.AC', COALESCE(json_extract(excluded.bikes_needed,'$.AC'),0),
          '$.AT', COALESCE(json_extract(excluded.bikes_needed,'$.AT'),0)
        ) ELSE bikes_needed END,
      total_bikes=CASE WHEN excluded.total_bikes > 0
        THEN COALESCE(json_extract(bikes_needed,'$.GT'),0) + excluded.total_bikes
        ELSE total_bikes END,
      booking_count=excluded.booking_count, bookings_json=excluded.bookings_json,
      last_synced=excluded.last_synced, summary=excluded.summary
  `);

  events.forEach(e => {
    // Check previous state for notification triggers
    const prev = db().prepare('SELECT booking_count, guide, total_bikes, bookings_json FROM tour_availabilities WHERE availability_id=?').get(e.uid);
    const prevCount = prev?.booking_count ?? null;
    // Guide ownership: v2 (crew unicode) is authoritative. iCal only asserts a
    // guide when its own parse is confident (a real account name); otherwise it
    // leaves the stored guide untouched so v2 owns it. `icalGuide` is the value
    // iCal is willing to write (null when not confident); the upsert uses
    // COALESCE(excluded.guide, guide) so a confident parse overwrites (keeping
    // reassignments fast) while a non-confident/blank parse never clobbers v2.
    const icalGuide = e.guide_confident ? e.guide : null;
    const guide = icalGuide || prev?.guide; // effective guide after this sync

    // Freeze finished tours: once a tour's day has passed, its stored record is
    // immutable — iCal stops recomputing it (v2 already skips past days). This
    // is what stops a later formula change from silently rewriting old tours;
    // changing a past tour now requires a deliberate migration under
    // scripts/fixes/. A tour first seen only after it's over (no prev row) is
    // still snapshotted once, so nothing is lost.
    const todayStr = new Date().toISOString().substring(0, 10);
    const frozen = !!prev && e.start_date && e.start_date < todayStr;

    // The webhook sets booking.created_at when a booking first arrives, but
    // this 90-second iCal sync has no way to parse a creation date from the
    // iCal text (it's simply not present there) — so without this merge,
    // every sync cycle would silently wipe out the created_at the webhook
    // set, breaking any "booked before X" logic within ~90 seconds of every
    // booking. Carry forward created_at (and any other webhook-only field)
    // per booking ref from whatever was already stored.
    if (prev?.bookings_json) {
      try {
        const prevBookingsByRef = {};
        JSON.parse(prev.bookings_json).forEach(b => { if (b.ref) prevBookingsByRef[b.ref] = b; });
        e.bookings.forEach(b => {
          const old = prevBookingsByRef[b.ref];
          if (old?.created_at && !b.created_at) b.created_at = old.created_at;
        });
      } catch (err) { /* malformed prior JSON, skip merge */ }
    }

    if (!frozen) {
      logTourChange(db(), { availability_id: e.uid, feed_id: feed.id, start_date: e.start_date, field: 'guide', old_value: prev?.guide, new_value: guide, source: 'ical', raw_data: e._rawBlock });
      logTourChange(db(), { availability_id: e.uid, feed_id: feed.id, start_date: e.start_date, field: 'booking_count', old_value: prevCount, new_value: e.booking_count, source: 'ical', raw_data: e._rawBlock });
      if (e.total_bikes > 0) {
        logTourChange(db(), { availability_id: e.uid, feed_id: feed.id, start_date: e.start_date, field: 'total_bikes', old_value: prev?.total_bikes, new_value: e.total_bikes, source: 'ical', raw_data: e._rawBlock });
      }

      upsert.run(
        e.uid, feed.id, feed.label, feed.type,
        icalGuide, e.start, e.end,
        e.start_date, e.start_time, e.end_time,
        e.summary, JSON.stringify(e.bikes_needed), e.total_bikes,
        e.booking_count, JSON.stringify(e.bookings), e.url
      );
    }

    // Permanent bookings ledger — tour_availabilities/bookings_json is a
    // rolling cache (gets purged), so this is the only place we can answer
    // "how many bookings were made on day X" later. Never deleted.
    (e.bookings || []).forEach(b => {
      if (!b.ref) return;
      db().prepare(`
        INSERT INTO bookings (ref, availability_id, feed_id, feed_type, tour_start_date, customer_name, customer_email, customer_phone, source, total, booking_created_at, last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(ref) DO UPDATE SET
          availability_id=excluded.availability_id, tour_start_date=excluded.tour_start_date,
          customer_name=excluded.customer_name, source=excluded.source, total=excluded.total,
          last_seen_at=excluded.last_seen_at
      `).run(b.ref, e.uid, feed.id, feed.type, e.start_date, b.name || null, b.email || null, b.phone || null, b.source || null, b.total || null, b.created_at || null);
    });

    // Resolve unassigned_tour notifications if guide is now assigned
    // (distinct from a manual dismiss — this allows the alert to fire again
    // if the guide is later removed)
    if (feed.type === 'tour' && guide) {
      resolveNotification('unassigned_tour', e.uid);
      resolveNotification('unassigned_tour_urgent', e.uid + '-urgent');
    }

    // Notify admin if a tour in the next 14 days has no guide assigned
    if (feed.type === 'tour' && !guide && e.booking_count > 0 && e.start_date) {
      const todayStr14 = new Date().toISOString().substring(0, 10);
      const fourteenDaysStr = new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10);
      if (e.start_date > todayStr14 && e.start_date <= fourteenDaysStr) {
        createNotification(
          'unassigned_tour',
          `Unassigned tour: ${feed.id} on ${e.start_date}`,
          `${e.booking_count} booking${e.booking_count !== 1 ? 's' : ''} — no guide assigned yet.`,
          e.uid
        );
      }

      // Urgent reminder: still unassigned within 2 days of the tour.
      // Fires even if the original alert was dismissed — a dismissal means
      // "I know, not urgent yet", not "never tell me about this again".
      const twoDaysStr = new Date(Date.now() + 2 * 86400000).toISOString().substring(0, 10);
      if (e.start_date > todayStr14 && e.start_date <= twoDaysStr) {
        createNotification(
          'unassigned_tour_urgent',
          `Still unassigned — ${feed.id} on ${e.start_date} (soon!)`,
          `${e.booking_count} booking${e.booking_count !== 1 ? 's' : ''} — this tour is coming up and still has no guide.`,
          e.uid + '-urgent'
        );
      }
    }
    // First booking on this slot — fire once via the shared notifier. The
    // webhook covers everything that fires a webhook (direct/GYG/Viator); this
    // covers Airbnb, which never fires our webhook. The atomic claim inside
    // means the two never double-send. Handles the admin alert + guide email.
    if (feed.type === 'tour' && e.booking_count >= 1) {
      notifyFirstBooking(e.uid);
    } else if (feed.type === 'tour' && e.booking_count === 0) {
      // Slot emptied (all bookings cancelled) — re-arm so a future first
      // booking notifies again.
      db().prepare("UPDATE tour_availabilities SET first_booking_notified=0 WHERE availability_id=? AND first_booking_notified=1").run(e.uid);
    }

    if (feed.type !== 'tour' || !guide || !e.start_date || e.start_date < new Date().toISOString().substring(0, 10)) return;

    const allMembers = db().prepare('SELECT id, name, email FROM team_members WHERE active=1').all();
    const member = allMembers.find(m => guideMatches(guide, m.name));
    if (!member?.email) return;
    const memberId = member.id;

    const dateLabel = new Date(e.start_date).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

    // First-booking guide email is now sent by notifyFirstBooking (above),
    // shared with the webhook. Only the zero-bookings email remains here.

    // Last booking lost, slot still open
    if (prevCount >= 1 && e.booking_count === 0 && isNotifEnabled(member.id || memberId, 'zero_bookings')) {
      const subject = `No more bookings — ${e.feed_id} on ${dateLabel}`;
      const htmlContent = `
        <p>Hi ${member.name},</p>
        <p>All bookings have been cancelled or rebooked for your tour. The slot is still open and may get new bookings.</p>
        <table style="border-collapse:collapse;margin:0.5rem 0">
          <tr><td style="padding:3px 12px 3px 0;color:#888">Tour</td><td>${e.feed_label || e.feed_id}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLabel}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#888">Time</td><td>${e.start_time}${e.end_time ? ' – ' + e.end_time : ''}</td></tr>
        </table>
        ${EMAIL_FOOTER}`;
      sendEmail({ to: member.email, toName: member.name, subject, htmlContent, category: 'zero_bookings' })
        .catch(err => console.error('Email error (zero bookings):', err.message));
    }
  });

  // Remove old events for this feed that no longer exist.
  // A row can go missing from the feed for two reasons:
  //  1) It already happened and FareHarbor's feed rolled past it — keep it
  //     for a 1-day grace period so recently-completed tours don't vanish
  //     instantly from the app.
  //  2) It was rescheduled or cancelled — FareHarbor drops it from the feed
  //     immediately even though its start time is still in the future. This
  //     must be deleted right away, or a rescheduled booking leaves a stale
  //     "ghost" card on its old date/time forever.
  const currentIds = events.map(e => e.uid);
  if (currentIds.length > 0) {
    const placeholders = currentIds.map(() => '?').join(',');

    // Before deleting, email any guide assigned to a future slot being removed
    if (feed.type === 'tour') {
      const toDelete = db().prepare(`SELECT * FROM tour_availabilities
        WHERE feed_id=? AND availability_id NOT IN (${placeholders})
        AND booking_count > 0
        AND start_at > datetime('now')`).all(feed.id, ...currentIds);
      toDelete.forEach(row => {
        if (!row.guide) return;
        const allMembers = db().prepare('SELECT id, name, email FROM team_members WHERE active=1').all();
        const member = allMembers.find(m => guideMatches(row.guide, m.name));
        if (!member?.email) return;
        if (!isNotifEnabled(member.id, 'tour_cancelled')) return;
        const dateLabel = new Date(row.start_date).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
        const subject = `Tour cancelled — ${row.feed_id} on ${dateLabel}`;
        const htmlContent = `
          <p>Hi ${member.name},</p>
          <p>The following tour has been cancelled:</p>
          <table style="border-collapse:collapse;margin:0.5rem 0">
            <tr><td style="padding:3px 12px 3px 0;color:#888">Tour</td><td>${row.feed_label || row.feed_id}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLabel}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#888">Time</td><td>${row.start_time}${row.end_time ? ' – ' + row.end_time : ''}</td></tr>
          </table>
          ${EMAIL_FOOTER}`;
        sendEmail({ to: member.email, toName: member.name, subject, htmlContent, category: 'tour_cancelled' })
          .catch(err => console.error('Email error (slot cancelled):', err.message));
      });
    }

    db().prepare(`DELETE FROM tour_availabilities
      WHERE feed_id=?
      AND availability_id NOT IN (${placeholders})
      AND booking_count > 0
      AND (start_at > datetime('now') OR start_at < datetime('now', '-1 day'))`)
      .run(feed.id, ...currentIds);
  } else {
    // Feed returned zero events (e.g. temporary fetch hiccup) — don't wipe
    // everything; only clear out anything that's not a recently-completed
    // tour, same grace-period logic as above.
    db().prepare(`DELETE FROM tour_availabilities
      WHERE feed_id=?
      AND (start_at > datetime('now') OR start_at < datetime('now', '-1 day'))`)
      .run(feed.id);
  }

  // ── Guide worked-hours log ────────────────────────────────────────────
  // A separate, effectively permanent record of hours guides actually
  // worked. tour_availabilities is a rolling cache that gets purged once a
  // tour is a day old, so it can't answer "how many hours did I work last
  // month?" — this table can, because completed tours are never deleted
  // from it. Only tours with a guide assigned count.
  if (feed.type === 'tour') {
    const upsertHours = db().prepare(`
      INSERT INTO guide_tour_hours
        (availability_id, guide, feed_id, feed_label, start_at, end_at, start_date, duration_minutes, booking_count, last_synced)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(availability_id) DO UPDATE SET
        guide=excluded.guide, feed_id=excluded.feed_id, feed_label=excluded.feed_label,
        start_at=excluded.start_at, end_at=excluded.end_at, start_date=excluded.start_date,
        duration_minutes=excluded.duration_minutes, booking_count=excluded.booking_count, last_synced=excluded.last_synced
    `);
    const todayStrHours = new Date().toISOString().substring(0, 10);
    events.forEach(e => {
      // Only log hours off a confident iCal guide (a real account name).
      // Placeholder/fuzzy cases are left to v2, which resolves the real guide
      // via crew unicode and writes this row itself within the hour.
      const icalGuide = e.guide_confident ? e.guide : null;
      if (!icalGuide) return;
      // Freeze finished tours: once the day has passed, don't recompute an
      // existing hours row (that's what makes past pay immutable). A past tour
      // with no row yet is still snapshotted once.
      if (e.start_date && e.start_date < todayStrHours) {
        const existsGth = db().prepare('SELECT 1 FROM guide_tour_hours WHERE availability_id=?').get(e.uid);
        if (existsGth) return;
      }
      upsertHours.run(e.uid, icalGuide, feed.id, feed.label, e.start, e.end, e.start_date,
        computeBufferedMinutes(e.start, e.end, feed.id), e.booking_count);
    });

    // Same reschedule/cancel cleanup as above, but this table must NEVER
    // drop a row once its start time is in the past — those are completed
    // tours and are the whole point of keeping this table permanent.
    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      db().prepare(`DELETE FROM guide_tour_hours
        WHERE feed_id=? AND availability_id NOT IN (${placeholders}) AND start_at > datetime('now')`)
        .run(feed.id, ...currentIds);
    } else {
      db().prepare(`DELETE FROM guide_tour_hours WHERE feed_id=? AND start_at > datetime('now')`).run(feed.id);
    }
  }
}

// ── Fetch and sync all feeds ─────────────────────────────────────────────
async function ensureTable() {
  try {
    db().exec(`CREATE TABLE IF NOT EXISTS tour_availabilities (
      availability_id TEXT PRIMARY KEY,
      feed_id TEXT NOT NULL,
      feed_label TEXT,
      feed_type TEXT DEFAULT 'tour',
      guide TEXT,
      start_at TEXT,
      end_at TEXT,
      start_date TEXT,
      start_time TEXT,
      end_time TEXT,
      summary TEXT,
      bikes_needed TEXT DEFAULT '{}',
      total_bikes INTEGER DEFAULT 0,
      booking_count INTEGER DEFAULT 0,
      bookings_json TEXT DEFAULT '[]',
      url TEXT,
      last_synced TEXT
    )`);
  } catch(e) { console.error('Table creation error:', e.message); }
}

async function syncAllFeeds() {
  await ensureTable();
  console.log('Syncing iCal feeds...');
  let total = 0;
  for (const feed of TOUR_FEEDS) {
    try {
      const url = `${BASE}/${feed.itemId}/?token=${TOKEN}`;
      const res = await fetch(url);
      if (!res.ok) { console.error(`Feed ${feed.id} failed:`, res.status); continue; }
      const text = await res.text();
      const events = parseIcal(text);
      syncFeedToDB(feed, events);
      total += events.length;
    } catch(e) {
      console.error(`Feed ${feed.id} error:`, e.message);
    }
  }
  console.log(`iCal sync done: ${total} events across ${TOUR_FEEDS.length} feeds`);
}

// Start polling every 5 minutes
let syncTimer = null;
function startPolling() {
  // Delay first sync by 3 seconds to let DB fully initialise
  setTimeout(() => {
    syncAllFeeds().catch(e => console.error('Initial iCal sync failed:', e.message));
  }, 3000);
  syncTimer = setInterval(() => {
    syncAllFeeds().catch(e => console.error('iCal sync failed:', e.message));
  }, 90 * 1000);
}

// ── API endpoints ────────────────────────────────────────────────────────

const { guideMatches } = require('../guide-name-match');

// GET /api/ical/tours — upcoming tour availabilities
router.get('/tours', (req, res) => {
  const { guide, days } = req.query;
  const limit = parseInt(days) || 30;

  const sql = `SELECT * FROM tour_availabilities
    WHERE feed_type='tour'
    AND datetime(replace(replace(end_at,'T',' '),'Z','')) >= datetime('now', '-90 minutes')
    AND datetime(replace(replace(start_at,'T',' '),'Z','')) <= datetime('now', '+${limit} days')
    ORDER BY start_at`;

  let rows = db().prepare(sql).all();

  // Private tours (feed_id ending in 'P') are on-demand, not scheduled —
  // an availability with 0 bookings is just open capacity, not a real tour.
  // Group tours run on a fixed schedule regardless of bookings, so those
  // still show even at 0 bookings (guides need to know about them ahead of time).
  rows = rows.filter(r => !(r.feed_id?.endsWith('P') && r.booking_count === 0));

  // Fuzzy-filter by guide name in JS (handles accents/typos that SQL LIKE can't).
  // Unassigned tours (no guide set) are intentionally excluded here — they
  // should only be visible to admins (who call this endpoint without ?guide=),
  // not to individual guides, since an unclaimed tour isn't "theirs" yet.
  if (guide) {
    rows = rows.filter(r => r.guide && guideMatches(r.guide, guide));
  }

  const results = rows.map(r => ({
    ...r,
    bikes_needed: JSON.parse(r.bikes_needed || '{}'),
    bookings: JSON.parse(r.bookings_json || '[]'),
  }));

  // Fallback: for any booking with no created_at (mainly Airbnb, which
  // doesn't fire our webhook), use when we first spotted it via sync as an
  // approximation — usually within 90s of the real booking time.
  const missingRefs = [];
  results.forEach(t => t.bookings.forEach(b => { if (!b.created_at && b.ref) missingRefs.push(b.ref); }));
  if (missingRefs.length > 0) {
    const placeholders = missingRefs.map(() => '?').join(',');
    const seenRows = db().prepare(`SELECT ref, first_seen_at FROM bookings WHERE ref IN (${placeholders})`).all(...missingRefs);
    const seenByRef = Object.fromEntries(seenRows.map(r => [r.ref, r.first_seen_at]));
    results.forEach(t => t.bookings.forEach(b => {
      if (!b.created_at && seenByRef[b.ref]) {
        b.first_seen_at = seenByRef[b.ref];
      }
    }));
  }

  res.json(results);
});

// GET /api/ical/rentals — upcoming rental bookings
// Rentals picked up at 09:30. Shop closes at 16:30 CEST (14:30 UTC).
// After 14:30 UTC, today's rentals are done — show from tomorrow only.
router.get('/rentals', (req, res) => {
  const cutoffHourUTC = 14;
  const cutoffMinUTC = 30;
  const now = new Date();
  const pastShopClose = now.getUTCHours() > cutoffHourUTC ||
    (now.getUTCHours() === cutoffHourUTC && now.getUTCMinutes() >= cutoffMinUTC);

  const startFilter = pastShopClose
    ? `date('now', '+1 day')`
    : `date('now')`;

  const rows = db().prepare(`
    SELECT * FROM tour_availabilities
    WHERE feed_type='rental' AND start_date >= ${startFilter}
    ORDER BY start_at LIMIT 50
  `).all();
  res.json(rows.map(r => ({
    ...r,
    bikes_needed: JSON.parse(r.bikes_needed || '{}'),
    bookings: JSON.parse(r.bookings_json || '[]'),
  })));
});

// GET /api/ical/guide-hours — worked (in a date range) or upcoming hours for a guide.
// "Worked" only counts tours that have already started, so a reschedule can't
// retroactively inflate a past period. Duration is tour length + a prep buffer
// (15 before/after normally, 30 before/after for the Food Tour), computed
// once at sync time in computeBufferedMinutes.
router.get('/guide-hours', (req, res) => {
  const { guide, from, to, upcoming } = req.query;
  if (!guide) return res.status(400).json({ error: 'guide required' });

  let rows;
  if (upcoming === '1' || upcoming === 'true') {
    rows = db().prepare(`SELECT * FROM guide_tour_hours WHERE start_at > datetime('now') ORDER BY start_at`).all();
  } else {
    const fromDate = from || '1970-01-01';
    const toDate = to || '2999-12-31';
    rows = db().prepare(`
      SELECT * FROM guide_tour_hours
      WHERE start_at <= datetime('now') AND start_date >= ? AND start_date <= ?
      ORDER BY start_at
    `).all(fromDate, toDate);
  }

  rows = rows.filter(r => guideMatches(r.guide, guide));
  const total_minutes = rows.reduce((s, r) => s + (r.duration_minutes || 0), 0);

  // booking_count is stored directly on guide_tour_hours at sync time —
  // tour_availabilities is a rolling cache that gets purged, so we can't
  // rely on it still having a row for older tours
  const total_bookings = rows.reduce((s, r) => s + (r.booking_count || 0), 0);

  res.json({
    total_minutes,
    total_hours: Math.round((total_minutes / 60) * 10) / 10,
    count: rows.length,
    total_bookings,
    tours: rows.map(r => ({
      availability_id: r.availability_id,
      feed_id: r.feed_id,
      feed_label: r.feed_label,
      start_date: r.start_date,
      start_at: r.start_at,
      end_at: r.end_at,
      duration_minutes: r.duration_minutes,
    })),
  });
});

// GET /api/ical/debug — inspect raw stored data
router.get('/debug', (req, res) => {
  try {
    const rows = db().prepare('SELECT availability_id, feed_id, booking_count, bookings_json, substr(bookings_json,1,500) as preview FROM tour_availabilities LIMIT 3').all();
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

// POST /api/ical/sync — manual sync trigger
router.post('/sync', async (req, res) => {
  res.json({ ok: true, message: 'Sync started' });
  await syncAllFeeds();
});

// GET /api/ical/bookings-history — query the permanent bookings ledger.
// ?date=YYYY-MM-DD — bookings CREATED on that exact date
// ?days_ago=22 — bookings created exactly N days ago
// ?from=YYYY-MM-DD&to=YYYY-MM-DD — bookings created in a range
// No params — most recent 200 bookings
router.get('/bookings-history', (req, res) => {
  if (req.session?.actor_role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const { date, days_ago, from, to } = req.query;

  let rows;
  if (days_ago !== undefined) {
    const target = new Date(Date.now() - parseInt(days_ago, 10) * 86400000).toISOString().substring(0, 10);
    rows = db().prepare(`SELECT * FROM bookings WHERE date(booking_created_at) = ? ORDER BY booking_created_at`).all(target);
  } else if (date) {
    rows = db().prepare(`SELECT * FROM bookings WHERE date(booking_created_at) = ? ORDER BY booking_created_at`).all(date);
  } else if (from && to) {
    rows = db().prepare(`SELECT * FROM bookings WHERE date(booking_created_at) BETWEEN ? AND ? ORDER BY booking_created_at`).all(from, to);
  } else {
    rows = db().prepare(`SELECT * FROM bookings ORDER BY booking_created_at DESC LIMIT 200`).all();
  }

  res.json({ count: rows.length, bookings: rows });
});

module.exports = { router, startPolling };
