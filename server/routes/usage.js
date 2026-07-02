// routes/usage.js
const express = require('express');
const db = require('../db');

const router = express.Router();

const LIMITS = { guest: 20, user: 50 };

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getLimit(subjectType) {
  return subjectType === 'user' ? LIMITS.user : LIMITS.guest;
}

function getUsageRow(subjectType, subjectKey, date) {
  return db
    .prepare('SELECT count FROM usage WHERE subject_type = ? AND subject_key = ? AND date = ?')
    .get(subjectType, subjectKey, date);
}

// Read-only — used on page load to render "N / limit remaining" without spending a conversion.
router.get('/status', (req, res) => {
  const { type, key } = req.subject;
  const date = todayUTC();
  const limit = getLimit(type);
  const row = getUsageRow(type, key, date);
  const used = row ? row.count : 0;
  res.json({ tier: type, used, limit, remaining: Math.max(0, limit - used) });
});

// The only endpoint that actually spends a conversion. Called by the client right before it
// starts processing a file. Because DatabaseSync is synchronous, this whole read-then-write
// sequence runs as one uninterrupted step of the event loop — no other request for the same
// subject can slip in between the check and the increment, so parallel/rapid-fire requests
// can't sneak past the limit.
router.post('/check-and-increment', (req, res) => {
  const { type, key } = req.subject;
  const date = todayUTC();
  const limit = getLimit(type);

  const row = getUsageRow(type, key, date);
  const used = row ? row.count : 0;

  if (used >= limit) {
    return res.status(429).json({ error: 'Limit reached for today.', tier: type, used, limit, remaining: 0 });
  }

  if (row) {
    db.prepare('UPDATE usage SET count = count + 1 WHERE subject_type = ? AND subject_key = ? AND date = ?').run(
      type,
      key,
      date
    );
  } else {
    db.prepare('INSERT INTO usage (subject_type, subject_key, date, count) VALUES (?, ?, ?, 1)').run(
      type,
      key,
      date
    );
  }

  const newUsed = used + 1;
  res.json({ ok: true, tier: type, used: newUsed, limit, remaining: Math.max(0, limit - newUsed) });
});

module.exports = router;
