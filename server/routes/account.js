// routes/account.js
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { requireAuth, issueToken, COOKIE_OPTS } = require('../middleware/auth');
const { validateName, validatePassword, validateRecoveryKeyphrase } = require('../validation');

const router = express.Router();

// Same reasoning as the usage router's limiter: the daily conversion cap doesn't cover
// dashboard actions (history writes, settings changes), so those get their own bound —
// generous enough for normal use, tight enough to blunt scripted abuse.
const accountLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
});
router.use(accountLimiter);
router.use(requireAuth);

// ---- Conversion history (read) ----
router.get('/history', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT mode, label, filename, created_at FROM conversions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.uid]
    );
    res.json({ history: result.rows });
  } catch (err) {
    next(err);
  }
});

// Logs a completed conversion for display purposes only — it never affects the usage count,
// which is already locked in by /api/usage/check-and-increment before the conversion runs.
router.post('/history', async (req, res, next) => {
  try {
    const { mode, label, filename } = req.body || {};
    if (!mode) return res.status(400).json({ error: 'mode is required' });
    await query(
      'INSERT INTO conversions (user_id, mode, label, filename, created_at) VALUES ($1, $2, $3, $4, $5)',
      [req.user.uid, String(mode).slice(0, 40), String(label || '').slice(0, 200), String(filename || '').slice(0, 200), new Date().toISOString()]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Change name (cannot match current or any previously used name) ----
router.post('/name', async (req, res, next) => {
  try {
    const nameCheck = validateName(req.body && req.body.name);
    if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
    const newName = nameCheck.value;

    const result = await query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
    const user = result.rows[0];
    if (newName.toLowerCase() === user.name.toLowerCase()) {
      return res.status(400).json({ error: 'That\u2019s already your current name.' });
    }
    const pastNames = await query('SELECT old_name FROM name_history WHERE user_id = $1', [req.user.uid]);
    if (pastNames.rows.some((r) => r.old_name.toLowerCase() === newName.toLowerCase())) {
      return res.status(400).json({ error: 'You\u2019ve used that name before — pick a different one.' });
    }

    await query('INSERT INTO name_history (user_id, old_name, changed_at) VALUES ($1, $2, $3)', [
      req.user.uid,
      user.name,
      new Date().toISOString(),
    ]);
    await query('UPDATE users SET name = $1 WHERE id = $2', [newName, req.user.uid]);

    const token = issueToken({ id: user.id, email: user.email, name: newName });
    res.cookie('session', token, COOKIE_OPTS);
    res.json({ ok: true, name: newName });
  } catch (err) {
    next(err);
  }
});

// ---- Change password (must not reuse current or any previously used password) ----
router.post('/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const result = await query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
    const user = result.rows[0];

    if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

    if (bcrypt.compareSync(passwordCheck.value, user.password_hash)) {
      return res.status(400).json({ error: 'That\u2019s already your current password.' });
    }
    const pastHashes = await query('SELECT password_hash FROM password_history WHERE user_id = $1', [req.user.uid]);
    if (pastHashes.rows.some((r) => bcrypt.compareSync(passwordCheck.value, r.password_hash))) {
      return res.status(400).json({ error: 'You\u2019ve used that password before — pick a different one.' });
    }

    await query('INSERT INTO password_history (user_id, password_hash, changed_at) VALUES ($1, $2, $3)', [
      req.user.uid,
      user.password_hash,
      new Date().toISOString(),
    ]);
    const newHash = bcrypt.hashSync(passwordCheck.value, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.uid]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Change recovery keyphrase (requires current password) ----
router.post('/recovery-keyphrase', async (req, res, next) => {
  try {
    const { currentPassword, recoveryKeyphrase } = req.body || {};
    const result = await query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
    const user = result.rows[0];

    if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const recoveryCheck = validateRecoveryKeyphrase(recoveryKeyphrase);
    if (!recoveryCheck.ok) return res.status(400).json({ error: recoveryCheck.error });

    const newHash = bcrypt.hashSync(recoveryCheck.value, 12);
    await query('UPDATE users SET recovery_key_hash = $1 WHERE id = $2', [newHash, req.user.uid]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Delete account ----
// users.id is the parent of conversions/name_history/password_history via ON DELETE CASCADE,
// so deleting the user row cleans those up automatically. usage_events is intentionally NOT a
// foreign-key child (subject_key is a loosely-typed string, shared with guest IP hashes in the
// same table) so it needs an explicit cleanup query.
router.delete('/', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    const result = await query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
    const user = result.rows[0];
    if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Password is incorrect.' });
    }

    await query('DELETE FROM usage_events WHERE subject_type = $1 AND subject_key = $2', ['user', String(req.user.uid)]);
    await query('DELETE FROM users WHERE id = $1', [req.user.uid]);

    res.clearCookie('session');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
