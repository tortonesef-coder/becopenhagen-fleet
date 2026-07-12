// src/routes/brain.js
//
// The data brain: natural-language questions against the analytics DB, plus
// weekly CSV upload to refresh it.
//
// Claude never sees the whole dataset — only the schema, and the rows its own
// SQL query returns. Queries are hard-restricted to read-only SELECT.

const express = require('express');
const router = express.Router();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const BRAIN_DIR = path.join(__dirname, '../../scripts/brain');
const DB_PATH = path.join(BRAIN_DIR, 'analytics.db');
// The live fleet DB — attached READ-ONLY. The brain must never write to it.
const FLEET_DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fleet.db');
const UPLOAD_DIR = path.join(BRAIN_DIR, 'uploads');
const API_KEY =
  process.env.ANTHROPIC_API_KEY_REPORTS || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BRAIN_MODEL || 'claude-sonnet-5';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Schema description Claude reasons against. Keep in sync with scripts/brain/load.py
// ---------------------------------------------------------------------------
const SCHEMA = `
DATABASE: BeCopenhagen analytics (SQLite). Copenhagen bike tour + rental company.
Currency DKK. Data from Dec 2022 to present.

TABLE bookings  -- one row per booking
  booking_id, order_id
  cancelled          INT 0/1
  cancelled_at       DATE, cancelled_by TEXT
  cancel_days_before_tour INT  tour_date - cancelled_at (negative = after tour)
  item               TEXT product code. Group tours: A3 (architecture), L3
                          (liveability), F3 (food), H3 (history), L2
                          (DISCONTINUED 2026). Private: A3P/L3P/F3P. CUSTOM =
                          bespoke groups. Legacy names: ESS, ARCH, ARCH +lunch,
                          NV, LIGHT, Nordhavn, WCA — older products, some
                          archived. Rentals: '1-D'..'14-D' = N-day bike rental.
  item_category      TEXT 'tour_group'|'tour_private'|'rental'|'gift_card'
  rental_days        INT  N for an N-D rental
  booked_at          DATE when the SALE was made
  booked_time TEXT, booked_dow TEXT (day name), booked_hour INT
  tour_date          DATE when the TOUR RUNS (rentals: pickup date)
  tour_time TEXT, tour_dow TEXT (day name), tour_hour INT
  availability_id    TEXT the departure slot
  lead_days          INT  tour_date - booked_at (booking lead time)
  pax                INT  number of people
  language           TEXT e.g. 'English (UK)', 'German', 'Danish'
  country            TEXT ISO code from phone, e.g. 'US','DE','DK'
  created_by         TEXT 'Online' | 'Shop' | staff name | '<x>-api'
  paid_status        TEXT 'paid'|'unpaid'|'underpaid'|'overpaid'
  channel            TEXT 'Direct/Website'|'GetYourGuide'|'Viator'|
                          'Musement/TUI'|'Airbnb'|'Google'|'FHDN'|
                          'Shop/Walk-in'|'Staff (name)'
  commission_rate    REAL what we pay that channel (GYG 0.30, most OTAs 0.20,
                          direct 0.0). True net = total * (1 - commission_rate).
  channel_type       TEXT 'OTA'|'Direct'
  subtotal, tax, total, total_paid, net_revenue, processing_fees,
  paid_to_affiliate, amount_due  REAL (DKK)
  revenue_per_pax    REAL

TABLE sales  -- one row per payment or refund event
  txn_id, booking_id (join to bookings.booking_id)
  item, kind ('Payment'|'Refund')
  created_at DATE, created_dow TEXT
  payment_type TEXT, card_type TEXT, created_by TEXT
  gross, processing_fee, net, refund_gross, tax_paid, subtotal_paid REAL
  payout_date DATE

TABLE fleet.tour_availabilities  -- EVERY departure slot offered, sold or not
  availability_id  TEXT  join to bookings.availability_id
  feed_id, feed_label TEXT  product (feed_label is the code, e.g. 'A3','L3')
  feed_type        TEXT  'tour' | 'rental'
  guide            TEXT  guide assigned to this departure
  start_date TEXT ('YYYY-MM-DD'), start_time TEXT ('HH:MM')
  end_time TEXT, summary TEXT
  booking_count    INT   bookings on this departure (0 = it ran EMPTY / unsold)
  total_bikes      INT   bikes required
  This is the ONLY source for departures that sold ZERO bookings, so it is
  what makes occupancy, fill-rate and "which slots run empty" answerable.
  Occupancy must be computed as booked vs offered across these rows.

TABLE fleet.guide_tour_hours  -- per-departure guide hours
  availability_id TEXT, guide TEXT, feed_id, feed_label TEXT
  start_date TEXT, duration_minutes INT, booking_count INT

TABLE fleet.guide_reviews  -- 5-star reviews logged per guide
  guide_id TEXT, review_date TEXT, reviewer_name TEXT, platform TEXT,
  booking_type TEXT, review_text TEXT

CRITICAL GUIDANCE
- "Do people BOOK on X" -> booked_dow (sale date). "Are X tours BUSY" ->
  tour_dow (delivery date). Different questions! If ambiguous, answer both.
- OCCUPANCY / EMPTY SLOTS: you MUST use fleet.tour_availabilities. The
  bookings table only contains departures that SOLD, so counting bookings
  alone silently ignores every empty departure and overstates demand.
- GUIDES: guide info is in fleet.tour_availabilities.guide and
  fleet.guide_tour_hours — not in the bookings table.
- IMPORTANT: the fleet.* tables only go back a few months (the fleet app is
  newer than the booking history). Bookings/sales cover 2023->now, but
  occupancy and guide data DO NOT. Never present a long-run trend from
  fleet.* tables; state the limitation instead.
- Cancellations are rare (~0.6%). Per-channel/product cancel rates rest on
  tiny samples — report raw counts and say when a number is too small to
  trust rather than presenting a dramatic percentage as fact.
- Product lineup changed over time (L2 discontinued, H3/F3 newer, legacy
  names archived). Be careful with per-product year-over-year.
- Rentals ('N-D') are bikes, not tours. Exclude from tour analysis unless
  asked.
- bookings.total = booking value. Use the sales table for actual cash
  movements including refunds.
`;

const SYSTEM = `You are the data analyst for BeCopenhagen, a Copenhagen bike tour
and rental company. You answer Federico's questions by querying a SQLite database.

${SCHEMA}

Process:
1. Work out what's really being asked (mind the booked_dow vs tour_dow trap).
2. Emit exactly ONE SQLite SELECT query inside <sql></sql> tags. Read-only.
3. You'll get the rows back, then explain the answer.

If a question needs no query (e.g. "what can you tell me about?"), just answer.

Style: direct, concrete, lead with the answer. Cite real numbers. Flag caveats
that genuinely matter (small sample, discontinued product, data gap) but don't
pad with disclaimers. Money in DKK. If the data can't answer it, say so plainly.`;

// ---------------------------------------------------------------------------

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    const e = new Error('No analytics database yet — upload your CSV exports first.');
    e.code = 'NO_DB';
    throw e;
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  // Attach the live fleet DB as `fleet`, read-only, so the brain can answer
  // occupancy and guide questions. Opened via a file: URI with mode=ro so
  // SQLite itself refuses any write — the app's data cannot be touched.
  if (fs.existsSync(FLEET_DB_PATH)) {
    try {
      const uri = 'file:' + FLEET_DB_PATH.replace(/'/g, "''") + '?mode=ro';
      db.exec(`ATTACH DATABASE '${uri}' AS fleet`);
    } catch (e) {
      console.warn('[brain] could not attach fleet DB (continuing without it):', e.message);
    }
  }
  return db;
}

function runSelect(sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) {
    throw new Error('Only SELECT queries are allowed.');
  }
  if (/\b(insert|update|delete|drop|alter|create|attach|pragma)\b/i.test(sql)) {
    throw new Error('Query contains a forbidden keyword.');
  }
  const db = openDb();
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// POST /api/brain/ask  { question, history: [{role,content}] }
router.post('/ask', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY_REPORTS is not set on the server.' });
  }
  const { question, history = [] } = req.body || {};
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'Ask me something.' });
  }

  try {
    // Keep a short rolling history so follow-ups ("and by channel?") work.
    const messages = [
      ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: String(question) },
    ];

    let reply = await callClaude(messages);
    let sql = null;
    let rows = null;

    const m = reply.match(/<sql>([\s\S]*?)<\/sql>/i);
    if (m) {
      sql = m[1].trim();
      try {
        rows = runSelect(sql);
      } catch (e) {
        // Let Claude repair its own query once.
        messages.push({ role: 'assistant', content: reply });
        messages.push({
          role: 'user',
          content: `That query failed: ${e.message}\nFix it and emit corrected SQL in <sql></sql> tags.`,
        });
        reply = await callClaude(messages);
        const m2 = reply.match(/<sql>([\s\S]*?)<\/sql>/i);
        if (m2) {
          sql = m2[1].trim();
          rows = runSelect(sql);
        }
      }
    }

    let answer = reply;
    if (rows) {
      messages.push({ role: 'assistant', content: reply });
      messages.push({
        role: 'user',
        content:
          `Query returned ${rows.length} row(s):\n\n` +
          JSON.stringify(rows.slice(0, 200), null, 2) +
          `\n\nNow answer my original question using these numbers.`,
      });
      answer = await callClaude(messages);
    }

    // Strip any stray sql block from the final prose.
    answer = answer.replace(/<sql>[\s\S]*?<\/sql>/gi, '').trim();

    res.json({ answer, sql, rows: rows ? rows.slice(0, 50) : null, rowCount: rows ? rows.length : 0 });
  } catch (e) {
    if (e.code === 'NO_DB') return res.status(409).json({ error: e.message });
    console.error('[brain] ask failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/brain/status — what's loaded right now
router.get('/status', (req, res) => {
  if (!fs.existsSync(DB_PATH)) {
    return res.json({ loaded: false });
  }
  try {
    const db = openDb();
    const b = db.prepare('SELECT COUNT(*) n, MIN(booked_at) lo, MAX(booked_at) hi FROM bookings').get();
    const s = db.prepare('SELECT COUNT(*) n, MAX(created_at) hi FROM sales').get();
    db.close();
    res.json({
      loaded: true,
      bookings: b.n,
      bookings_from: b.lo,
      bookings_to: b.hi,
      sales: s.n,
      sales_to: s.hi,
      updated: fs.statSync(DB_PATH).mtime,
    });
  } catch (e) {
    res.json({ loaded: false, error: e.message });
  }
});

// POST /api/brain/upload — { bookings_csv: "<text>", sales_csv: "<text>" }
// Rebuilds the analytics DB from freshly uploaded exports.
router.post('/upload', async (req, res) => {
  const { bookings_csv, sales_csv } = req.body || {};
  if (!bookings_csv || !sales_csv) {
    return res.status(400).json({ error: 'Both the bookings CSV and the sales CSV are required.' });
  }

  const bPath = path.join(UPLOAD_DIR, 'bookings.csv');
  const sPath = path.join(UPLOAD_DIR, 'sales.csv');
  try {
    fs.writeFileSync(bPath, bookings_csv, 'utf8');
    fs.writeFileSync(sPath, sales_csv, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Could not save the uploads: ' + e.message });
  }

  execFile(
    'python3',
    [path.join(BRAIN_DIR, 'load.py'), bPath, sPath, '--db', DB_PATH],
    { timeout: 120000 },
    (err, stdout, stderr) => {
      if (err) {
        console.error('[brain] load failed:', stderr || err.message);
        return res.status(500).json({ error: 'Load failed: ' + (stderr || err.message).slice(0, 400) });
      }
      res.json({ ok: true, message: (stdout || '').trim() });
    }
  );
});

module.exports = router;
