// tests/usage-concurrency.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const { startServer } = require('./helpers');

let ctx;

before(async () => {
  ctx = await startServer();
});

after(async () => {
  await ctx.close();
});

test('guest limit holds exactly under real concurrent load (no overshoot)', async () => {
  // 40 simultaneous requests against a limit of 20. If the advisory-lock approach in
  // db.js's checkAndIncrement were broken (e.g. reverted to a bare SELECT-then-INSERT), this
  // is the test that would catch it — a race condition only shows up under genuine
  // concurrency, not sequential calls.
  const requests = Array.from({ length: 40 }, () =>
    fetch(`${ctx.baseUrl}/api/usage/check-and-increment`, { method: 'POST' }).then((r) => r.json())
  );
  const results = await Promise.all(requests);

  const succeeded = results.filter((r) => r.ok === true).length;
  const rejected = results.filter((r) => r.error).length;

  assert.equal(succeeded, 20, 'exactly 20 of 40 concurrent requests should succeed');
  assert.equal(rejected, 20);

  const statusRes = await fetch(`${ctx.baseUrl}/api/usage/status`);
  const status = await statusRes.json();
  assert.equal(status.used, 20);
  assert.equal(status.remaining, 0);
});
