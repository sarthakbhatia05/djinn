// test/routes.memory.test.js
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

function makeDeps(memoryStore) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore,
    folderPicker: { pickFolder: async () => null },
  };
}

test('GET then PUT /api/memory/common round-trips', async () => {
  let stored = { text: '' };
  const memoryStore = {
    getCommon: () => stored,
    setCommon: (text) => { stored = { text }; return stored; },
    getProject: () => ({ text: '' }),
    setProject: () => ({ text: '' }),
  };
  const server = createApp(makeDeps(memoryStore)).listen(0);
  const { port } = server.address();
  await request(port, 'PUT', '/api/memory/common', { text: 'shared notes' });
  const { body } = await request(port, 'GET', '/api/memory/common');
  assert.deepStrictEqual(body, { text: 'shared notes' });
  server.close();
});

test('GET /api/memory/project requires a path query param', async () => {
  const memoryStore = { getCommon: () => ({ text: '' }), setCommon: () => ({}), getProject: () => ({ text: '' }), setProject: () => ({}) };
  const server = createApp(makeDeps(memoryStore)).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'GET', '/api/memory/project');
  assert.strictEqual(status, 400);
  server.close();
});

test('PUT then GET /api/memory/project round-trips for a given path', async () => {
  const perProject = new Map();
  const memoryStore = {
    getCommon: () => ({ text: '' }),
    setCommon: () => ({}),
    getProject: (p) => perProject.get(p) || { text: '' },
    setProject: (p, text) => { const v = { text }; perProject.set(p, v); return v; },
  };
  const server = createApp(makeDeps(memoryStore)).listen(0);
  const { port } = server.address();
  await request(port, 'PUT', '/api/memory/project', { path: 'D:/demo', text: 'per-project notes' });
  const { body } = await request(port, 'GET', '/api/memory/project?path=D:/demo');
  assert.deepStrictEqual(body, { text: 'per-project notes' });
  server.close();
});

test('GET /api/memory/common returns JSON (not HTML) when the store throws', async () => {
  const memoryStore = {
    getCommon: () => { throw new Error('disk read failed'); },
    setCommon: () => ({}),
    getProject: () => ({ text: '' }),
    setProject: () => ({}),
  };
  const server = createApp(makeDeps(memoryStore)).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/memory/common');
  assert.strictEqual(status, 500);
  assert.ok(body && body.error);
  server.close();
});
