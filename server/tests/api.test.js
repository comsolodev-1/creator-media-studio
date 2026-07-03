// tests/api.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const { startServer, extractCookie } = require('./helpers');

let ctx;

before(async () => {
  ctx = await startServer();
});

after(async () => {
  await ctx.close();
});

async function signup(overrides = {}) {
  const body = {
    name: 'Test User',
    email: `user${Date.now()}${Math.random().toString(36).slice(2)}@creator.com`,
    password: 'Str0ng!Pass1',
    birthday: '1995-01-01',
    recoveryKeyphrase: 'a decent recovery phrase',
    agreedToTerms: true,
    ...overrides,
  };
  const res = await fetch(`${ctx.baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { res, data, body, cookie: extractCookie(res) };
}

test('signup rejects non-@creator.com email', async () => {
  const { res, data } = await signup({ email: 'someone@gmail.com' });
  assert.equal(res.status, 400);
  assert.match(data.error, /@creator\.com/);
});

test('signup rejects weak password', async () => {
  const { res } = await signup({ password: 'weak' });
  assert.equal(res.status, 400);
});

test('signup rejects under-13 birthday', async () => {
  const tooYoung = new Date();
  tooYoung.setFullYear(tooYoung.getFullYear() - 5);
  const { res } = await signup({ birthday: tooYoung.toISOString().slice(0, 10) });
  assert.equal(res.status, 400);
});

test('signup is rejected without explicit terms agreement', async () => {
  const { res, data } = await signup({ agreedToTerms: false });
  assert.equal(res.status, 400);
  assert.match(data.error, /Terms of Service/);
});

test('signup is rejected when agreedToTerms is simply missing', async () => {
  const email = `noterm${Date.now()}@creator.com`;
  const res = await fetch(`${ctx.baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test',
      email,
      password: 'Str0ng!Pass1',
      birthday: '1995-01-01',
      recoveryKeyphrase: 'phrase here',
      // agreedToTerms intentionally omitted
    }),
  });
  assert.equal(res.status, 400);
});

test('signup succeeds with valid data and agreement, sets a session cookie', async () => {
  const { res, data, cookie } = await signup();
  assert.equal(res.status, 201);
  assert.equal(data.user.name, 'Test User');
  assert.ok(cookie, 'expected a session cookie to be set');
});

test('duplicate email is rejected', async () => {
  const email = `dup${Date.now()}@creator.com`;
  const first = await signup({ email });
  assert.equal(first.res.status, 201);
  const second = await signup({ email });
  assert.equal(second.res.status, 409);
});

test('login works with correct credentials and fails with wrong password', async () => {
  const email = `login${Date.now()}@creator.com`;
  const password = 'Str0ng!Pass1';
  await signup({ email, password });

  const good = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(good.status, 200);

  const bad = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong password' }),
  });
  assert.equal(bad.status, 401);
});

test('deleted account cookie no longer authenticates (session invalidation regression)', async () => {
  const email = `del${Date.now()}@creator.com`;
  const password = 'Str0ng!Pass1';
  const { cookie } = await signup({ email, password });

  const meBefore = await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  const meBeforeData = await meBefore.json();
  assert.ok(meBeforeData.user);

  const del = await fetch(`${ctx.baseUrl}/api/account`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password }),
  });
  assert.equal(del.status, 200);

  const meAfter = await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  const meAfterData = await meAfter.json();
  assert.equal(meAfterData.user, null, 'old cookie must not authenticate after account deletion');
});

test('recovery keyphrase matches despite different internal whitespace (regression)', async () => {
  const email = `recov${Date.now()}@creator.com`;
  await signup({ email, recoveryKeyphrase: 'my recovery phrase' });

  const res = await fetch(`${ctx.baseUrl}/api/auth/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, recoveryKeyphrase: 'my    recovery     phrase' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.ok(data.resetToken);
});

test('recovery + reset-password full flow logs the user in with the new password', async () => {
  const email = `full${Date.now()}@creator.com`;
  await signup({ email, recoveryKeyphrase: 'recovery words' });

  const recoverRes = await fetch(`${ctx.baseUrl}/api/auth/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, recoveryKeyphrase: 'recovery words' }),
  });
  const { resetToken } = await recoverRes.json();

  const resetRes = await fetch(`${ctx.baseUrl}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resetToken, newPassword: 'BrandNew1!Pass' }),
  });
  assert.equal(resetRes.status, 200);

  const loginRes = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'BrandNew1!Pass' }),
  });
  assert.equal(loginRes.status, 200);
});

test('email-based reset request never reveals whether an account exists', async () => {
  const email = `exists${Date.now()}@creator.com`;
  await signup({ email });

  const existsRes = await fetch(`${ctx.baseUrl}/api/auth/request-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const notExistsRes = await fetch(`${ctx.baseUrl}/api/auth/request-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'definitely-nobody-here@creator.com' }),
  });
  const existsData = await existsRes.json();
  const notExistsData = await notExistsRes.json();
  assert.equal(existsRes.status, notExistsRes.status);
  assert.equal(existsData.message, notExistsData.message);
});

test('name change rejects reuse of current or previous name', async () => {
  const email = `name${Date.now()}@creator.com`;
  const { cookie } = await signup({ email, name: 'Original Name' });

  const change1 = await fetch(`${ctx.baseUrl}/api/account/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'New Name' }),
  });
  assert.equal(change1.status, 200);

  const revert = await fetch(`${ctx.baseUrl}/api/account/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Original Name' }),
  });
  assert.equal(revert.status, 400);
});

test('password change rejects reuse of current or previous password', async () => {
  const email = `pw${Date.now()}@creator.com`;
  const originalPassword = 'Str0ng!Pass1';
  const { cookie } = await signup({ email, password: originalPassword });

  const change1 = await fetch(`${ctx.baseUrl}/api/account/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPassword: originalPassword, newPassword: 'NewOne1!Pass' }),
  });
  assert.equal(change1.status, 200);

  const revert = await fetch(`${ctx.baseUrl}/api/account/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ currentPassword: 'NewOne1!Pass', newPassword: originalPassword }),
  });
  assert.equal(revert.status, 400);
});

test('account routes require authentication', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/account/history`);
  assert.equal(res.status, 401);
});

test('guest usage status returns rolling-window shape', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/usage/status`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.tier, 'guest');
  assert.equal(data.limit, 20);
  assert.ok('remaining' in data);
  assert.ok('resetAt' in data);
});

test('usage and account routers carry their own rate-limit headers, not just the global one', async () => {
  const usageRes = await fetch(`${ctx.baseUrl}/api/usage/status`);
  const usageHeaderKeys = [...usageRes.headers.keys()].join(',').toLowerCase();
  assert.match(usageHeaderKeys, /ratelimit/);

  const { cookie } = await signup({ email: `rl${Date.now()}@creator.com` });
  const accountRes = await fetch(`${ctx.baseUrl}/api/account/history`, { headers: { Cookie: cookie } });
  const accountHeaderKeys = [...accountRes.headers.keys()].join(',').toLowerCase();
  assert.match(accountHeaderKeys, /ratelimit/);
});
