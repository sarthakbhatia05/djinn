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
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', pathResolved: true, title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [],
      readMessages: () => null,
    },
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({ session_id: 'new-1', result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }),
      sendMessage: async () => ({ session_id: 's1', result: 'ok', total_cost_usd: 0.02, usage: { input_tokens: 20, output_tokens: 10 } }),
    },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
    settingsStore: {
      get: () => ({ assistantName: 'Djinn', onboardedAt: null, projects: ['D:/demo'] }),
      addProject: () => {},
    },
    usageStore: {
      getAll: () => ({ allTime: { costUsd: 0, inputTokens: 0, outputTokens: 0, callCount: 0 }, sessions: {} }),
      getSession: () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, callCount: 0 }),
      recordUsage: () => {},
    },
    ...overrides,
  };
}

test('GET /api/usage returns the usageStore data as JSON', async () => {
  const stored = {
    allTime: { costUsd: 1.23, inputTokens: 100, outputTokens: 50, callCount: 4 },
    sessions: { s1: { costUsd: 1.23, inputTokens: 100, outputTokens: 50, callCount: 4 } },
  };
  const deps = makeDeps({ usageStore: { getAll: () => stored, getSession: () => stored.sessions.s1, recordUsage: () => {} } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/usage');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, stored);
  server.close();
});

test('POST /api/sessions records usage from the claude CLI result', async () => {
  const recorded = [];
  const deps = makeDeps({
    usageStore: {
      getAll: () => ({}),
      getSession: () => ({}),
      recordUsage: (sessionId, fields) => recorded.push({ sessionId, fields }),
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].sessionId, 'new-1');
  assert.strictEqual(recorded[0].fields.costUsd, 0.01);
  assert.strictEqual(recorded[0].fields.inputTokens, 10);
  assert.strictEqual(recorded[0].fields.outputTokens, 5);
  server.close();
});

test('POST /api/sessions/:id/message records usage from the claude CLI result', async () => {
  const recorded = [];
  const deps = makeDeps({
    usageStore: {
      getAll: () => ({}),
      getSession: () => ({}),
      recordUsage: (sessionId, fields) => recorded.push({ sessionId, fields }),
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  await request(port, 'POST', '/api/sessions/s1/message', { message: 'go' });
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].sessionId, 's1');
  assert.strictEqual(recorded[0].fields.costUsd, 0.02);
  server.close();
});

test('POST /api/sessions does not throw and skips recording when the result has no session_id', async () => {
  const recorded = [];
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({ result: 'ok' }), // no session_id, no usage
      sendMessage: async () => ({}),
    },
    usageStore: {
      getAll: () => ({}),
      getSession: () => ({}),
      recordUsage: (sessionId, fields) => recorded.push({ sessionId, fields }),
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.strictEqual(status, 201);
  assert.strictEqual(recorded.length, 0);
  server.close();
});

test('POST /api/sessions works fine without a usageStore dependency injected', async () => {
  const deps = makeDeps();
  delete deps.usageStore;
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.strictEqual(status, 201);
  server.close();
});
