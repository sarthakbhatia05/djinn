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

function makeDeps(backlogStore) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore,
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
  };
}

test('POST /api/backlog requires title and repoPath', async () => {
  const server = createApp(makeDeps({ list: () => [], add: () => {} })).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'POST', '/api/backlog', {});
  assert.strictEqual(status, 400);
  server.close();
});

test('POST /api/backlog then GET /api/backlog round-trips', async () => {
  const items = [];
  const backlogStore = {
    list: () => items,
    add: ({ title, repoPath, priority }) => {
      const item = { id: '1', title, repoPath, priority: priority || 'medium', done: false };
      items.push(item);
      return item;
    },
  };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  const { port } = server.address();
  const created = await request(port, 'POST', '/api/backlog', { title: 'Fix bug', repoPath: 'D:/demo' });
  assert.strictEqual(created.status, 201);
  const listed = await request(port, 'GET', '/api/backlog');
  assert.strictEqual(listed.body.length, 1);
  server.close();
});

test('PATCH /api/backlog/:id 404s for an unknown id', async () => {
  const backlogStore = { list: () => [], add: () => {}, update: () => null };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'PATCH', '/api/backlog/missing', { done: true });
  assert.strictEqual(status, 404);
  server.close();
});

test('DELETE /api/backlog/:id returns 204', async () => {
  const backlogStore = { list: () => [], add: () => {}, remove: () => {} };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'DELETE', '/api/backlog/1');
  assert.strictEqual(status, 204);
  server.close();
});
