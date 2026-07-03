# Creator Media Studio

A browser-based media converter. Images, video, and GIF conversion all run client-side —
nothing you upload ever touches the server. Accounts are restricted to `@creator.com`
addresses, with server-enforced daily usage limits for both guests and signed-in users.

## Why this exists

Most "free online converter" sites either upload your files to a server (privacy risk, slow,
often ad-funded) or fake their usage limits in a way that's trivial to bypass. This project
does the actual conversion work in your browser using Canvas, MediaRecorder, and a couple of
small JS libraries, and treats the usage limit as a real product constraint enforced
server-side — not a decoration.

## Features

- **Images → Video** — slideshow export to `.webm`, with optional crossfade transitions,
  background music, and a text watermark.
- **Images → GIF** — animated GIF from a set of images.
- **Video → GIF** — clip an uploaded video into an animated GIF.
- **GIF → Images** — decode an animated GIF back into individual `.png` frames, packaged as a
  `.zip`.
- Resolution presets (720p / 1080p / 2K) on every export.
- Guest usage: 20 conversions per rolling 24 hours, tracked by IP (no account required).
- Accounts (`@creator.com` only): 50 conversions per rolling 24 hours, conversion history,
  and account settings (name/password/recovery-keyphrase changes, with reuse protection).
- Password recovery via a recovery keyphrase or an emailed reset link.
- Terms of Service with enforced, recorded agreement at signup.

## Tech stack

- **Backend:** Node.js + Express, Postgres (built for [Neon](https://neon.tech), works with
  any Postgres 13+), bcryptjs, jsonwebtoken, httpOnly cookies, express-rate-limit, nodemailer.
- **Frontend:** Static HTML/CSS/vanilla JS, served by the same Express server — no build step,
  no framework, no CORS to configure. Media processing runs entirely in the browser via
  Canvas, MediaRecorder, `gif.js`, `gifuct-js`, and `JSZip`.

## How it works

**Media conversion is 100% client-side.** The server never receives your images, video, or
GIFs — only a usage count. All encoding happens in the browser via the Canvas and
MediaRecorder APIs.

**Usage limits are enforced server-side, atomically.** Guests are identified by a hashed IP
address (computed server-side — nothing for a browser to spoof or clear). Logged-in users are
identified by a JWT in an httpOnly cookie (invisible to JavaScript, so it can't be read or
forged client-side). Each conversion is checked and counted in a single database operation
using a Postgres advisory lock scoped to that specific guest/user, so the limit holds correctly
even under many simultaneous requests — not just one at a time.

**Accounts require `@creator.com`**, are rate-limited against brute force, and require explicit
recorded agreement to the Terms of Service (checked server-side, not just a disabled button).

## Project layout

```
server/
  app.js                Express app config (routes, middleware)
  server.js              Entry point — loads env, initializes the DB schema, starts listening
  db.js                   Postgres connection, schema, and the concurrency-safe usage-limit logic
  email.js                 Sends password-reset emails; logs them locally if no SMTP is configured
  validation.js             Signup/password/age/email validation rules
  middleware/auth.js         Session handling, guest IP hashing, JWT issuance
  routes/auth.js               signup / login / logout / me / recover / request-reset / reset-password
  routes/usage.js                status (read-only) / check-and-increment (the limit gate)
  routes/account.js               history / name / password / recovery-keyphrase / delete
  tests/                            Automated test suite (node:test)
client/
  index.html              Landing page + converter
  signup.html               @creator.com signup form
  login.html                  Login + keyphrase recovery + email-based reset request
  reset.html                    Page for the emailed reset link
  dashboard.html                 Usage, conversion history, account settings
  terms.html                      Terms of Service & copyright notice
  styles.css                       Shared design system
```

## Running locally

Requires Node 20+ and a Postgres database (local or hosted).

```bash
cd server
cp .env.example .env
# edit .env: set JWT_SECRET, IP_SALT, and DATABASE_URL
npm install
npm start
```

Visit `http://localhost:3000`. `server.js` creates all necessary tables on startup — no
separate migration step.

For local development without a hosted database, point `DATABASE_URL` at any local Postgres
instance. `.env.example` includes a working local default.

## Testing

```bash
cd server
createdb creator_media_studio_test   # or point at any disposable Postgres database
DATABASE_URL=postgres://<connection-string-to-test-db> npm test
```

Runs against a real Postgres database rather than mocks, using Node's built-in test runner.
Covers signup/password/age validation, terms-of-service enforcement, account settings reuse
protection, both password-recovery paths, session invalidation on account deletion, and a
concurrency test that fires many simultaneous requests at the usage limit to confirm it holds
exactly — not just under sequential calls.

## Deploying

Works on any host that runs a persistent Node process (Render, Railway, Fly.io, etc.).

**Database (Neon):**
1. Create a Neon project and copy its connection string from the dashboard.
2. Set it as `DATABASE_URL` in your host's environment variables.
3. Deploy — the schema is created automatically on first boot.

**Required environment variables:**
- `DATABASE_URL` — your Postgres/Neon connection string
- `JWT_SECRET`, `IP_SALT` — long random strings, don't reuse the `.env.example` defaults
- `APP_URL` — your deployed domain (used to build password-reset email links)

**Optional (for real password-reset emails):**
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
- Without these, reset emails are logged to the server console instead of sent — fine for
  development, not for production.

**If deploying behind a reverse proxy** (true of most platforms), uncomment
`app.set('trust proxy', 1)` in `app.js` — otherwise every guest appears to share the proxy's
IP address, breaking the per-guest usage limit.

## Scope and limitations

- **IP-based guest limiting can be reset** by switching networks or using a VPN. This is
  inherent to any limit that doesn't require an account, not a bug — it closes trivial bypasses
  (clearing storage, incognito mode, devtools tampering, request flooding) without requiring
  everyone to sign up just to try the tool.
- **No email verification at signup.** Any `@creator.com`-formatted address is accepted;
  there's no confirmation that the person controls that address.
- **Rate limiting uses in-memory storage**, which is per-process. Fine for a single server
  instance; if scaled to multiple instances behind a load balancer, each instance tracks its
  own counts independently, effectively multiplying the limit by instance count. A shared store
  (e.g. Redis) would be needed at that point.
- **GIF output is capped by the format itself** — 256 colors maximum, a hard limit of the GIF
  spec, not a setting. Video output will always look sharper for the same source material.
- Not load-tested beyond the specific concurrency scenario covered in the test suite.
- No dependency vulnerability scanning, monitoring, or automated backup strategy configured.

## License

Copyright, all rights reserved by the project owner, except for third-party open-source
libraries used under their own respective licenses (`gif.js`, `gifuct-js`, `JSZip`). See
`client/terms.html` for the full Terms of Service and copyright notice shown to users.