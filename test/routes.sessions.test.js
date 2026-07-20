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
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', pathResolved: true, title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [{ projectPath: 'D:/demo', projectFolder: 'D--demo', sessionCount: 1, lastActivity: '2026-07-15T00:00:00.000Z' }],
      readMessages: (id) => (id === 's1' ? [{ role: 'user', text: 'hi', timestamp: null }] : null),
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
    settingsStore: {
      get: () => ({ assistantName: 'Djinn', onboardedAt: null, projects: ['D:/demo'] }),
      addProject: () => {},
    },
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

test('POST /api/sessions passes model and permissionMode through to claudeCli.startSession', async () => {
  const calls = [];
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async (cwd, message, options) => { calls.push({ cwd, message, options }); return { session_id: 'new-1', result: 'ok' }; },
      sendMessage: async () => ({}),
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go', model: 'claude-opus-4', permissionMode: 'plan' });
  assert.deepStrictEqual(calls[0].options, { model: 'claude-opus-4', permissionMode: 'plan' });
  server.close();
});

test('POST /api/sessions without model/permissionMode passes them through as undefined', async () => {
  const calls = [];
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async (cwd, message, options) => { calls.push({ cwd, message, options }); return { session_id: 'new-1', result: 'ok' }; },
      sendMessage: async () => ({}),
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.deepStrictEqual(calls[0].options, { model: undefined, permissionMode: undefined });
  server.close();
});

test('POST /api/sessions/:id/message passes model and permissionMode through to claudeCli.sendMessage', async () => {
  const calls = [];
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({}),
      sendMessage: async (sessionId, cwd, message, options) => { calls.push({ sessionId, cwd, message, options }); return { session_id: 's1', result: 'ok' }; },
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  await request(port, 'POST', '/api/sessions/s1/message', { message: 'go', model: 'claude-sonnet-4', permissionMode: 'acceptEdits' });
  assert.deepStrictEqual(calls[0].options, { model: 'claude-sonnet-4', permissionMode: 'acceptEdits' });
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

test('GET /api/sessions/:id/messages returns the parsed conversation', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/sessions/s1/messages');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { messages: [{ role: 'user', text: 'hi', timestamp: null }] });
  server.close();
});

test('GET /api/sessions/:id/messages 404s for an unknown session', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'GET', '/api/sessions/unknown/messages');
  assert.strictEqual(status, 404);
  server.close();
});

test('POST /api/sessions/:id/message 409s when the project path never resolved', async () => {
  const deps = makeDeps({
    sessionStore: {
      listSessions: () => [{ id: 's1', projectPath: 'D--demo', pathResolved: false }],
      listProjects: () => [],
      readMessages: () => null,
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions/s1/message', { message: 'go' });
  assert.strictEqual(status, 409);
  assert.ok(body.error);
  server.close();
});

test('GET /api/sessions/active-count returns activeCount from claudeCli', async () => {
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({}),
      sendMessage: async () => ({}),
      getActiveCount: () => 3,
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/sessions/active-count');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { activeCount: 3 });
  server.close();
});

test('GET /api/sessions still returns a plain array (response shape regression guard)', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/sessions');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body), 'expected GET /api/sessions to return an array');
  server.close();
});

test('GET /api/sessions hides sessions whose project is not tracked', async () => {
  const deps = makeDeps({
    sessionStore: {
      listSessions: () => [
        { id: 's1', projectPath: 'D:\\Demo', pathResolved: true },
        { id: 's2', projectPath: 'D:/untracked', pathResolved: true },
      ],
      listProjects: () => [],
      readMessages: () => null,
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { body } = await request(port, 'GET', '/api/sessions');
  assert.deepStrictEqual(body.map((s) => s.id), ['s1']);
  server.close();
});

test('GET /api/sessions with an empty allowlist returns an empty list', async () => {
  const deps = makeDeps({
    settingsStore: { get: () => ({ assistantName: null, onboardedAt: null, projects: [] }), addProject: () => {} },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { body } = await request(port, 'GET', '/api/sessions');
  assert.deepStrictEqual(body, []);
  server.close();
});

test('POST /api/sessions auto-adds the cwd to tracked projects', async () => {
  const added = [];
  const deps = makeDeps({
    settingsStore: { get: () => ({ assistantName: 'Djinn', onboardedAt: null, projects: [] }), addProject: (p) => added.push(p) },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  await request(port, 'POST', '/api/sessions', { cwd: 'D:\\fresh', message: 'go' });
  assert.deepStrictEqual(added, ['D:\\fresh']);
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

test('GET /api/projects returns JSON (not HTML) when the store throws', async () => {
  const deps = makeDeps({
    sessionStore: { listSessions: () => [], listProjects: () => { throw new Error('boom'); }, readMessages: () => null },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/projects');
  assert.strictEqual(status, 500);
  assert.ok(body && body.error);
  server.close();
});

test('GET /api/sessions returns JSON (not HTML) when sessionStore throws', async () => {
  const deps = makeDeps({
    sessionStore: { listSessions: () => { throw new Error('boom'); }, listProjects: () => [], readMessages: () => null },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/sessions');
  assert.strictEqual(status, 500);
  assert.ok(body && body.error);
  server.close();
});

test('POST /api/sessions returns JSON (not HTML), no longer 502, when claudeCli.startSession rejects', async () => {
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async () => { throw new Error('claude exited with code 1: boom'); },
      sendMessage: async () => ({}),
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.strictEqual(status, 500);
  assert.ok(body && body.error);
  // The raw claude/CLI error text must not leak to the client for an
  // unexpected 5xx failure.
  assert.notStrictEqual(body.error, 'claude exited with code 1: boom');
  server.close();
});

test('POST /api/sessions/:id/message returns JSON (not HTML) when claudeCli.sendMessage rejects', async () => {
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({}),
      sendMessage: async () => { throw new Error('claude exited with code 1: boom'); },
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions/s1/message', { message: 'go' });
  assert.strictEqual(status, 500);
  assert.ok(body && body.error);
  server.close();
});

test('POST /api/sessions/:id/cancel cancels a running session', async () => {
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({}),
      sendMessage: async () => ({}),
      cancel: (id) => id === 's1',
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions/s1/cancel');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { cancelled: true });
  server.close();
});

test('POST /api/sessions/:id/cancel 404s when nothing is running under that id', async () => {
  const deps = makeDeps({
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({}),
      sendMessage: async () => ({}),
      cancel: () => false,
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions/unknown/cancel');
  assert.strictEqual(status, 404);
  assert.deepStrictEqual(body, { error: 'session not running' });
  server.close();
});
