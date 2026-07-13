// brain/load.js
//
// Builds the analytics database from the two FareHarbor CSV exports.
// Pure Node — no Python, no external packages.
//
//   node load.js <bookings.csv> <sales.csv> [--db analytics.db]
//
// Rebuilds the tables from scratch each run, so it's safe to re-run weekly
// with fresh exports.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/* ── CSV parsing ────────────────────────────────────────────────────────── */
// Handles quoted fields, embedded commas, escaped quotes ("") and CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignore, handled by \n */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// FareHarbor exports put a title line first, then the real header.
function readReport(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = parseCsv(raw).filter(r => r.some(c => c.trim() !== ''));
  if (rows.length < 2) throw new Error(`${path.basename(file)} looks empty`);

  const header = rows[1].map(h => h.trim());
  const records = rows.slice(2).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return records;
}

/* ── value coercion ─────────────────────────────────────────────────────── */
// 'DKK1,234.56' / '-DKK10.40' / '' -> number | null
function money(v) {
  if (v == null) return null;
  let s = String(v).replace(/DKK/gi, '').replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

function int(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// FareHarbor writes dates as DD/MM/YYYY. Return ISO 'YYYY-MM-DD' so SQLite
// can sort and compare them, and strftime() works.
function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function dayName(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00Z');
  return Number.isNaN(d.getTime()) ? null : DOW[d.getUTCDay()];
}
function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso + 'T12:00:00Z'), b = new Date(bIso + 'T12:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}
function hourOf(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2})/);
  return m ? parseInt(m[1], 10) : null;
}

/* ── business rules ─────────────────────────────────────────────────────── */
// Everything here comes from products.json — the single source of truth.
// No guessing from item names: that mislabelled the Danish "PRIVAT" tours
// as group tours, and CUSTOM (avg 15 pax) likewise.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));
const ITEMS = REGISTRY.items || {};
const CHANNELS = REGISTRY._channels || {};

function classifyChannel(affiliate, createdBy) {
  const a = (affiliate || '').trim();
  if (a) {
    const def = CHANNELS[a];
    if (def) return [def.name, def.commission, 'OTA'];
    return [a, null, 'OTA'];   // unknown affiliate: don't invent a rate
  }
  const cb = (createdBy || '').trim();
  const low = cb.toLowerCase();
  if (low === 'online') return ['Direct/Website', 0, 'Direct'];
  if (low === 'shop' || low === 'walk-in') return ['Shop/Walk-in', 0, 'Direct'];
  if (cb) return [`Staff (${cb})`, 0, 'Direct'];
  return ['Unknown', null, 'Unknown'];
}

const unknownItems = new Set();

function classifyItem(item) {
  const s = (item || '').trim();

  // 'N-D' = N-day bike rental
  const m = s.match(/^(\d+)-D$/);
  if (m) return ['rental', parseInt(m[1], 10), 'active', null];

  const def = ITEMS[s];
  if (def) return [def.category, null, def.status || 'active', def.successor || null];

  // Unknown item: flag it loudly rather than silently guessing a category.
  unknownItems.add(s);
  return ['unclassified', null, 'unknown', null];
}

/* ── load ───────────────────────────────────────────────────────────────── */
function loadBookings(file, db) {
  const recs = readReport(file)
    // FareHarbor appends a grand-totals row (no booking id / no item).
    // It must be dropped or it poisons every aggregate.
    .filter(r => (r['Booking ID'] || '').trim() && (r['Item'] || '').trim())
    .filter(r => !/total/i.test(r['Booking ID']));

  db.exec('DROP TABLE IF EXISTS bookings');
  db.exec(`CREATE TABLE bookings (
    booking_id TEXT, order_id TEXT,
    cancelled INTEGER, cancelled_at TEXT, cancelled_by TEXT,
    cancel_days_before_tour INTEGER,
    item TEXT, item_category TEXT, rental_days INTEGER,
    item_status TEXT, item_successor TEXT,
    booked_at TEXT, booked_time TEXT, booked_dow TEXT, booked_hour INTEGER,
    tour_date TEXT, tour_time TEXT, tour_dow TEXT, tour_hour INTEGER,
    availability_id TEXT, lead_days INTEGER,
    pax INTEGER, language TEXT, country TEXT, created_by TEXT, paid_status TEXT,
    channel TEXT, commission_rate REAL, channel_type TEXT, affiliate_raw TEXT,
    subtotal REAL, tax REAL, total REAL, total_paid REAL, net_revenue REAL,
    processing_fees REAL, paid_to_affiliate REAL, amount_due REAL,
    revenue_per_pax REAL
  )`);

  const ins = db.prepare(`INSERT INTO bookings VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const r of recs) {
    const bookedAt = isoDate(r['Created At Date']);
    const tourDate = isoDate(r['Start Date']);
    const cancelledAt = isoDate(r['Cancelled At Date']);

    // FareHarbor writes 'Cancelled' (not 'Yes') in this column.
    const cancFlag = (r['Cancelled?'] || '').trim().toLowerCase();
    const cancelled = (cancFlag === 'yes' || cancFlag === 'cancelled') ? 1 : 0;

    const [cat, rentalDays, status, successor] = classifyItem(r['Item']);
    const [channel, rate, chType] = classifyChannel(r['Affiliate'], r['Created By']);

    const pax = int(r['# of Pax']);
    const total = money(r['Total']);

    ins.run(
      (r['Booking ID'] || '').replace(/^#/, ''),
      (r['Order ID'] || '').replace(/^#/, ''),
      cancelled, cancelledAt, r['Cancelled By'] || null,
      daysBetween(tourDate, cancelledAt),
      r['Item'] || null, cat, rentalDays, status, successor,
      bookedAt, r['Created At Time'] || null, dayName(bookedAt), hourOf(r['Created At Time']),
      tourDate, r['Start Time'] || null, dayName(tourDate), hourOf(r['Start Time']),
      (r['Availability ID'] || '').replace(/^#/, ''),
      daysBetween(tourDate, bookedAt),
      pax, r['Contact Language'] || null, r['Country by phone'] || null,
      r['Created By'] || null, r['Paid Status'] || null,
      channel, rate, chType, r['Affiliate'] || null,
      money(r['Subtotal']), money(r['Total Tax']), total,
      money(r['Total Paid']), money(r['Net Revenue Collected']),
      money(r['Processing Fees']), money(r['Total Paid to Affiliate']),
      money(r['Amount Due']),
      (pax && total) ? total / pax : null
    );
  }
  return recs.length;
}

function loadSales(file, db) {
  const recs = readReport(file).filter(r => (r['Payment or Refund ID'] || '').trim());

  db.exec('DROP TABLE IF EXISTS sales');
  db.exec(`CREATE TABLE sales (
    txn_id TEXT, booking_id TEXT, item TEXT, kind TEXT,
    created_at TEXT, created_dow TEXT,
    payment_type TEXT, card_type TEXT, created_by TEXT,
    gross REAL, processing_fee REAL, net REAL, refund_gross REAL,
    tax_paid REAL, subtotal_paid REAL, payout_date TEXT
  )`);

  const ins = db.prepare('INSERT INTO sales VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

  for (const r of recs) {
    const created = isoDate(r['Created At Date']);
    ins.run(
      (r['Payment or Refund ID'] || '').replace(/^#/, ''),
      (r['Booking ID'] || '').replace(/^#/, ''),
      r['Item'] || null,
      r['Payment or Refund'] || null,
      created, dayName(created),
      r['Payment Type'] || null, r['Credit Card Type'] || null, r['Created By'] || null,
      money(r['Gross']), money(r['Processing Fee']), money(r['Net']),
      money(r['Refund Gross']), money(r['Tax Paid']), money(r['Subtotal Paid']),
      isoDate(r['Payout Date'])
    );
  }
  return recs.length;
}

/* ── main ───────────────────────────────────────────────────────────────── */
function main() {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : path.join(__dirname, 'analytics.db');
  const files = args.filter((a, i) => a !== '--db' && i !== dbIdx + 1);

  if (files.length < 2) {
    console.error('Usage: node load.js <bookings.csv> <sales.csv> [--db analytics.db]');
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  const nb = loadBookings(files[0], db);
  const ns = loadSales(files[1], db);

  for (const stmt of [
    'CREATE INDEX IF NOT EXISTS ix_b_booked ON bookings(booked_at)',
    'CREATE INDEX IF NOT EXISTS ix_b_tour ON bookings(tour_date)',
    'CREATE INDEX IF NOT EXISTS ix_b_item ON bookings(item)',
    'CREATE INDEX IF NOT EXISTS ix_b_channel ON bookings(channel)',
    'CREATE INDEX IF NOT EXISTS ix_b_avail ON bookings(availability_id)',
    'CREATE INDEX IF NOT EXISTS ix_s_created ON sales(created_at)',
    'CREATE INDEX IF NOT EXISTS ix_s_booking ON sales(booking_id)',
  ]) db.exec(stmt);

  db.close();
  console.log(`Loaded ${nb.toLocaleString()} bookings and ${ns.toLocaleString()} sales transactions.`);
  if (unknownItems.size) {
    console.log(`\nNOTE: ${unknownItems.size} item(s) are not in products.json and were left unclassified:`);
    for (const u of unknownItems) console.log('  - ' + u);
    console.log('Add them to products.json so they are analysed correctly.');
  }
}

if (require.main === module) main();
module.exports = { parseCsv, money, isoDate };
