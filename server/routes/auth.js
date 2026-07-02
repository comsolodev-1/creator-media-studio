// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { issueToken } = require('../middleware/auth');
const {
  validateEmail,
  validatePassword,
  validateBirthday,
  validateRecoveryKeyphrase,
  validateName,
  normalizeEmail,
  normalizeRecoveryKeyphrase,
} = require('../validation');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 signup/login attempts per IP per 15 min — slows down brute force & signup spam
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

const COOKIE_OPTS = {
  httpOnly: true,       // JS on the page cannot read this — closes the localStorage-style bypass
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

router.post('/signup', authLimiter, (req, res) => {
  const { name, email, password, birthday, recoveryKeyphrase, agreedToTerms } = req.body || {};

  const nameCheck = validateName(name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });

  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

  const birthdayCheck = validateBirthday(birthday);
  if (!birthdayCheck.ok) return res.status(400).json({ error: birthdayCheck.error });

  const recoveryCheck = validateRecoveryKeyphrase(recoveryKeyphrase);
  if (!recoveryCheck.ok) return res.status(400).json({ error: recoveryCheck.error });

  // The disabled submit button on the client is a convenience, not the enforcement — anyone
  // can re-enable a disabled button or call this endpoint directly. This check is the one
  // that actually matters: no account is created without an explicit, recorded agreement.
  if (agreedToTerms !== true) {
    return res.status(400).json({ error: 'You must agree to the Terms of Service to create an account.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailCheck.value);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = bcrypt.hashSync(passwordCheck.value, 12);
  const recoveryHash = bcrypt.hashSync(recoveryCheck.value, 12);
  const createdAt = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO users (name, email, password_hash, birthday, recovery_key_hash, created_at, agreed_to_terms, agreed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nameCheck.value, emailCheck.value, passwordHash, birthdayCheck.value, recoveryHash, createdAt, 1, createdAt);

  const user = { id: result.lastInsertRowid, email: emailCheck.value, name: nameCheck.value };
  const token = issueToken(user);
  res.cookie('session', token, COOKIE_OPTS);
  res.status(201).json({ user: { name: user.name, email: user.email } });
});

router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const normalized = normalizeEmail(email);

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = issueToken(row);
  res.cookie('session', token, COOKIE_OPTS);
  res.json({ user: { name: row.name, email: row.email } });
});

router.post('/recover', authLimiter, (req, res) => {
  const { email, recoveryKeyphrase } = req.body || {};
  const normalized = normalizeEmail(email);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
  if (!row) return res.status(404).json({ error: 'No account found for that email.' });

  const phrase = normalizeRecoveryKeyphrase(recoveryKeyphrase);
  if (!bcrypt.compareSync(phrase, row.recovery_key_hash)) {
    return res.status(401).json({ error: 'Recovery keyphrase does not match.' });
  }

  // A short-lived, single-purpose token — separate from the normal 30-day session token —
  // so keyphrase verification actually leads somewhere instead of just confirming a match and
  // stopping. `purpose` is checked on redemption so this token can't be reused as a session
  // cookie or for anything other than setting a new password.
  const resetToken = jwt.sign({ uid: row.id, purpose: 'password_reset' }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ ok: true, message: 'Keyphrase verified. Set a new password below.', resetToken });
});

router.post('/reset-password', authLimiter, (req, res) => {
  const { resetToken, newPassword } = req.body || {};
  let payload;
  try {
    payload = jwt.verify(resetToken || '', JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'This reset link has expired. Verify your keyphrase again.' });
  }
  if (payload.purpose !== 'password_reset') {
    return res.status(401).json({ error: 'Invalid reset token.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(404).json({ error: 'Account no longer exists.' });

  const passwordCheck = validatePassword(newPassword);
  if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

  // Same reuse protection as the dashboard's "change password" flow — a recovered password
  // shouldn't be a straight reuse of a compromised or previously-abandoned one.
  if (bcrypt.compareSync(passwordCheck.value, user.password_hash)) {
    return res.status(400).json({ error: 'That\u2019s already your current password.' });
  }
  const pastHashes = db.prepare('SELECT password_hash FROM password_history WHERE user_id = ?').all(user.id);
  if (pastHashes.some(r => bcrypt.compareSync(passwordCheck.value, r.password_hash))) {
    return res.status(400).json({ error: 'You\u2019ve used that password before — pick a different one.' });
  }

  db.prepare('INSERT INTO password_history (user_id, password_hash, changed_at) VALUES (?, ?, ?)').run(
    user.id,
    user.password_hash,
    new Date().toISOString()
  );
  const newHash = bcrypt.hashSync(passwordCheck.value, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);

  // Log the user in immediately — they just proved account ownership via the keyphrase and
  // a fresh password, no reason to make them log in again right after.
  const token = issueToken({ id: user.id, email: user.email, name: user.name });
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { name: req.user.name, email: req.user.email } });
});

module.exports = router;