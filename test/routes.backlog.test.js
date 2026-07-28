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
    // The app's error handler logs unexpected 5xx failures; the store-throws
    // test below deliberately provokes one, so swallow it here rather than
    // printing a stack trace on every `npm test`.
    logger: { error: () => {} },
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
  try {
    const { port } = server.address();
    const { status } = await request(port, 'POST', '/api/backlog', {});
    assert.strictEqual(status, 400);
  } finally {
    server.close();
  }
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
  try {
    const { port } = server.address();
    const created = await request(port, 'POST', '/api/backlog', { title: 'Fix bug', repoPath: 'D:/demo' });
    assert.strictEqual(created.status, 201);
    const listed = await request(port, 'GET', '/api/backlog');
    assert.strictEqual(listed.body.length, 1);
  } finally {
    server.close();
  }
});

test('PATCH /api/backlog/:id 404s for an unknown id', async () => {
  const backlogStore = { list: () => [], add: () => {}, update: () => null };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  try {
    const { port } = server.address();
    const { status } = await request(port, 'PATCH', '/api/backlog/missing', { done: true });
    assert.strictEqual(status, 404);
  } finally {
    server.close();
  }
});

test('DELETE /api/backlog/:id returns 204 when the item existed', async () => {
  const backlogStore = { list: () => [], add: () => {}, remove: () => true };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  try {
    const { port } = server.address();
    const { status } = await request(port, 'DELETE', '/api/backlog/1');
    assert.strictEqual(status, 204);
  } finally {
    server.close();
  }
});

test('DELETE /api/backlog/:id 404s for an unknown id, matching PATCH', async () => {
  const backlogStore = { list: () => [], add: () => {}, remove: () => false };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'DELETE', '/api/backlog/missing');
    assert.strictEqual(status, 404);
    assert.deepStrictEqual(body, { error: 'not found' });
  } finally {
    server.close();
  }
});

test('PATCH /api/backlog/:id ignores id and createdAt from the request body (mass-assignment guard)', async () => {
  let stored = {
    id: '1',
    title: 'old title',
    repoPath: 'D:/demo',
    priority: 'medium',
    done: false,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
  const backlogStore = {
    list: () => [stored],
    add: () => {},
    update: (id, changes) => {
      // The route must never forward id/createdAt to the store, regardless
      // of what the client sent.
      assert.strictEqual(Object.prototype.hasOwnProperty.call(changes, 'id'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(changes, 'createdAt'), false);
      if (id !== stored.id) return null;
      stored = { ...stored, ...changes };
      return stored;
    },
  };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'PATCH', '/api/backlog/1', {
      id: 'hacked-id',
      createdAt: '1999-01-01T00:00:00.000Z',
      title: 'new title',
      done: true,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, '1');
    assert.strictEqual(body.createdAt, '2020-01-01T00:00:00.000Z');
    assert.strictEqual(body.title, 'new title');
    assert.strictEqual(body.done, true);
  } finally {
    server.close();
  }
});

test('PATCH /api/backlog/:id returns JSON (not HTML) when the store throws', async () => {
  const backlogStore = { list: () => [], add: () => {}, update: () => { throw new Error('disk full'); } };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'PATCH', '/api/backlog/1', { done: true });
    assert.strictEqual(status, 500);
    assert.ok(body && body.error);
  } finally {
    server.close();
  }
});
