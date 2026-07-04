const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fleet.db');

const DEFAULT_INVOICE_INSTRUCTIONS = `## How to invoice BeCopenhagen

Send one invoice per month, covering all work done **between the 23rd of the previous month and the 22nd of the current month** (both dates included).

---

### Your details (top of the invoice)

- Your full name
- Your address
- Your CVR number, or your CPR number if you don't have a CVR
- Your email

### BeCopenhagen's details

- BeCopenhagen, Fortunstræde 1, 1065 København K, Denmark
- CVR No.: 34 47 85 03
- Email: tours@becopenhagen.dk

---

### Invoice info

- Invoice number (start at 1, increment each month)
- Date of the invoice

---

### Line items — list each type of work separately

- *Guide services* — list each tour date, your hourly rate, and the number of hours. Hours are calculated as tour length + 15 min before + 15 min after (the app's Profile tab shows this automatically).
- *Cancelled tours* — if a tour was cancelled and you are owed a cancellation fee per your agreement, list the date, rate, hours, and the applicable percentage.
- *Training / preparation* — if applicable, agreed as a lump sum.
- *Review commissions* — if applicable, 50 DKK per unit as agreed.

---

### Payment details

- Your full name as account holder
- Bank name
- Registration number (Reg. No.)
- Account number (Acc. No.)
- For international bank accounts: IBAN and BIC/SWIFT instead

**Payment due date:** typically 30 days from the invoice date.

---

### Format

Send as a PDF. You can use Word, Google Docs, or any free invoice tool — what matters is that all the information above is there. Upload it here in the app once it's ready.

---

### Questions?

Contact Paloma at **+45 25 30 33 30** for anything related to invoicing, rates, or your agreement.`;

let db;

function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bike_types (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      fareharbor_resource TEXT,
      rental_value_dkk INTEGER DEFAULT 0,
      demand_level INTEGER DEFAULT 3,
      sort_order INTEGER DEFAULT 99
    );

    CREATE TABLE IF NOT EXISTS bikes (
      id TEXT PRIMARY KEY,
      type_id TEXT NOT NULL REFERENCES bike_types(id),
      name TEXT,
      frame_number TEXT,
      model TEXT,
      frame_size TEXT,
      key_number TEXT,
      gender TEXT,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bike_status (
      bike_id TEXT PRIMARY KEY REFERENCES bikes(id),
      status TEXT NOT NULL DEFAULT 'available',
      assigned_to TEXT,
      assignment_type TEXT,
      fareharbor_booking_ref TEXT,
      customer_name TEXT,
      out_since TEXT,
      return_due TEXT,
      note TEXT,
      location_lat REAL,
      location_lng REAL,
      location_address TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS bike_configurations (
      bike_id TEXT PRIMARY KEY REFERENCES bikes(id),
      has_child_seat INTEGER DEFAULT 0,
      has_toddler_seat INTEGER DEFAULT 0,
      seat_fitted_at TEXT,
      seat_fitted_by TEXT
    );

    CREATE TABLE IF NOT EXISTS batteries (
      id TEXT PRIMARY KEY,
      serial TEXT,
      type TEXT DEFAULT 'standard',
      range_km INTEGER,
      key_number TEXT,
      paired_bike_id TEXT REFERENCES bikes(id),
      status TEXT DEFAULT 'available',
      notes TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      bike_id TEXT,
      battery_id TEXT,
      booking_ref TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repair_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bike_id TEXT NOT NULL REFERENCES bikes(id),
      reported_by TEXT NOT NULL,
      problem TEXT NOT NULL,
      problem_categories TEXT,
      can_rent INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      priority_score REAL DEFAULT 0,
      complexity INTEGER DEFAULT 3,
      estimated_hours REAL,
      started_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fareharbor_booking_ref TEXT,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      booking_date TEXT,
      start_time TEXT,
      end_time TEXT,
      bikes_needed TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      assigned_at TEXT,
      assigned_by TEXT
    );

    CREATE TABLE IF NOT EXISTS assignment_bikes (
      assignment_id INTEGER REFERENCES pending_assignments(id),
      bike_id TEXT REFERENCES bikes(id),
      PRIMARY KEY (assignment_id, bike_id)
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      email TEXT,
      password_hash TEXT,
      password_salt TEXT,
      needs_password_setup INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES team_members(id),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL REFERENCES team_members(id),
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS shop_pin (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      pin_hash TEXT,
      pin_salt TEXT
    );

    CREATE TABLE IF NOT EXISTS bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reported_by TEXT,
      description TEXT NOT NULL,
      page TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repair_priority_weights (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      weight_rental_value REAL DEFAULT 0.3,
      weight_demand REAL DEFAULT 0.25,
      weight_complexity REAL DEFAULT 0.25,
      weight_wait_time REAL DEFAULT 0.2
    );

    INSERT OR IGNORE INTO repair_priority_weights (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS tour_availabilities (
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
    );

    CREATE TABLE IF NOT EXISTS guide_tour_hours (
      availability_id TEXT PRIMARY KEY,
      guide TEXT NOT NULL,
      feed_id TEXT,
      feed_label TEXT,
      start_at TEXT,
      end_at TEXT,
      start_date TEXT,
      duration_minutes INTEGER DEFAULT 0,
      last_synced TEXT
    );

    CREATE TABLE IF NOT EXISTS guide_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guide_id TEXT NOT NULL REFERENCES team_members(id),
      original_filename TEXT,
      stored_filename TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      period_label TEXT,
      note TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS guide_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guide_id TEXT NOT NULL REFERENCES team_members(id),
      review_date TEXT NOT NULL,
      reviewer_name TEXT,
      platform TEXT NOT NULL,
      booking_type TEXT DEFAULT 'Tour',
      review_text TEXT,
      logged_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('guide_invoice_instructions', ?)`)
    .run(DEFAULT_INVOICE_INSTRUCTIONS);

  // Migration: update invoice instructions to current version if still on the original default
  // (i.e. the admin hasn't customised it yet — don't overwrite manual edits)
  const existingInstructions = db.prepare(`SELECT value FROM app_settings WHERE key='guide_invoice_instructions'`).get();
  if (existingInstructions && existingInstructions.value.startsWith('How to invoice BeCopenhagen\n\n1.')) {
    db.prepare(`UPDATE app_settings SET value=?, updated_at=datetime('now'), updated_by='migration' WHERE key='guide_invoice_instructions'`)
      .run(DEFAULT_INVOICE_INSTRUCTIONS);
  }

  // Migrations - update rental values to real prices
  const rentalValues = {A:80,SA:80,AC:80,AT:80,B:80,BM:80,TB:120,MB:80,CC:480,E:240};
  const updType = db.prepare('UPDATE bike_types SET rental_value_dkk=? WHERE id=? AND rental_value_dkk!=?');
  Object.entries(rentalValues).forEach(([id,val]) => updType.run(val,id,val));

  // Migrations - add columns if they don't exist
  const cols = db.prepare("PRAGMA table_info(bike_status)").all().map(c => c.name);
  if (!cols.includes('location_lat')) db.exec("ALTER TABLE bike_status ADD COLUMN location_lat REAL");
  if (!cols.includes('location_lng')) db.exec("ALTER TABLE bike_status ADD COLUMN location_lng REAL");
  if (!cols.includes('location_address')) db.exec("ALTER TABLE bike_status ADD COLUMN location_address TEXT");

  const ticketCols = db.prepare("PRAGMA table_info(repair_tickets)").all().map(c => c.name);
  if (!ticketCols.includes('problem_categories')) db.exec("ALTER TABLE repair_tickets ADD COLUMN problem_categories TEXT");

  // Migration: add auth columns to team_members if missing
  const teamCols = db.prepare("PRAGMA table_info(team_members)").all().map(c => c.name);
  if (!teamCols.includes('email')) db.exec("ALTER TABLE team_members ADD COLUMN email TEXT");
  if (!teamCols.includes('password_hash')) db.exec("ALTER TABLE team_members ADD COLUMN password_hash TEXT");
  if (!teamCols.includes('password_salt')) db.exec("ALTER TABLE team_members ADD COLUMN password_salt TEXT");
  if (!teamCols.includes('needs_password_setup')) db.exec("ALTER TABLE team_members ADD COLUMN needs_password_setup INTEGER DEFAULT 1");
}

module.exports = { getDb };
