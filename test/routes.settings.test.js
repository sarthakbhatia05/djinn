// test/routes.settings.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { createSettingsStore } = require('../server/lib/settingsStore');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: 'localhost', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeApp() {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-route-')), 'settings.json');
  const settingsStore = createSettingsStore({ filePath });
  return createApp({ settingsStore });
}

test('GET /api/settings returns defaults before onboarding', async () => {
  const server = makeApp().listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'GET', '/api/settings');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { assistantName: null, onboardedAt: null, projects: [] });
  } finally {
    server.close();
  }
});

test('PUT /api/settings saves the assistant name and projects', async () => {
  const server = makeApp().listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'PUT', '/api/settings', {
      assistantName: 'Djinn',
      projects: ['D:\\Projects\\demo'],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.assistantName, 'Djinn');
    assert.ok(body.onboardedAt);
    assert.deepStrictEqual(body.projects, ['D:\\Projects\\demo']);

    const after = await request(port, 'GET', '/api/settings');
    assert.strictEqual(after.body.assistantName, 'Djinn');
  } finally {
    server.close();
  }
});

test('PUT /api/settings with an empty body is a 400', async () => {
  const server = makeApp().listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'PUT', '/api/settings', {});
    assert.strictEqual(status, 400);
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('PUT /api/settings with an invalid name is a 400', async () => {
  const server = makeApp().listen(0);
  try {
    const { port } = server.address();
    const { status } = await request(port, 'PUT', '/api/settings', { assistantName: '   ' });
    assert.strictEqual(status, 400);
  } finally {
    server.close();
  }
});

test('PUT /api/settings can update projects without touching the name', async () => {
  const server = makeApp().listen(0);
  try {
    const { port } = server.address();
    await request(port, 'PUT', '/api/settings', { assistantName: 'Djinn' });
    const { status, body } = await request(port, 'PUT', '/api/settings', { projects: ['D:\\a', 'D:\\b'] });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.assistantName, 'Djinn');
    assert.deepStrictEqual(body.projects, ['D:\\a', 'D:\\b']);
  } finally {
    server.close();
  }
});
