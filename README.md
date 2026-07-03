# Creator Media Studio — Phase 2

Browser-based image/video/GIF converter with a real, server-enforced usage limit and
`@creator.com`-restricted accounts.

## What's actually enforced here (and how)

The one thing this phase was built to guarantee: **a user cannot bypass their daily
conversion limit**, whether they're a guest or logged in. Specifically:

- The count lives only in `server/data.sqlite`, on the server. The browser never stores it,
  never reports it, and never gets to influence it — every page load asks the server "what's
  my usage?" and gets told, rather than the page telling the server.
- Guests are identified by a **hashed IP address**, computed server-side from the raw TCP
  connection. Clearing localStorage, using incognito, or editing anything in devtools has zero
  effect on this — there's nothing client-side to clear.
- Logged-in users are identified by a JWT in an **httpOnly cookie**, which JavaScript on the
  page cannot read or write. There's no token sitting in localStorage for a script to copy,
  edit, or delete.
- The limit check and the increment happen as one atomic, synchronous database operation
  (`routes/usage.js`), so firing multiple conversions at once (a classic race-condition bypass)
  can't get more than the limit through. This was load-tested: 30 simultaneous requests against
  a limit of 20 produced exactly 20 successes, never more.

**Honest limitation:** IP-based guest tracking can still be reset by switching networks or
using a VPN — that's inherent to *anonymous* rate limiting and true of every app that offers a
no-login free tier. It cannot be fixed without requiring an account (which defeats the point
of a guest tier). What it does close is every *trivial* bypass: clearing storage, incognito
mode, devtools tampering, or spamming requests.

## Stack

- **Backend:** Node.js + Express, **Postgres via `pg`** (Neon-compatible — see below),
  bcryptjs, jsonwebtoken, httpOnly cookies, express-rate-limit, nodemailer.
- **Frontend:** Static HTML/CSS/vanilla JS, served by the same Express server (same-origin, so
  no CORS setup needed and the cookie "just works"). Media conversion runs entirely in the
  browser via Canvas, MediaRecorder, gif.js, gifuct-js, and JSZip — no media files are ever
  uploaded anywhere.

## Database: Neon (Postgres)

The app runs on Postgres. [Neon](https://neon.tech) is a good fit because it's serverless
Postgres with a generous free tier and no server to manage.

1. Create a Neon project and copy its connection string from the dashboard — it looks like:
   `postgresql://user:password@ep-xxxx-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require`
2. Set that as `DATABASE_URL` in `.env` (or your host's environment variables).
3. That's it — `server.js` calls `db.init()` on boot, which creates every table
   (`CREATE TABLE IF NOT EXISTS`) and safely no-ops if they already exist. No separate
   migration step or CLI tool required.

`db.js` doesn't know or care that it's talking to Neon specifically — any Postgres 13+
instance works the same way, which is what local development and the test suite use instead
(see below). SSL is auto-detected from the connection string (`sslmode=require` or a
`neon.tech` host both trigger it) so you don't need to configure that separately.

## Run it locally

```bash
cd server
cp .env.example .env    # then edit JWT_SECRET, IP_SALT, and DATABASE_URL
npm install
npm start
```

Visit `http://localhost:3000`. The frontend and backend are served from the same origin.

For local development without Neon, point `DATABASE_URL` at any local Postgres instance —
`.env.example` includes a working default for `postgres://postgres:devpass@localhost:5432/creator_media_studio`.

## Running the tests

```bash
cd server
createdb creator_media_studio_test   # once, or point at any disposable Postgres database
DATABASE_URL=postgres://postgres:devpass@localhost:5432/creator_media_studio_test npm test
```

Uses Node's built-in test runner (`node --test`) against a real Postgres database — no mocks
for the database layer, since the whole point of several of these tests (especially the
concurrency one) is proving behavior that only shows up against a real database engine. Covers
signup/login validation, terms-of-service enforcement, the recovery-keyphrase whitespace fix,
name/password reuse protection, account deletion invalidating the session, the email-based
reset flow, and — the one that matters most — **40 simultaneous requests against a 20-request
limit resolving to exactly 20 successes**, proving the advisory-lock approach in
`checkAndIncrement` actually holds under real concurrency and not just sequential calls.

## Project layout

```
server/
  app.js                 Express app config (routes, middleware) — exported, doesn't listen
  server.js               Entry point: loads env, initializes the DB schema, starts listening
  db.js                    Postgres/Neon connection, schema, and the concurrency-safe usage-limit logic
  email.js                  Sends password-reset emails; logs them locally when no SMTP is configured
  validation.js             All signup/password/age/email rules — enforced here, not just client-side
  middleware/auth.js         Reads the session cookie, hashes guest IPs, issues JWTs
  routes/auth.js              signup / login / logout / me / recover / request-reset / reset-password
  routes/usage.js               status (read-only) / check-and-increment (the actual limit gate)
  routes/account.js              history / name / password / recovery-keyphrase / delete
  tests/                          node:test suite — validation unit tests + live API integration tests
client/
  index.html              Landing page + converter (4 modes), calls the usage API before every conversion
  signup.html               @creator.com signup form with live password checklist + terms agreement
  login.html                  Login + keyphrase recovery + email-based reset request
  reset.html                    Standalone page for the emailed reset link
  dashboard.html                 Usage, conversion history, and account settings
  terms.html                      Terms of Service & copyright notice
  styles.css                       Shared design system
```

## A bug that was caught and fixed during testing

Early testing of account deletion revealed that JWTs are stateless: verifying a token's
signature only proves it was issued by the server at some point, not that the account it
points to still exists. Deleting a user from the database didn't invalidate their existing
session token — it stayed usable (with full account access) until it naturally expired, up
to 30 days later. `middleware/auth.js` now re-checks the database on every request that reads
the session cookie, not just the signature, closing that gap. Confirmed with a live test:
deleting an account and then re-using the old cookie now correctly falls back to guest tier.

## What's still a stub (next phases)

- Guest usage resets are calendar-day (UTC) based — no rolling 24h window yet.

## Phase 5: real bugs found and fixed

Two things reported as broken turned out to be real, verified bugs — not just missing
features:

- **Recovery keyphrase "doesn't match" even when it's right.** Root cause:
  `normalizeRecoveryKeyphrase` only trimmed leading/trailing whitespace, not internal runs. A
  multi-word keyphrase typed with a different number of spaces between words at recovery time
  than at signup time (e.g. "my recovery phrase" vs "my  recovery   phrase") would hash
  differently and never match, even though it's the same phrase to a person. Fixed by
  collapsing all internal whitespace to single spaces during normalization, on both signup and
  recovery. Verified with a live test using deliberately mismatched spacing.
- **The recovery flow was a genuine dead end.** Keyphrase verification only confirmed a match
  and displayed a message — there was no actual way to set a new password afterward, and no
  way to navigate back to the login form once you'd clicked "Forgot password?" (an accessibility
  gap: no keyboard/focus path back). Both fixed: verification now issues a short-lived (10
  minute), single-purpose JWT that unlocks a real "set new password" step (with the same reuse
  protection as the dashboard's password change), and every recovery-related card has an
  explicit, focusable "← Back to login" button. Full flow — signup → recover with mismatched
  whitespace → verify → set new password → confirm old password no longer works → confirm new
  password logs in — tested live end-to-end.

## Phase 4: quality fixes, GIF→Images, and Terms of Service

- **Fixed the actual cause of pixelated/low-res output.** Canvas dimensions used to be capped
  at the source images' native pixel size with no floor — small source images produced small
  output, no matter what, and could even mix the width of one image with the height of another.
  All three conversion modes now use real resolution presets (720p / 1080p / 2K) applied as the
  long edge, and upscale small sources to hit the target instead of just outputting native size.
- **Fixed WebM playback issues.** Switched MediaRecorder's codec preference to VP8 first — VP9
  canvas-capture recording has known real-world corruption bugs in some Chromium versions
  (plays in the browser that made it, fails or glitches elsewhere, VLC included). Also fixed a
  second bug where stopping the recorder immediately after the last frame could cut off before
  the capture stream had actually sampled it; the recorder now holds and flushes the final
  frame before stopping.
- **Added a GIF quality explainer banner.** GIF output modes now show an inline note that GIF's
  256-color palette is a hard format limit (not a setting we can raise), and that video will
  look sharper for the same source whenever GIF's auto-play-anywhere property isn't specifically
  needed.
- **Built GIF → Images**, the previously-stubbed fourth mode. Decodes an uploaded animated GIF
  frame-by-frame client-side (`gifuct-js`), correctly composites each frame per its disposal
  method (GIF frames are stored as deltas, not full images — naively drawing each frame's patch
  alone would produce broken/ghosted output), and packages the result as a downloadable `.zip`
  of `.png` files (`JSZip`). Both libraries run entirely in the browser; no files are uploaded.
- **Added Terms of Service, copyright notice, and enforced agreement at signup**
  (`client/terms.html`). The signup form disables the submit button until the agreement
  checkbox is checked, but that's UX only — the actual enforcement is server-side: `POST
  /api/auth/signup` returns 400 and refuses to create the account unless `agreedToTerms: true`
  is explicitly present in the request body (verified live: omitting it, or sending `false`,
  both correctly fail; a disabled button alone would be trivially bypassable by calling the API
  directly). Each acceptance is recorded with a timestamp in the `users` table
  (`agreed_to_terms`, `agreed_at`) — confirmed present in the database after signup. Copyright
  notice and a link to the Terms page were added to the footer of every page.

## Deploying

Any host that runs a persistent Node process works (Render, Railway, Fly.io). Set these
environment variables:

1. `DATABASE_URL` — your Neon connection string (see above).
2. Real `JWT_SECRET` and `IP_SALT` values (long random strings) — don't ship the
   `.env.example` defaults.
3. `APP_URL` — your deployed domain, used to build the link inside password-reset emails.
   Falls back to the request's own host if unset, which is fine for local dev but should be
   set explicitly once deployed.
4. `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` — real SMTP credentials
   once you have a provider. Without these, password-reset emails are logged to the server
   console instead of sent (see `server/email.js`) — fine for development, not for production.
5. If you're behind a reverse proxy (which all three of those platforms use), uncomment
   `app.set('trust proxy', 1)` in `app.js` — otherwise every guest will appear to share the
   proxy's IP, and the guest limit will be far too strict (or, if you get this wrong the other
   way, spoofable). This is called out with a comment right above that line.

**A note on the rate limiters:** `express-rate-limit`'s default in-memory store means limits
are per-process and reset on restart/redeploy. That's fine for a single instance, but if you
ever scale to multiple server instances behind a load balancer, each instance tracks its own
counts independently — the actual enforced limit becomes (per-instance limit × instance
count). Worth switching to a shared store (e.g. `rate-limit-redis`) if/when that happens; not
needed for a single instance.

## Phase 6: Neon/Postgres migration, rolling limits, email reset, tests, and polish

- **Migrated the database from local SQLite to Postgres, built for Neon.** Every route that
  touched the database was rewritten from synchronous SQLite calls to async Postgres queries.
  This was tested against a real local Postgres instance rather than assumed correct — Neon's
  cloud endpoint isn't reachable from this build environment's network, but the wire protocol
  and SQL are identical, so local Postgres is a faithful stand-in for verifying correctness.
- **Usage limit is now a genuine rolling 24-hour window**, not a calendar-day reset. This
  required a real design change, not just a query tweak: a per-day aggregate counter can only
  ever represent a fixed bucket like "today," so the schema moved to one row per conversion
  (`usage_events`) and counts rows newer than `now() - interval '24 hours'`.
- **That rolling-window check had to be re-proven safe under concurrency on Postgres
  specifically.** The SQLite version relied on Node being single-threaded for its atomicity
  guarantee; that guarantee doesn't carry over to Postgres, where a naive
  "SELECT COUNT... THEN INSERT" is genuinely racy under the default READ COMMITTED isolation
  level. Fixed using a Postgres advisory lock scoped to each individual guest/user, verified
  with a live concurrency test: 40 simultaneous requests against a limit of 20 resolve to
  exactly 20 successes, both via a manual load test and as a permanent regression test in the
  automated suite.
- **Added dedicated rate limiting** on the usage and account routers, separate from the global
  server-wide limiter — the daily conversion cap doesn't stop someone from hammering
  `/check-and-increment` or the dashboard endpoints far faster than any real usage pattern
  would, burning server resources long before ever hitting the daily limit.
- **Added a second password-recovery path: email.** Alongside the existing recovery-keyphrase
  flow, `request-reset` sends a 10-minute link to the account's email (real SMTP when
  configured, logged locally otherwise) that lands on the new `reset.html` page. Both recovery
  paths redeem the exact same short-lived, single-purpose JWT via `reset-password` — the
  keyphrase and the email link are just two different ways of proving you own the account, not
  two different reset mechanisms. The response is intentionally identical whether or not the
  email has an account, to avoid leaking which addresses are registered.
- **Built an automated test suite** (`node --test`) — 27 tests covering signup/password/age
  validation, terms-of-service enforcement (including the "missing vs explicitly false"
  distinction), the recovery whitespace-normalization fix as a permanent regression test, name/
  password reuse protection, deleted-account session invalidation as a permanent regression
  test, both recovery paths end-to-end, and the concurrency test described above. Two real bugs
  were caught and fixed *while writing these tests*, not before: Node's `fetch` hides
  `Set-Cookie` behind `getSetCookie()` rather than `.get()` (a test-code bug, not an app bug,
  but one that silently made every "authenticated" test request unauthenticated until fixed),
  and the auth rate limiter's production-appropriate 20-requests/15-min limit was too tight for
  the full test suite's legitimate request volume — fixed by making it configurable via env
  rather than either weakening it in production or leaving the suite flaky.
- **Added creative/polish features to Images → Video**: crossfade transitions between images
  (rendered as live alpha-blended frames, not a fixed cut), optional background music mixed
  into the exported WebM's audio track via the source `<audio>` element's `captureStream()`,
  and an optional text watermark (also available on both GIF-output modes) with a
  corner-position picker.
