// server.js
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const rateLimit = require('express-rate-limit');

const { identify } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const usageRoutes = require('./routes/usage');
const accountRoutes = require('./routes/account');

const app = express();

// If you deploy behind a reverse proxy (Render/Railway/Fly/Nginx), this MUST be set for
// req.ip to reflect the real client IP via X-Forwarded-For instead of the proxy's own IP —
// otherwise every guest collapses into one bucket (too strict) or the header becomes
// spoofable noise (too loose, defeats the limit). Uncomment when you deploy:
// app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

// Global soft ceiling so no single IP can hammer the API regardless of endpoint.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use('/api/auth', identify, authRoutes);

app.use('/api/usage', identify, usageRoutes);

app.use('/api/account', identify, accountRoutes);

// Serve the client as static files from the same origin — no CORS to configure, and the
// httpOnly cookie works normally since frontend and backend share an origin.
app.use(express.static(path.join(__dirname, '..', 'client')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Creator Media Studio running at http://localhost:${PORT}`);
});
