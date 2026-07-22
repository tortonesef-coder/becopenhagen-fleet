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
// NOTE: some reports repeat a column name (the customers report has '# of Pax'
// and 'Total' twice — once per customer line, once per booking). Keying only
// by name would silently let the second overwrite the first, so we also keep
// the raw positional array.
function readReport(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = parseCsv(raw).filter(r => r.some(c => c.trim() !== ''));
  if (rows.length < 2) throw new Error(`${path.basename(file)} looks empty`);

  const header = rows[1].map(h => h.replace(/^\uFEFF/, '').trim());
  return rows.slice(2).map(r => {
    const o = {};
    header.forEach((h, i) => { if (!(h in o)) o[h] = (r[i] ?? '').trim(); });
    o._cells = r.map(c => (c ?? '').trim());   // positional access
    return o;
  });
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
  let a = (affiliate || '').trim();
  // FareHarbor is inconsistent: some exports leave Affiliate empty for direct
  // bookings, others write the literal string "None". Both mean direct.
  if (a === 'None' || a === 'none') a = '';
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

/* ── schema migration ─────────────────────────────────────────────────────
   Tables created before merge-mode had no primary keys, so upserts couldn't
   dedupe. Migrate by COPYING the rows into a keyed table — never by dropping.
   (An earlier version dropped the table, which destroyed real data the first
   time an incremental slice was uploaded. Migrations must preserve. Always.)

   createSql builds the new keyed table under a temp name; rows are copied
   across on the shared columns, then the tables are swapped. */
function ensureKeyed(db, table, keyCol, createSqlFor) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) return;                                   // no table yet
    if (cols.some(c => c.name === keyCol && c.pk > 0)) return;  // already keyed

    console.log(`(migrating ${table} to keyed schema — preserving all ${db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n} existing rows)`);
    const tmp = `${table}_keyed_tmp`;
    db.exec(`DROP TABLE IF EXISTS ${tmp}`);
    db.exec(createSqlFor(tmp));
    const newCols = db.prepare(`PRAGMA table_info(${tmp})`).all().map(c => c.name);
    const oldCols = cols.map(c => c.name);
    const shared = newCols.filter(c => oldCols.includes(c)).map(c => `"${c}"`).join(',');
    db.exec(`INSERT OR REPLACE INTO ${tmp} (${shared}) SELECT ${shared} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  } catch (e) {
    // If migration fails, leave the original table alone — an unkeyed table
    // that merges imperfectly beats a destroyed one.
    console.error(`(migration of ${table} failed, leaving it untouched: ${e.message})`);
  }
}

const BOOKINGS_SCHEMA = (name) => `CREATE TABLE ${name} (
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
    revenue_per_pax REAL,
    PRIMARY KEY (booking_id)
  )`;

const SALES_SCHEMA = (name) => `CREATE TABLE ${name} (
    txn_id TEXT, booking_id TEXT, item TEXT, kind TEXT,
    created_at TEXT, created_dow TEXT,
    payment_type TEXT, card_type TEXT, created_by TEXT,
    gross REAL, processing_fee REAL, net REAL, refund_gross REAL,
    tax_paid REAL, subtotal_paid REAL, payout_date TEXT,
    PRIMARY KEY (txn_id)
  )`;

/* ── load ───────────────────────────────────────────────────────────────── */
function loadBookings(file, db) {
  const recs = readReport(file)
    // FareHarbor appends a grand-totals row (no booking id / no item).
    // It must be dropped or it poisons every aggregate.
    .filter(r => (r['Booking ID'] || '').trim() && (r['Item'] || '').trim())
    .filter(r => !/total/i.test(r['Booking ID']));

  db.exec(BOOKINGS_SCHEMA('bookings').replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));

  // Upsert by booking_id: new bookings insert, existing ones get REPLACED so
  // late changes (a cancellation, a payment) are corrected on re-upload.
  const ins = db.prepare(`INSERT OR REPLACE INTO bookings VALUES (
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

  db.exec(SALES_SCHEMA('sales').replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));

  const ins = db.prepare('INSERT OR REPLACE INTO sales VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

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

/* ── customer types ─────────────────────────────────────────────────────── */
// One row per customer line-item on a booking. This is where bike types live
// (Christiania cargo, e-bike, child seat...), which the bookings export does
// not contain at all.
//
// The 'Customer type' field does three different jobs at once, so we split it:
//   - bike_type      the actual bike (Christiania Cargo, Electric, Touring...)
//   - person_type    adult / child
//   - is_private_tier "16 People (16PaxPrivate)" = a private PRICING TIER, not
//                    a bike and not a person. Must be excluded from bike counts
//                    or it corrupts them.

function classifyCustomerType(raw) {
  const s = (raw || '').trim();
  const low = s.toLowerCase();

  // private pricing tiers, e.g. "16 People (16PaxPrivate)"
  if (/\(\d+PaxPrivate\)/i.test(s) || /^\d+ (person|people)\b/i.test(s)) {
    return { bike_type: null, person_type: null, is_private_tier: 1, is_bike: 0 };
  }
  // bespoke group guests
  if (/^guest custom/i.test(s)) {
    return { bike_type: null, person_type: 'adult', is_private_tier: 0, is_bike: 0 };
  }
  // generic rental line
  if (/^number of bikes$/i.test(s)) {
    return { bike_type: 'Unspecified', person_type: null, is_private_tier: 0, is_bike: 1 };
  }

  let bike = null;
  if (/christiania|cargo/.test(low)) bike = 'Christiania cargo';
  else if (/e-?bike|electric/.test(low)) bike = 'Electric';
  else if (/toddler seat/.test(low)) bike = 'Bike + toddler seat';
  else if (/child seat/.test(low)) bike = 'Bike + child seat';
  else if (/child bike|child \+ bike|child incl/.test(low)) bike = 'Child bike';
  else if (/touring/.test(low)) bike = 'Touring';
  else if (/mountain/.test(low)) bike = 'Mountain';
  else if (/strida/.test(low)) bike = 'STRiDA foldable';
  else if (/city bike \(small\)|city bike small/.test(low)) bike = 'City (small)';
  else if (/city bike large/.test(low)) bike = 'City (large)';
  else if (/own bike/.test(low)) bike = 'Own bike (brought)';
  else if (/bike/.test(low)) bike = 'Standard';

  const person = /child|toddler/.test(low) ? 'child' : 'adult';

  return {
    bike_type: bike,
    person_type: person,
    is_private_tier: 0,
    is_bike: bike && bike !== 'Own bike (brought)' ? 1 : 0,
  };
}

function loadCustomerTypes(file, db) {
  const recs = readReport(file).filter(r => {
    const id = (r['Booking ID'] || '').trim();
    const ct = (r['Customer type'] || '').trim();
    // drop the trailing totals row ("33 customer types" / "38 items")
    if (!id || !ct) return false;
    if (/^\d+ customer types$/i.test(ct)) return false;
    return true;
  });

  db.exec(`CREATE TABLE IF NOT EXISTS customer_types (
    booking_id TEXT, item TEXT,
    customer_type TEXT, bike_type TEXT, person_type TEXT,
    is_bike INTEGER, is_private_tier INTEGER,
    pax INTEGER, subtotal REAL, tax REAL, total REAL, total_paid REAL,
    checkin_status TEXT
  )`);

  // Replace per booking: a booking's customer lines can change (someone adds
  // a child seat), and there's no stable per-line ID — so wipe just the
  // bookings present in this upload, then insert their fresh lines.
  const idsInUpload = [...new Set(recs.map(r => (r['Booking ID'] || '').replace(/^#/, '')))];
  const del = db.prepare('DELETE FROM customer_types WHERE booking_id = ?');
  for (const id of idsInUpload) del.run(id);

  const ins = db.prepare('INSERT INTO customer_types VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of recs) {
    const c = classifyCustomerType(r['Customer type']);
    // '# of Pax' and 'Total' appear TWICE in this report — customer-level at
    // index 2/11, booking-level at 32/33. Use position, not name.
    const cells = r._cells || [];
    ins.run(
      (r['Booking ID'] || '').replace(/^#/, ''),
      r['Item'] || null,
      r['Customer type'] || null,
      c.bike_type, c.person_type, c.is_bike, c.is_private_tier,
      int(cells[2]),
      money(cells[8]), money(cells[10]), money(cells[11]), money(cells[15]),
      r['Check-in Status'] || null
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
    console.error('Usage: node load.js <bookings.csv> <sales.csv> [customers.csv] [--db analytics.db]');
    process.exit(1);
  }

  // Backup before any write: if anything destructive ever slips through,
  // the previous state is one file-copy away.
  let preCount = 0;
  if (fs.existsSync(dbPath)) {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, dbPath + ext + '.bak');
    }
    try {
      const d0 = new DatabaseSync(dbPath, { readOnly: true });
      preCount = d0.prepare('SELECT COUNT(*) n FROM bookings').get().n;
      d0.close();
    } catch (_) {}
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  ensureKeyed(db, 'bookings', 'booking_id', BOOKINGS_SCHEMA);
  ensureKeyed(db, 'sales', 'txn_id', SALES_SCHEMA);

  const nb = loadBookings(files[0], db);
  const ns = loadSales(files[1], db);
  let nc = 0;
  if (files[2] && fs.existsSync(files[2])) nc = loadCustomerTypes(files[2], db);

  for (const stmt of [
    'CREATE INDEX IF NOT EXISTS ix_b_booked ON bookings(booked_at)',
    'CREATE INDEX IF NOT EXISTS ix_b_tour ON bookings(tour_date)',
    'CREATE INDEX IF NOT EXISTS ix_b_item ON bookings(item)',
    'CREATE INDEX IF NOT EXISTS ix_b_channel ON bookings(channel)',
    'CREATE INDEX IF NOT EXISTS ix_b_avail ON bookings(availability_id)',
    'CREATE INDEX IF NOT EXISTS ix_s_created ON sales(created_at)',
    'CREATE INDEX IF NOT EXISTS ix_s_booking ON sales(booking_id)',
    'CREATE INDEX IF NOT EXISTS ix_c_booking ON customer_types(booking_id)',
    'CREATE INDEX IF NOT EXISTS ix_c_bike ON customer_types(bike_type)',
  ]) { try { db.exec(stmt); } catch (_) {} }

  const span = db.prepare('SELECT COUNT(*) n, MIN(booked_at) lo, MAX(booked_at) hi FROM bookings').get();
  db.close();

  // INVARIANT: under accrual the booking count can never DECREASE — merge
  // inserts and replaces, never deletes. A shrink means something destructive
  // happened: restore the backup and refuse to proceed.
  if (span.n < preCount) {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + ext + '.bak')) fs.copyFileSync(dbPath + ext + '.bak', dbPath + ext);
      else if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext);
    }
    console.error(
      `SAFETY STOP: bookings would have gone from ${preCount.toLocaleString()} to ` +
      `${span.n.toLocaleString()} — impossible under accrual. Restored the previous ` +
      `database untouched; this upload was NOT applied.`
    );
    process.exit(1);
  }

  console.log(
    `Merged ${nb.toLocaleString()} bookings, ${ns.toLocaleString()} sales transactions` +
    (nc ? `, ${nc.toLocaleString()} customer line items.` : '.') +
    ` Database now holds ${span.n.toLocaleString()} bookings, ${span.lo} to ${span.hi}.`
  );
  if (unknownItems.size) {
    console.log(`\nNOTE: ${unknownItems.size} item(s) are not in products.json and were left unclassified:`);
    for (const u of unknownItems) console.log('  - ' + u);
    console.log('Add them to products.json so they are analysed correctly.');
  }
}

if (require.main === module) main();
module.exports = { parseCsv, money, isoDate };
