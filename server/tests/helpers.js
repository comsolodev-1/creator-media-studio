// tests/helpers.js
const app = require('../app');
const db = require('../db');

async function startServer() {
  await db.init();
  await db.query(
    'TRUNCATE users, usage_events, conversions, name_history, password_history RESTART IDENTITY CASCADE'
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    server,
    baseUrl: `http://localhost:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.pool.end();
    },
  };
}

function extractCookie(res) {
  // Per the Fetch spec, Set-Cookie is deliberately hidden from Headers.get() even in Node's
  // own fetch implementation — .get('set-cookie') returns null. getSetCookie() is the actual
  // correct API for reading it (Node 18.14+/20+).
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!cookies.length) return null;
  return cookies[0].split(';')[0];
}

module.exports = { startServer, extractCookie };
