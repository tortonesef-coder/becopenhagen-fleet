// brain/analyst.js
//
// The proactive half of the brain. Runs on a schedule (or on demand), and:
//   1. computes a battery of DETERMINISTIC metrics (code, not Claude — so the
//      numbers in every briefing are real, never hallucinated)
//   2. hands them to Claude, which may run a few follow-up queries to
//      investigate anything that looks off
//   3. Claude writes a briefing: what's healthy, what's flagged, and the
//      low-hanging fruit
//   4. the briefing is stored (briefings.db — separate file, so rebuilding
//      analytics.db never destroys history) and optionally emailed
//
// Run on demand:   node analyst.js
// Weekly cron:     0 6 * * 1  cd /var/www/becopenhagen-fleet/brain && node analyst.js --email
//
// Optional email env (in .env): BRAIN_SMTP_HOST, BRAIN_SMTP_PORT,
// BRAIN_SMTP_USER, BRAIN_SMTP_PASS, BRAIN_EMAIL_TO

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'analytics.db');
const BRIEF_DB = path.join(__dirname, 'briefings.db');
const FLEET_DB = process.env.FLEET_DB || '/var/www/becopenhagen-fleet/data/fleet.db';
const API_KEY = process.env.ANTHROPIC_API_KEY_REPORTS || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BRAIN_MODEL || 'claude-sonnet-5';

/* ── db access (same read-only discipline as the server) ─────────────────── */
function openDb() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  if (fs.existsSync(FLEET_DB)) {
    try { db.exec(`ATTACH DATABASE 'file:${FLEET_DB}?mode=ro' AS fleet`); } catch (_) {}
  }
  return db;
}
function q(db, sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('SELECT only');
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum)\b/i.test(sql)) {
    throw new Error('forbidden keyword');
  }
  return db.prepare(sql).all();
}

/* ── deterministic metric battery ─────────────────────────────────────────
   These are computed in code so the briefing's core numbers are guaranteed
   real. Claude interprets; it does not invent. */
function computeMetrics(db) {
  const m = {};
  const safe = (name, sql) => {
    try { m[name] = q(db, sql); } catch (e) { m[name] = { error: e.message }; }
  };

  // headline: last 4 complete weeks, week over week
  safe('weekly_revenue_last_8w', `
    SELECT strftime('%Y-%W', booked_at) AS week,
           COUNT(*) bookings, ROUND(SUM(total)) gross,
           ROUND(SUM(CASE WHEN item_category='rental' THEN total ELSE 0 END)) rental_gross,
           ROUND(SUM(CASE WHEN item_category LIKE 'tour%' THEN total ELSE 0 END)) tour_gross
    FROM bookings
    WHERE booked_at >= date('now','-56 days') AND item_category != 'excluded'
    GROUP BY week ORDER BY week`);

  // same window last year, for seasonality-aware comparison
  safe('same_weeks_last_year', `
    SELECT strftime('%Y-%W', booked_at) AS week, COUNT(*) bookings, ROUND(SUM(total)) gross
    FROM bookings
    WHERE booked_at BETWEEN date('now','-421 days') AND date('now','-365 days')
      AND item_category != 'excluded'
    GROUP BY week ORDER BY week`);

  // product mix, last 28 days vs previous 28
  safe('product_28d_vs_prev', `
    SELECT item,
           SUM(CASE WHEN booked_at >= date('now','-28 days') THEN 1 ELSE 0 END) cur_bookings,
           ROUND(SUM(CASE WHEN booked_at >= date('now','-28 days') THEN total ELSE 0 END)) cur_gross,
           SUM(CASE WHEN booked_at < date('now','-28 days') AND booked_at >= date('now','-56 days') THEN 1 ELSE 0 END) prev_bookings,
           ROUND(SUM(CASE WHEN booked_at < date('now','-28 days') AND booked_at >= date('now','-56 days') THEN total ELSE 0 END)) prev_gross
    FROM bookings
    WHERE booked_at >= date('now','-56 days') AND item_category != 'excluded'
    GROUP BY item HAVING cur_bookings + prev_bookings > 3
    ORDER BY cur_gross DESC`);

  // channel mix + true net, last 28 days
  safe('channel_28d', `
    SELECT channel, COUNT(*) bookings, ROUND(SUM(total)) gross,
           ROUND(SUM(total * (1 - COALESCE(commission_rate, 0)))) true_net
    FROM bookings
    WHERE booked_at >= date('now','-28 days') AND item_category != 'excluded'
    GROUP BY channel ORDER BY gross DESC`);

  // occupancy from fleet: empty vs sold departures, last 28 days, by product
  safe('occupancy_28d', `
    SELECT feed_label AS product, COUNT(*) departures,
           SUM(CASE WHEN booking_count = 0 THEN 1 ELSE 0 END) empty_departures,
           SUM(booking_count) seats_sold,
           ROUND(100.0 * SUM(CASE WHEN booking_count > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) pct_departures_sold
    FROM fleet.tour_availabilities
    WHERE feed_type = 'tour' AND start_date >= date('now','-28 days') AND start_date < date('now')
    GROUP BY feed_label ORDER BY departures DESC`);

  // forward look: bookings already on the books for the next 14 days
  safe('next_14_days', `
    SELECT tour_date, COUNT(*) bookings, SUM(pax) pax, ROUND(SUM(total)) value
    FROM bookings
    WHERE tour_date >= date('now') AND tour_date < date('now','+14 days')
      AND cancelled = 0 AND item_category != 'excluded'
    GROUP BY tour_date ORDER BY tour_date`);

  // refunds, last 28 days vs previous 28
  safe('refunds_recent', `
    SELECT SUM(CASE WHEN created_at >= date('now','-28 days') THEN 1 ELSE 0 END) cur_refunds,
           SUM(CASE WHEN created_at < date('now','-28 days') THEN 1 ELSE 0 END) prev_refunds
    FROM sales WHERE kind = 'Refund' AND created_at >= date('now','-56 days')`);

  // unpaid exposure on upcoming bookings
  safe('unpaid_upcoming', `
    SELECT COUNT(*) bookings, ROUND(SUM(amount_due)) total_due
    FROM bookings
    WHERE tour_date >= date('now') AND cancelled = 0
      AND paid_status IN ('unpaid','underpaid') AND COALESCE(amount_due, 0) > 0`);

  // bike type mix, last 28 days (needs the customers report to be loaded)
  safe('bike_mix_28d', `
    SELECT c.bike_type, SUM(c.pax) units
    FROM customer_types c JOIN bookings b ON b.booking_id = c.booking_id
    WHERE c.is_bike = 1 AND b.booked_at >= date('now','-28 days')
    GROUP BY c.bike_type ORDER BY units DESC`);

  return m;
}

/* ── Claude ───────────────────────────────────────────────────────────────── */
async function callClaude(messages, system) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, system, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    text: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    truncated: data.stop_reason === 'max_tokens',
  };
}

function extractSql(text) {
  const out = [];
  const re = /<sql>([\s\S]*?)(?:<\/sql>|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) if (m[1].trim()) out.push(m[1].trim());
  return out;
}

function buildSystem() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.txt'), 'utf8');
  let context = '';
  try { context = fs.readFileSync(path.join(__dirname, 'context.md'), 'utf8'); } catch (_) {}
  return `You are the resident analyst for BeCopenhagen, a Copenhagen bike tour and
rental company. Once a week you review the business and write a briefing for
Federico, the founder.

=== BUSINESS CONTEXT (authoritative) ===
${context}

=== DATABASE SCHEMA ===
${schema}

You have been given a battery of pre-computed metrics (real numbers, computed
in code). You may investigate further: emit <sql>SELECT ...</sql> blocks (up
to 4 per turn) and you'll get the rows back. Investigate only where something
looks genuinely interesting or off — don't query for the sake of it.

When you're done investigating, write the briefing in this shape:

## The week
Two or three sentences: how the business is actually doing.

## Flags
Things that need attention. Each flag: what, the numbers, why it matters.
If nothing is genuinely wrong, say so — do not invent concerns.

## Low-hanging fruit
Concrete opportunities the data supports. Each: the opportunity, the evidence,
a suggested next step. Only include ones with real evidence.

## Watching
Anything ambiguous worth re-checking next week.

Rules: every number must come from the metrics or your query results — never
from memory. Note when a fleet.* metric only covers recent months. Be direct;
skip filler. DKK for money. When you are finished and the briefing is complete,
end with the line: BRIEFING_COMPLETE`;
}

async function runAnalysis({ maxRounds = 4 } = {}) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY_REPORTS is not set');
  if (!fs.existsSync(DB_PATH)) throw new Error('No analytics.db — load data first');

  const db = openDb();
  const metrics = computeMetrics(db);

  // Continuity: hand the analyst its own previous briefing so "Watching"
  // items actually get followed up week over week, instead of every run
  // starting from amnesia.
  let previous = '';
  if (fs.existsSync(BRIEF_DB)) {
    try {
      const bdb = new DatabaseSync(BRIEF_DB, { readOnly: true });
      const last = bdb.prepare('SELECT body, created_at FROM briefings ORDER BY id DESC LIMIT 1').get();
      bdb.close();
      if (last) previous = `\n\nYour previous briefing (${last.created_at}) — follow up on anything you said you were watching:\n${last.body}`;
    } catch (_) {}
  }

  const system = buildSystem();
  const messages = [{
    role: 'user',
    content: 'Here are this week\'s pre-computed metrics:\n\n' +
      JSON.stringify(metrics, null, 2) +
      previous +
      '\n\nInvestigate what deserves it, then write the briefing.',
  }];

  let briefing = null;
  let queriesRun = 0;

  for (let round = 0; round < maxRounds; round++) {
    const { text } = await callClaude(messages, system);
    const sqls = extractSql(text);

    if (!sqls.length || text.includes('BRIEFING_COMPLETE')) {
      briefing = text
        .replace(/<sql>[\s\S]*?(?:<\/sql>|$)/gi, '')
        .replace(/BRIEFING_COMPLETE\s*$/i, '')
        .trim();
      break;
    }

    // run its follow-up queries, feed results back
    const results = sqls.slice(0, 4).map((sql, i) => {
      try {
        const rows = q(db, sql);
        queriesRun++;
        return `Query ${i + 1} (${rows.length} rows):\n` + JSON.stringify(rows.slice(0, 60), null, 2);
      } catch (e) {
        return `Query ${i + 1} FAILED: ${e.message}`;
      }
    }).join('\n\n');

    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: results + '\n\nContinue: investigate further if needed, or write the final briefing ending with BRIEFING_COMPLETE.',
    });
  }

  db.close();

  if (!briefing) throw new Error('Analysis did not converge to a briefing');

  // store it — separate DB file so analytics rebuilds never erase history
  const bdb = new DatabaseSync(BRIEF_DB);
  bdb.exec(`CREATE TABLE IF NOT EXISTS briefings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    body TEXT, queries_run INTEGER
  )`);
  bdb.prepare('INSERT INTO briefings (body, queries_run) VALUES (?, ?)').run(briefing, queriesRun);
  bdb.close();

  return { briefing, queriesRun };
}

/* ── optional email ───────────────────────────────────────────────────────── */
async function emailBriefing(briefing) {
  const host = process.env.BRAIN_SMTP_HOST;
  if (!host) { console.log('(no BRAIN_SMTP_HOST set — skipping email)'); return; }
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (_) { console.log('(nodemailer not installed — run npm install nodemailer)'); return; }

  const t = nodemailer.createTransport({
    host,
    port: parseInt(process.env.BRAIN_SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.BRAIN_SMTP_USER, pass: process.env.BRAIN_SMTP_PASS },
  });
  await t.sendMail({
    from: process.env.BRAIN_SMTP_USER,
    to: process.env.BRAIN_EMAIL_TO || process.env.BRAIN_EMAIL,
    subject: `beCopenhagen briefing — ${new Date().toISOString().slice(0, 10)}`,
    text: briefing,
  });
  console.log('Briefing emailed.');
}

/* ── cli ──────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  runAnalysis()
    .then(async ({ briefing, queriesRun }) => {
      console.log(`\n(analyst ran ${queriesRun} follow-up queries)\n`);
      console.log(briefing);
      if (process.argv.includes('--email')) await emailBriefing(briefing);
    })
    .catch(e => { console.error('Analysis failed:', e.message); process.exit(1); });
}

module.exports = { runAnalysis, computeMetrics };
