// test/health.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

test('GET /api/health returns ok: true', async () => {
  const app = createApp({});
  const server = app.listen(0);
  const { port } = server.address();
  const { status, body } = await getJson(port, '/api/health');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { ok: true });
  server.close();
});
