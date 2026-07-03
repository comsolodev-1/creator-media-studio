// routes/usage.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkAndIncrement, getUsageStatus } = require('../db');

const router = express.Router();

const LIMITS = { guest: 20, user: 50 };
function getLimit(subjectType) {
  return subjectType === 'user' ? LIMITS.user : LIMITS.guest;
}

// Dedicated rate limit for this router, separate from the global server-wide one. The daily
// usage cap (20 or 50) already bounds how many conversions can succeed, but nothing was
// stopping someone from hammering /check-and-increment far faster than any real conversion
// flow would — each hit still costs a DB round-trip and an advisory lock acquisition, so an
// abusive client could burn server resources long before ever hitting the daily limit, or use
// rapid polling of /status to probe for account/guest activity. 60/minute comfortably covers
// legitimate use (the client only calls this once per real conversion, plus one /status call
// per page load) while capping abuse.
const usageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
});
router.use(usageLimiter);

// Read-only — used on page load to render "N / limit remaining" without spending a conversion.
router.get('/status', async (req, res, next) => {
  try {
    const { type, key } = req.subject;
    const limit = getLimit(type);
    const status = await getUsageStatus(type, key, limit);
    res.json({ tier: type, ...status });
  } catch (err) {
    next(err);
  }
});

// The only endpoint that actually spends a conversion. See db.js's checkAndIncrement for how
// this stays correct under real concurrency (Postgres advisory locks, not a bare SELECT-then-
// INSERT which would be racy under READ COMMITTED isolation).
router.post('/check-and-increment', async (req, res, next) => {
  try {
    const { type, key } = req.subject;
    const limit = getLimit(type);
    const result = await checkAndIncrement(type, key, limit);
    if (!result.allowed) {
      return res
        .status(429)
        .json({ error: 'Limit reached for the last 24 hours.', tier: type, used: result.used, limit, remaining: 0 });
    }
    res.json({
      ok: true,
      tier: type,
      used: result.used,
      limit,
      remaining: Math.max(0, limit - result.used),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
