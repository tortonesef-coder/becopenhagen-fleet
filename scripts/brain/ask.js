#!/usr/bin/env node
// ask.js — the BeCopenhagen data brain.
//
// Ask a question in plain English. Claude writes SQL against the analytics
// DB, the SQL is run locally, and Claude explains the result with real
// numbers. Claude never sees your data wholesale — only the schema and the
// rows its own query returns.
//
// Usage:
//   node ask.js "do people book more on Sundays?"
//   node ask.js "which channel has the best true net after commission?"
//   node ask.js "what's our average lead time by product?"
//
// Env: ANTHROPIC_API_KEY_REPORTS (falls back to ANTHROPIC_API_KEY)

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.BRAIN_DB || path.join(__dirname, 'analytics.db');
const API_KEY =
  process.env.ANTHROPIC_API_KEY_REPORTS || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BRAIN_MODEL || 'claude-sonnet-5';

// The schema doc Claude reasons against. Keep this in sync with load.py.
const SCHEMA = `
DATABASE: BeCopenhagen analytics (SQLite). Bike tour + rental company, Copenhagen.
Currency DKK. Data covers Dec 2022 - Jul 2026.

TABLE bookings  -- one row per booking (3,071 rows)
  booking_id, order_id
  cancelled          INT  0/1 (FareHarbor writes 'Cancelled' in the source)
  cancelled_at       DATE when it was cancelled (NULL if not cancelled)
  cancelled_by       TEXT who cancelled it
  cancel_days_before_tour INT  tour_date - cancelled_at. How far ahead they
                          cancelled; negative = cancelled after the tour date.
                          NOTE: cancellations are rare (~20 of 3,174 = 0.6%),
                          so slice them carefully — per-channel or per-product
                          cancellation rates rest on tiny samples. Say so.
  item               TEXT product code. Tours: A3/L3/F3/H3 (3h group tours),
                          A3P/L3P/F3P (private), CUSTOM (bespoke groups),
                          ESS/ARCH/NV/LIGHT/Nordhavn (older/retired names),
                          L2 (discontinued 2026). Rentals: '1-D'..'14-D'
                          (N-day bike rental).
  item_category      TEXT 'tour_group' | 'tour_private' | 'rental' | 'gift_card'
  rental_days        INT  N for an N-D rental, else NULL
  booked_at          DATE when the SALE was made
  booked_time        TEXT 'HH:MM'
  booked_dow         TEXT day name the sale was made ('Sunday', ...)
  booked_hour        INT  hour of day the sale was made
  tour_date          DATE when the TOUR RUNS (for rentals: pickup)
  tour_time          TEXT 'HH:MM' start time
  tour_dow           TEXT day name the tour runs
  tour_hour          INT  start hour
  availability_id    TEXT the departure slot
  lead_days          INT  tour_date - booked_at (booking lead time)
  pax                INT  number of people
  language           TEXT contact language, e.g. 'English (UK)', 'German'
  country            TEXT ISO country from phone number, e.g. 'US','DE','DK'
  created_by         TEXT 'Online' | 'Shop' | staff name | '<x>-api'
  paid_status        TEXT 'paid'|'unpaid'|'underpaid'|'overpaid'
  channel            TEXT 'GetYourGuide'|'Viator'|'Musement/TUI'|'Airbnb'|
                          'Google'|'FHDN'|'Direct/Website'|'Shop/Walk-in'|
                          'Staff (name)'
  commission_rate    REAL commission we pay that channel (GYG 0.30, most OTAs
                          0.20, direct 0.0). True net = total * (1-rate).
  channel_type       TEXT 'OTA' | 'Direct'
  subtotal, tax, total, total_paid, net_revenue, processing_fees,
  paid_to_affiliate, amount_due   REAL (DKK)
  revenue_per_pax    REAL total/pax

TABLE sales  -- one row per payment or refund event (3,552 rows)
  txn_id, booking_id  (join to bookings.booking_id)
  item, kind          kind = 'Payment' | 'Refund'
  created_at          DATE of the payment/refund
  created_dow         TEXT day name
  payment_type        TEXT 'credit card', etc.
  card_type           TEXT 'Visa','MasterCard','Apple Pay',...
  gross, processing_fee, net, refund_gross, tax_paid, subtotal_paid  REAL
  payout_date         DATE

IMPORTANT GUIDANCE
- "Do people book on X" = booked_dow (sale date). "Are X tours busy" =
  tour_dow (delivery date). These are DIFFERENT — if the question is
  ambiguous, answer BOTH.
- Revenue: use bookings.total for booking value; use sales for actual cash
  in/out incl. refunds (sales.kind='Refund' has negative-ish gross).
- Product mix changed over time: L2 discontinued, H3/F3 are newer, older
  codes (ESS/ARCH/NV) are legacy names. Be careful with YoY per product.
- Rentals ('1-D'..'14-D') are bikes, not tours. Exclude them from tour
  analysis unless asked.
`;

const SYSTEM = `You are the data analyst for BeCopenhagen, a Copenhagen bike
tour and rental company. You answer Federico's questions by querying a SQLite
database.

${SCHEMA}

Process:
1. Think about what the question really asks (watch the booked_dow vs
   tour_dow distinction above).
2. Emit ONE SQL query (SQLite dialect) inside <sql></sql> tags. It must be a
   read-only SELECT. No writes, ever.
3. You'll be given the result rows, then you explain the answer.

Style: direct and concrete. Lead with the answer, cite the real numbers, note
any caveat that actually matters (small sample, product discontinued, data
gap). Don't pad. DKK for money. If the data genuinely can't answer the
question, say so plainly instead of guessing.`;

function runSql(sql) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
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
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function ask(question, { verbose = false } = {}) {
  if (!API_KEY) throw new Error('Set ANTHROPIC_API_KEY_REPORTS (or ANTHROPIC_API_KEY)');

  const messages = [{ role: 'user', content: question }];
  let reply = await callClaude(messages);

  // Extract and run the SQL, then feed results back for interpretation.
  const m = reply.match(/<sql>([\s\S]*?)<\/sql>/i);
  if (!m) return reply; // Claude answered without needing a query

  const sql = m[1].trim();
  if (!/^\s*(select|with)\b/i.test(sql)) {
    throw new Error('Refusing to run non-SELECT SQL:\n' + sql);
  }
  if (verbose) console.log('\n--- SQL ---\n' + sql + '\n');

  let rows;
  try {
    rows = runSql(sql);
  } catch (e) {
    // Give Claude the error so it can repair its own query, once.
    messages.push({ role: 'assistant', content: reply });
    messages.push({
      role: 'user',
      content: `That query failed: ${e.message}\nPlease fix it and emit corrected SQL in <sql></sql> tags.`,
    });
    reply = await callClaude(messages);
    const m2 = reply.match(/<sql>([\s\S]*?)<\/sql>/i);
    if (!m2) return reply;
    const sql2 = m2[1].trim();
    if (verbose) console.log('\n--- SQL (retry) ---\n' + sql2 + '\n');
    rows = runSql(sql2);
  }

  messages.push({ role: 'assistant', content: reply });
  messages.push({
    role: 'user',
    content:
      `Query returned ${rows.length} row(s):\n\n` +
      JSON.stringify(rows.slice(0, 200), null, 2) +
      `\n\nNow answer my original question using these numbers.`,
  });

  return await callClaude(messages);
}

if (require.main === module) {
  const verbose = process.argv.includes('--sql');
  const question = process.argv.slice(2).filter((a) => a !== '--sql').join(' ');
  if (!question) {
    console.log('Usage: node ask.js [--sql] "your question"');
    process.exit(1);
  }
  ask(question, { verbose })
    .then((a) => console.log('\n' + a + '\n'))
    .catch((e) => {
      console.error('Error:', e.message);
      process.exit(1);
    });
}

module.exports = { ask, runSql, SCHEMA };
