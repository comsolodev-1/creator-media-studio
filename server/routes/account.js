// routes/account.js
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, issueToken } = require('../middleware/auth');
const {
  validateName,
  validatePassword,
  validateRecoveryKeyphrase,
  normalizeRecoveryKeyphrase,
} = require('../validation');

const router = express.Router();
router.use(requireAuth);

// ---- Conversion history (read) ----
router.get('/history', (req, res) => {
  const rows = db
    .prepare('SELECT mode, label, filename, created_at FROM conversions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.uid);
  res.json({ history: rows });
});

// Logs a completed conversion for display purposes only — it never affects the usage count,
// which is already locked in by /api/usage/check-and-increment before the conversion runs.
router.post('/history', (req, res) => {
  const { mode, label, filename } = req.body || {};
  if (!mode) return res.status(400).json({ error: 'mode is required' });
  db.prepare('INSERT INTO conversions (user_id, mode, label, filename, created_at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.uid,
    String(mode).slice(0, 40),
    String(label || '').slice(0, 200),
    String(filename || '').slice(0, 200),
    new Date().toISOString()
  );
  res.status(201).json({ ok: true });
});

// ---- Change name (cannot match current or any previously used name) ----
router.post('/name', (req, res) => {
  const nameCheck = validateName(req.body && req.body.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
  const newName = nameCheck.value;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (newName.toLowerCase() === user.name.toLowerCase()) {
    return res.status(400).json({ error: 'That\u2019s already your current name.' });
  }
  const pastNames = db.prepare('SELECT old_name FROM name_history WHERE user_id = ?').all(req.user.uid);
  if (pastNames.some(r => r.old_name.toLowerCase() === newName.toLowerCase())) {
    return res.status(400).json({ error: 'You\u2019ve used that name before — pick a different one.' });
  }

  db.prepare('INSERT INTO name_history (user_id, old_name, changed_at) VALUES (?, ?, ?)').run(
    req.user.uid,
    user.name,
    new Date().toISOString()
  );
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(newName, req.user.uid);

  const token = issueToken({ id: user.id, email: user.email, name: newName });
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, name: newName });
});

// ---- Change password (must not reuse current or any previously used password) ----
router.post('/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);

  if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const passwordCheck = validatePassword(newPassword);
  if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

  if (bcrypt.compareSync(passwordCheck.value, user.password_hash)) {
    return res.status(400).json({ error: 'That\u2019s already your current password.' });
  }
  const pastHashes = db.prepare('SELECT password_hash FROM password_history WHERE user_id = ?').all(req.user.uid);
  if (pastHashes.some(r => bcrypt.compareSync(passwordCheck.value, r.password_hash))) {
    return res.status(400).json({ error: 'You\u2019ve used that password before — pick a different one.' });
  }

  db.prepare('INSERT INTO password_history (user_id, password_hash, changed_at) VALUES (?, ?, ?)').run(
    req.user.uid,
    user.password_hash,
    new Date().toISOString()
  );
  const newHash = bcrypt.hashSync(passwordCheck.value, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.uid);
  res.json({ ok: true });
});

// ---- Change recovery keyphrase (requires current password) ----
router.post('/recovery-keyphrase', (req, res) => {
  const { currentPassword, recoveryKeyphrase } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);

  if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const recoveryCheck = validateRecoveryKeyphrase(recoveryKeyphrase);
  if (!recoveryCheck.ok) return res.status(400).json({ error: recoveryCheck.error });

  const newHash = bcrypt.hashSync(recoveryCheck.value, 12);
  db.prepare('UPDATE users SET recovery_key_hash = ? WHERE id = ?').run(newHash, req.user.uid);
  res.json({ ok: true });
});

// ---- Delete account ----
router.delete('/', (req, res) => {
  const { password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }

  db.prepare('DELETE FROM conversions WHERE user_id = ?').run(req.user.uid);
  db.prepare('DELETE FROM name_history WHERE user_id = ?').run(req.user.uid);
  db.prepare('DELETE FROM password_history WHERE user_id = ?').run(req.user.uid);
  db.prepare('DELETE FROM usage WHERE subject_type = ? AND subject_key = ?').run('user', String(req.user.uid));
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.uid);

  res.clearCookie('session');
  res.json({ ok: true });
});

module.exports = router;
