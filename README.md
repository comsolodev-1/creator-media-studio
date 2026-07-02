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

- **Backend:** Node.js + Express, `node:sqlite` (built into Node 22+, no native compile step),
  bcryptjs, jsonwebtoken, httpOnly cookies, express-rate-limit.
- **Frontend:** Static HTML/CSS/vanilla JS, served by the same Express server (same-origin, so
  no CORS setup needed and the cookie "just works"). Media conversion runs entirely in the
  browser via Canvas, MediaRecorder, and gif.js — no files are ever uploaded anywhere.

## Run it locally

```bash
cd server
cp .env.example .env    # then edit JWT_SECRET and IP_SALT to random strings
npm install
npm start
```

Visit `http://localhost:3000`. The frontend and backend are served from the same origin.

`npm start` runs `node --experimental-sqlite server.js` — the flag is required on Node 22/23;
once you're on a Node version where `node:sqlite` has been unflagged you can drop it.

## Project layout

```
server/
  server.js            Express app, mounts routes, serves client/ as static files
  db.js                 SQLite schema (users, usage tables)
  validation.js          All signup/password/age/email rules — enforced here, not just client-side
  middleware/auth.js     Reads the session cookie, hashes guest IPs, issues JWTs
  routes/auth.js         signup / login / logout / me / recover
  routes/usage.js         status (read-only) / check-and-increment (the actual limit gate)
client/
  index.html              Landing page + converter, calls the usage API before every conversion
  signup.html              @creator.com signup form with live password checklist
  login.html                Login + recovery-keyphrase fallback
  dashboard.html              Usage, conversion history, and account settings (name/password/recovery/delete)
  styles.css                   Shared design system
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

- **Password reset after recovery-keyphrase verification** currently only confirms the
  keyphrase matches; it doesn't yet let the user set a new password from that state.
- Guest usage resets are calendar-day (UTC) based — no rolling 24h window yet.

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

Any host that runs a persistent Node process works — the plan you outlined originally
(Render, Railway, or Fly.io) is a good fit. Two things to set when you deploy:

1. Set real `JWT_SECRET` and `IP_SALT` values (long random strings) as environment variables —
   don't ship the `.env.example` defaults.
2. If you're behind a reverse proxy (which all three of those platforms use), uncomment
   `app.set('trust proxy', 1)` in `server.js` — otherwise every guest will appear to share the
   proxy's IP, and the guest limit will be far too strict (or, if you get this wrong the other
   way, spoofable). This is called out with a comment right above that line.

`data.sqlite` is a single file — back it up like any file, or swap `db.js` for a hosted Postgres
connection later if you outgrow single-file SQLite (the query patterns will translate directly;
only the connection setup changes).
