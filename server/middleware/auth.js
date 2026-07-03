// middleware/auth.js
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const { query } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const IP_SALT = process.env.IP_SALT || 'dev-salt-change-in-production';

// Attaches req.subject = { type: 'user', key: '<user id>' } or { type: 'guest', key: '<hashed ip>' }
// This runs on every request that needs identity — it NEVER trusts anything the client sends
// about who they are or how many conversions they've used, only the cookie signature and the
// raw connection IP.
async function identify(req, res, next) {
  try {
    const token = req.cookies && req.cookies.session;
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        // A valid signature only proves the token was issued by us at some point — it does
        // NOT prove the account still exists. Without this DB check, a deleted account's
        // token stays fully usable until it naturally expires, up to 30 days later.
        const { rows } = await query('SELECT id, name, email FROM users WHERE id = $1', [payload.uid]);
        if (rows[0]) {
          req.subject = { type: 'user', key: String(payload.uid) };
          req.user = { uid: rows[0].id, name: rows[0].name, email: rows[0].email };
          return next();
        }
        res.clearCookie('session');
      } catch (err) {
        // Invalid/expired token, or a DB hiccup verifying it — fall through to guest
        // identification instead of erroring, so a bad cookie doesn't lock someone out of
        // guest usage entirely.
        res.clearCookie('session');
      }
    }

    const ip = getClientIp(req);
    const hashedIp = crypto.createHash('sha256').update(ip + IP_SALT).digest('hex');
    req.subject = { type: 'guest', key: hashedIp };
    next();
  } catch (err) {
    next(err);
  }
}

function getClientIp(req) {
  // In production behind a real proxy (Render/Railway/Fly), trust X-Forwarded-For only if
  // you've configured Express with `app.set('trust proxy', 1)` — otherwise this header is
  // spoofable by the client and defeats the whole point of IP-based guest limiting.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  next();
}

function issueToken(user) {
  return jwt.sign({ uid: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: '30d',
  });
}

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

module.exports = { identify, requireAuth, issueToken, getClientIp, COOKIE_OPTS, JWT_SECRET };
