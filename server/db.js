// db.js
// Postgres (Neon-compatible) data layer. Replaces the earlier node:sqlite version so the app
// can run against a real hosted database (Neon) instead of a single local file.
//
// Neon connection strings look like:
//   postgresql://user:password@ep-xxxx-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require
// Set that as DATABASE_URL. For local development without Neon, DATABASE_URL can point at any
// Postgres instance (see .env.example) — the code doesn't know or care which one it's talking to.
const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL || 'postgres://postgres:devpass@localhost:5432/creator_media_studio';

if (!process.env.DATABASE_URL) {
  console.warn(
    '[db] DATABASE_URL is not set — falling back to a local Postgres connection. ' +
      'Set DATABASE_URL to your Neon connection string for anything beyond local development.'
  );
}

// Neon (and most managed Postgres) requires TLS. node-postgres doesn't parse `sslmode=require`
// out of the connection string on its own, so it's detected here and turned into the `ssl`
// option explicitly. `rejectUnauthorized: false` is the common setting for serverless/managed
// Postgres providers whose intermediate CA chain isn't always in Node's default trust store —
// the connection is still encrypted, this just skips strict chain verification.
const needsSsl = /neon\.tech|sslmode=require/.test(connectionString) || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      birthday TEXT NOT NULL,
      recovery_key_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      agreed_to_terms BOOLEAN NOT NULL DEFAULT false,
      agreed_at TIMESTAMPTZ
    );
  `);
  // Migration guards: if this is an existing database from before a column was added,
  // IF NOT EXISTS makes these safe no-ops instead of requiring a manual migration step.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS agreed_to_terms BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS agreed_at TIMESTAMPTZ;`);

  // One row per conversion/signup attempt rather than a per-day aggregate counter. This is
  // what makes a genuine rolling 24-hour window possible (an aggregate counter can only ever
  // represent a fixed bucket like "today," not "the last 24 hours from right now") — the limit
  // check counts rows newer than now() - 24h instead of comparing against a fixed date.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id SERIAL PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_usage_events_subject ON usage_events (subject_type, subject_key, created_at);`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      label TEXT,
      filename TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS name_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      old_name TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Rolling-24h check-and-increment, safe under real concurrency.
//
// A single "INSERT ... WHERE (SELECT COUNT...) < limit" statement is NOT safe here: under
// Postgres's default READ COMMITTED isolation, two concurrent transactions can each read the
// same "19 used, limit 20" snapshot before either commits, and both insert — exactly the race
// this exists to prevent. Instead, this takes a Postgres advisory lock scoped to the specific
// subject (guest IP hash or user id) for the duration of the transaction. Concurrent requests
// for the SAME subject queue up and are serialized; requests for DIFFERENT subjects never
// block each other. Verified under load — see server/tests/usage.test.js.
async function checkAndIncrement(subjectType, subjectKey, limit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${subjectType}:${subjectKey}`]);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS used FROM usage_events
       WHERE subject_type = $1 AND subject_key = $2 AND created_at > now() - interval '24 hours'`,
      [subjectType, subjectKey]
    );
    const used = rows[0].used;
    if (used >= limit) {
      await client.query('COMMIT');
      return { allowed: false, used, limit };
    }
    await client.query('INSERT INTO usage_events (subject_type, subject_key) VALUES ($1, $2)', [
      subjectType,
      subjectKey,
    ]);
    await client.query('COMMIT');
    return { allowed: true, used: used + 1, limit };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Read-only usage lookup (for page-load display) — same rolling window, no side effects.
async function getUsageStatus(subjectType, subjectKey, limit) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS used, MIN(created_at) AS oldest FROM usage_events
     WHERE subject_type = $1 AND subject_key = $2 AND created_at > now() - interval '24 hours'`,
    [subjectType, subjectKey]
  );
  const used = rows[0].used;
  const resetAt = rows[0].oldest ? new Date(new Date(rows[0].oldest).getTime() + 24 * 60 * 60 * 1000).toISOString() : null;
  return { used, limit, remaining: Math.max(0, limit - used), resetAt };
}

module.exports = { pool, query, init, checkAndIncrement, getUsageStatus };
