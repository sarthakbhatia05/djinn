// test/routes.sessions.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

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

function makeDeps(overrides = {}) {
  return {
    sessionStore: {
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [{ projectPath: 'D:/demo', projectFolder: 'D--demo', sessionCount: 1, lastActivity: '2026-07-15T00:00:00.000Z' }],
    },
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({ session_id: 'new-1', result: 'ok' }),
      sendMessage: async () => ({ session_id: 's1', result: 'ok' }),
    },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
    ...overrides,
  };
}

test('GET /api/sessions merges isRunning from claudeCli', async () => {
  const deps = makeDeps({ claudeCli: { isRunning: () => true, startSession: async () => ({}), sendMessage: async () => ({}) } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/sessions');
  assert.strictEqual(status, 200);
  assert.strictEqual(body[0].id, 's1');
  assert.strictEqual(body[0].isRunning, true);
  server.close();
});

test('POST /api/sessions requires cwd and message', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions', {});
  assert.strictEqual(status, 400);
  assert.ok(body.error);
  server.close();
});

test('POST /api/sessions starts a session and records the recent directory', async () => {
  const added = [];
  const deps = makeDeps({ recentDirectories: { add: (d) => added.push(d), list: () => [] } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.strictEqual(status, 201);
  assert.strictEqual(body.session_id, 'new-1');
  assert.deepStrictEqual(added, ['D:\\demo']);
  server.close();
});

test('POST /api/sessions/:id/message 404s for an unknown session', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'POST', '/api/sessions/unknown/message', { message: 'go' });
  assert.strictEqual(status, 404);
  server.close();
});

test('POST /api/sessions/:id/message resumes a known session', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions/s1/message', { message: 'go' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.session_id, 's1');
  server.close();
});

test('GET /api/projects returns the project list', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/projects');
  assert.strictEqual(status, 200);
  assert.strictEqual(body[0].projectFolder, 'D--demo');
  server.close();
});
