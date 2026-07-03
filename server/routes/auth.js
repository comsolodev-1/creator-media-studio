// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { issueToken, COOKIE_OPTS, JWT_SECRET } = require('../middleware/auth');
const { sendMail, getLastDevEmail, isDevMode } = require('../email');
const {
  validateEmail,
  validatePassword,
  validateBirthday,
  validateRecoveryKeyphrase,
  validateName,
  normalizeEmail,
  normalizeRecoveryKeyphrase,
} = require('../validation');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 20/15min by default in production. The full test suite makes many more than 20 auth
  // requests in a single 15-minute window across all its cases — legitimately, not as abuse —
  // so it's overridden via env for test runs only; production behavior is unchanged.
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

router.post('/signup', authLimiter, async (req, res, next) => {
  try {
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

    // The disabled submit button on the client is a convenience, not the enforcement —
    // anyone can re-enable a disabled button or call this endpoint directly. This is the
    // check that actually matters: no account is created without explicit, recorded consent.
    if (agreedToTerms !== true) {
      return res.status(400).json({ error: 'You must agree to the Terms of Service to create an account.' });
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [emailCheck.value]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = bcrypt.hashSync(passwordCheck.value, 12);
    const recoveryHash = bcrypt.hashSync(recoveryCheck.value, 12);
    const now = new Date().toISOString();

    const result = await query(
      `INSERT INTO users (name, email, password_hash, birthday, recovery_key_hash, created_at, agreed_to_terms, agreed_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $6)
       RETURNING id`,
      [nameCheck.value, emailCheck.value, passwordHash, birthdayCheck.value, recoveryHash, now]
    );

    const user = { id: result.rows[0].id, email: emailCheck.value, name: nameCheck.value };
    const token = issueToken(user);
    res.cookie('session', token, COOKIE_OPTS);
    res.status(201).json({ user: { name: user.name, email: user.email } });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const normalized = normalizeEmail(email);

    const result = await query('SELECT * FROM users WHERE email = $1', [normalized]);
    const row = result.rows[0];
    if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = issueToken(row);
    res.cookie('session', token, COOKIE_OPTS);
    res.json({ user: { name: row.name, email: row.email } });
  } catch (err) {
    next(err);
  }
});

// ---- Recovery path 1: keyphrase ----
router.post('/recover', authLimiter, async (req, res, next) => {
  try {
    const { email, recoveryKeyphrase } = req.body || {};
    const normalized = normalizeEmail(email);
    const result = await query('SELECT * FROM users WHERE email = $1', [normalized]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'No account found for that email.' });

    const phrase = normalizeRecoveryKeyphrase(recoveryKeyphrase);
    if (!bcrypt.compareSync(phrase, row.recovery_key_hash)) {
      return res.status(401).json({ error: 'Recovery keyphrase does not match.' });
    }

    // Short-lived, single-purpose token — separate from the normal 30-day session token — so
    // verification actually leads somewhere instead of just confirming a match and stopping.
    const resetToken = jwt.sign({ uid: row.id, purpose: 'password_reset' }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ ok: true, message: 'Keyphrase verified. Set a new password below.', resetToken });
  } catch (err) {
    next(err);
  }
});

// ---- Recovery path 2: email link ----
router.post('/request-reset', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const normalized = normalizeEmail(email);
    const result = await query('SELECT * FROM users WHERE email = $1', [normalized]);
    const row = result.rows[0];

    // Always return the same generic response whether or not the account exists — a
    // different response for "no such account" vs "email sent" lets someone enumerate which
    // @creator.com addresses have accounts just by trying them.
    const genericResponse = {
      ok: true,
      message: 'If an account exists for that email, a reset link has been sent.',
      devMode: isDevMode(),
    };

    if (!row) return res.json(genericResponse);

    const resetToken = jwt.sign({ uid: row.id, purpose: 'password_reset' }, JWT_SECRET, { expiresIn: '10m' });
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const resetLink = `${appUrl}/reset.html?token=${resetToken}`;

    await sendMail({
      to: row.email,
      subject: 'Reset your Creator Media Studio password',
      text: `Someone requested a password reset for this account. Reset it here (expires in 10 minutes): ${resetLink}\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>Someone requested a password reset for this account.</p><p><a href="${resetLink}">Reset your password</a> (expires in 10 minutes)</p><p>If you didn't request this, you can ignore this email.</p>`,
    });

    res.json(genericResponse);
  } catch (err) {
    next(err);
  }
});

// Dev-only: lets the reset-via-email flow be tested without a real SMTP provider or inbox.
// Automatically disabled the instant SMTP_HOST is set (see email.js) — there is no
// configuration path that leaves this reachable in a real deployment with real email sending.
router.get('/_dev/last-email', (req, res) => {
  if (!isDevMode()) return res.status(404).json({ error: 'Not available.' });
  const email = getLastDevEmail();
  if (!email) return res.status(404).json({ error: 'No dev email sent yet.' });
  res.json(email);
});

// Shared by both recovery paths — a keyphrase-verified token and an email-link token are the
// same shape and are redeemed the same way.
router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { resetToken, newPassword } = req.body || {};
    let payload;
    try {
      payload = jwt.verify(resetToken || '', JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'This reset link has expired. Request a new one.' });
    }
    if (payload.purpose !== 'password_reset') {
      return res.status(401).json({ error: 'Invalid reset token.' });
    }

    const result = await query('SELECT * FROM users WHERE id = $1', [payload.uid]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Account no longer exists.' });

    const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

    if (bcrypt.compareSync(passwordCheck.value, user.password_hash)) {
      return res.status(400).json({ error: 'That\u2019s already your current password.' });
    }
    const pastHashes = await query('SELECT password_hash FROM password_history WHERE user_id = $1', [user.id]);
    if (pastHashes.rows.some((r) => bcrypt.compareSync(passwordCheck.value, r.password_hash))) {
      return res.status(400).json({ error: 'You\u2019ve used that password before — pick a different one.' });
    }

    await query('INSERT INTO password_history (user_id, password_hash, changed_at) VALUES ($1, $2, $3)', [
      user.id,
      user.password_hash,
      new Date().toISOString(),
    ]);
    const newHash = bcrypt.hashSync(passwordCheck.value, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

    // Log the user in immediately — they just proved account ownership, no reason to make
    // them log in again right after.
    const token = issueToken({ id: user.id, email: user.email, name: user.name });
    res.cookie('session', token, COOKIE_OPTS);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
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
