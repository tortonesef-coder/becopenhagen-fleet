const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

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
    const description = descRaw.replace(/\\n/g, '\n').replace(/\n\s/g, '').trim();

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
    const offsetMs = 2 * 60 * 60 * 1000;
    start = new Date(start.getTime() + offsetMs);
    if (end) end = new Date(end.getTime() + offsetMs);

    // Extract guide from LOCATION field
    // Formats: "Crew 1 (Guide - Andrew)", "Hasse Sørensen (Guide)", ""
    let guide = null;
    if (location) {
      const m1 = location.match(/Guide\s*[-–]\s*([^)]+)\)/i);
      const m2 = location.match(/^([^(]+)\s*\(Guide\)/i);
      if (m1) guide = m1[1].trim();
      else if (m2) guide = m2[1].trim();
      else if (location.includes('Guide')) guide = location.replace(/\(.*?\)/g,'').trim();
    }
    // Also check description for CREW line
    if (!guide) {
      const cm = description.match(/CREW:\s*\n([^\n]+)/i);
      if (cm) {
        const crew = cm[1].trim();
        const m1 = crew.match(/Guide\s*[-–]\s*([^)]+)\)/i);
        const m2 = crew.match(/^([^(]+)\s*\(Guide\)/i);
        if (m1) guide = m1[1].trim();
        else if (m2) guide = m2[1].trim();
      }
    }

    // Parse bike counts from summary
    // "5 Adults incl. bike rentals, 2 Adults incl. e-bike rentals, 1 Child incl. bike rental"
    let bikesNeeded = { A: 0, E: 0, B: 0, AC: 0, AT: 0 };
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
    bookingBlocks.slice(1).forEach(b => {
      const lines = b.split('\n').map(l=>l.trim()).filter(Boolean);
      const ref = lines[0]?.trim();
      if (!ref || !/^\d+$/.test(ref)) return;

      // Name is first non-empty line after ref
      const name = lines[1]?.trim() || 'Unknown';

      // Phone: line starting with +
      const phone = lines.find(l => /^\+\d/.test(l)) || null;

      // Email: line with @, skip getyourguide/tripadvisor relay addresses
      const emailRaw = lines.find(l => l.includes('@') && !l.startsWith('+'));
      const email = emailRaw && !emailRaw.includes('reply.getyourguide') && !emailRaw.includes('expmessaging') ? emailRaw : null;

      // What they booked: line with "Adult" or "Child" quantities
      const whatLine = lines.find(l => /\d+\s+(Adult|Child)/i.test(l) && !l.startsWith('#'));

      // Custom fields: heights, comments
      const heights = description.match(/Passenger Heights:\s*([^\n#]+)/)?.[1]?.trim() || null;
      const comments = b.match(/Comments:\s*\n([^\n#]+)/)?.[1]?.trim() || null;

      bookings.push({ ref, name, phone, email, what: whatLine || null, heights, comments });
    });

    // Extract availability ID from UID
    const availId = uid.match(/availabilities\/(\d+)/)?.[1] || uid;

    events.push({
      uid: availId,
      summary: summary.replace(/\s*\(.*\)/, '').trim(),
      location,
      guide,
      start: start.toISOString(),
      end: end.toISOString(),
      start_date: start.toISOString().substring(0,10),
      start_time: start.toISOString().substring(11,16),
      end_time: end.toISOString().substring(11,16),
      bikes_needed: bikesNeeded,
      total_bikes: totalBikesNeeded,
      bookings,
      booking_count: bookings.length,
      url,
      description,
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
      guide=excluded.guide, bikes_needed=excluded.bikes_needed,
      total_bikes=excluded.total_bikes, booking_count=excluded.booking_count,
      bookings_json=excluded.bookings_json, last_synced=excluded.last_synced,
      summary=excluded.summary
  `);

  events.forEach(e => {
    upsert.run(
      e.uid, feed.id, feed.label, feed.type,
      e.guide, e.start, e.end,
      e.start_date, e.start_time, e.end_time,
      e.summary, JSON.stringify(e.bikes_needed), e.total_bikes,
      e.booking_count, JSON.stringify(e.bookings), e.url
    );
  });

  // Remove old events for this feed that no longer exist
  const currentIds = events.map(e => e.uid);
  if (currentIds.length > 0) {
    const placeholders = currentIds.map(() => '?').join(',');
    db().prepare(`DELETE FROM tour_availabilities WHERE feed_id=? AND start_at < datetime('now', '-1 day') AND availability_id NOT IN (${placeholders})`)
      .run(feed.id, ...currentIds);
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
  }, 5 * 60 * 1000);
}

// ── API endpoints ────────────────────────────────────────────────────────

// GET /api/ical/tours — upcoming tour availabilities
router.get('/tours', (req, res) => {
  const { guide, days } = req.query;
  const limit = parseInt(days) || 30;

  let sql = `SELECT * FROM tour_availabilities
    WHERE feed_type='tour' AND start_at >= datetime('now', '-1 hour')
    AND start_at <= datetime('now', '+${limit} days')`;
  const params = [];
  if (guide) { sql += ` AND (guide LIKE ? OR guide IS NULL)`; params.push(`%${guide}%`); }
  sql += ' ORDER BY start_at';

  const rows = db().prepare(sql).all(...params);
  res.json(rows.map(r => ({
    ...r,
    bikes_needed: JSON.parse(r.bikes_needed || '{}'),
    bookings: JSON.parse(r.bookings_json || '[]'),
  })));
});

// GET /api/ical/rentals — upcoming rental bookings
router.get('/rentals', (req, res) => {
  const rows = db().prepare(`
    SELECT * FROM tour_availabilities
    WHERE feed_type='rental' AND start_at >= datetime('now', '-1 hour')
    ORDER BY start_at LIMIT 50
  `).all();
  res.json(rows.map(r => ({
    ...r,
    bikes_needed: JSON.parse(r.bikes_needed || '{}'),
    bookings: JSON.parse(r.bookings_json || '[]'),
  })));
});

// POST /api/ical/sync — manual sync trigger
router.post('/sync', async (req, res) => {
  res.json({ ok: true, message: 'Sync started' });
  await syncAllFeeds();
});

module.exports = { router, startPolling };
