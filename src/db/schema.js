const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fleet.db');

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
      active INTEGER DEFAULT 1
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
  `);

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
}

module.exports = { getDb };
