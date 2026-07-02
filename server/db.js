// db.js
// Uses Node's built-in `node:sqlite` (stable since Node 22, run with --experimental-sqlite
// until your Node version unflags it). No native compilation, no extra binary — the
// database file lives on disk at server/data.sqlite and survives restarts.
//
// IMPORTANT: DatabaseSync is synchronous. That's deliberate. Because Node is single-threaded
// and these calls never yield to the event loop mid-operation, a "check usage, then increment
// usage" sequence for the same request can't be interleaved by a second concurrent request.
// That's what actually closes the race-condition bypass (firing two conversions at once to
// sneak past the limit) — not a specific SQL trick.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    birthday TEXT NOT NULL,
    recovery_key_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    agreed_to_terms INTEGER NOT NULL DEFAULT 0,
    agreed_at TEXT
  );
`);

// Migration guard: if data.sqlite already existed from before these columns were added,
// CREATE TABLE IF NOT EXISTS is a no-op and the columns above are silently skipped. Add them
// here if missing so upgrading an existing deployment doesn't require a manual migration step.
try {
  db.exec(`ALTER TABLE users ADD COLUMN agreed_to_terms INTEGER NOT NULL DEFAULT 0`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN agreed_at TEXT`);
} catch (e) { /* column already exists */ }

db.exec(`

  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_type TEXT NOT NULL,   -- 'user' | 'guest'
    subject_key TEXT NOT NULL,    -- user id as string, or hashed IP for guests
    date TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
    count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(subject_type, subject_key, date)
  );

  CREATE TABLE IF NOT EXISTS conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    label TEXT,
    filename TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS name_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    old_name TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    password_hash TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
`);

module.exports = db;
