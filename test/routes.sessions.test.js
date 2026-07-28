// test/routes.sessions.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    // A string body is sent verbatim, so a test can post deliberately
    // malformed JSON and exercise the 4xx path through the error handler.
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
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

// Records what the app's error handler logs. Also keeps the negative-path
// tests below from printing real stack traces during `npm test` — the default
// logger is console, so without this every 500 test would spray output.
function makeLogger() {
  const errors = [];
  return { errors, error: (...args) => errors.push(args) };
}

function makeDeps(overrides = {}) {
  return {
    logger: makeLogger(),
    sessionStore: {
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', pathResolved: true, title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [{ projectPath: 'D:/demo', projectFolder: 'D--demo', sessionCount: 1, lastActivity: '2026-07-15T00:00:00.000Z' }],
      readMessages: (id) => (id === 's1' ? [{ role: 'user', text: 'hi', timestamp: null }] : null),
      getPendingToolUseSince: () => null,
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
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'GET', '/api/sessions');
    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].id, 's1');
    assert.strictEqual(body[0].isRunning, true);
    assert.strictEqual(body[0].needsInput, false, 'a running session with no reported pending tool use is not needsInput');
  } finally {
    server.close();
  }
});

// needsInput is only ever computed for a session claudeCli reports as running
// (an idle session cannot be "stuck"), and only trips once the transcript's
// unresolved tool_use has sat long enough that it reads as stuck rather than
// merely a normal in-flight tool call — see NEEDS_INPUT_STALE_MS in
// server/routes/sessions.js.

test('GET /api/sessions reports needsInput once a pending tool_use is older than the stale threshold', async () => {
  const oldTimestamp = new Date(Date.now() - 60000).toISOString(); // well past 25s
  const deps = makeDeps({
    claudeCli: { isRunning: () => true, startSession: async () => ({}), sendMessage: async () => ({}) },
    sessionStore: {
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', pathResolved: true, title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [],
      readMessages: () => null,
      getPendingToolUseSince: () => oldTimestamp,
    },
  });
  const server = createApp(deps).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'GET', '/api/sessions');
    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].isRunning, true, 'needsInput is additional to isRunning, not a replacement for it');
    assert.strictEqual(body[0].needsInput, true);
  } finally {
    server.close();
  }
});

test('GET /api/sessions does not report needsInput for a tool_use pending less than the stale threshold', async () => {
  const recentTimestamp = new Date(Date.now() - 2000).toISOString(); // 2s — an ordinary tool call
  const deps = makeDeps({
    claudeCli: { isRunning: () => true, startSession: async () => ({}), sendMessage: async () => ({}) },
    sessionStore: {
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', pathResolved: true, title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [],
      readMessages: () => null,
      getPendingToolUseSince: () => recentTimestamp,
    },
  });
  const server = createApp(deps).listen(0);
  try {
    const { port } = server.address();
    const { body } = await request(port, 'GET', '/api/sessions');
    assert.strictEqual(body[0].needsInput, false);
  } finally {
    server.close();
  }
});

test('GET /api/sessions never checks for a pending tool_use on an idle session', async () => {
  let called = false;
  const deps = makeDeps({
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    sessionStore: {
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', pathResolved: true, title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [],
      readMessages: () => null,
      getPendingToolUseSince: () => { called = true; return new Date().toISOString(); },
    },
  });
  const server = createApp(deps).listen(0);
  try {
    const { port } = server.address();
    const { body } = await request(port, 'GET', '/api/sessions');
    assert.strictEqual(body[0].needsInput, false);
    assert.strictEqual(called, false, 'an idle session must not pay for a transcript tail-read it cannot need');
  } finally {
    server.close();
  }
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

test('POST /api/sessions/:id/message surfaces claudeCli\'s 409 with the message intact and logs nothing', async () => {
  const logger = makeLogger();
  const deps = makeDeps({
    logger,
    claudeCli: {
      isRunning: () => true,
      startSession: async () => ({}),
      sendMessage: async () => {
        throw Object.assign(new Error('a run is already in progress for this session'), { status: 409 });
      },
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions/s1/message', { message: 'go' });
  // No try/catch in the route: asyncHandler forwards the rejection and the
  // error middleware passes err.message through because the status is < 500.
  assert.strictEqual(status, 409);
  assert.strictEqual(body.error, 'a run is already in progress for this session');
  assert.deepStrictEqual(logger.errors, [], 'a deliberate 4xx must stay out of the error log');
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

test('an unexpected 5xx is logged server-side with the full error, stack included', async () => {
  const logger = makeLogger();
  const boom = new Error('spawn claude ENOENT');
  const deps = makeDeps({
    logger,
    claudeCli: {
      isRunning: () => false,
      startSession: async () => { throw boom; },
      sendMessage: async () => ({}),
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.strictEqual(status, 500);
  // Client-facing body is unchanged: still the generic message, no leak.
  assert.deepStrictEqual(body, { error: 'Internal server error' });
  assert.strictEqual(logger.errors.length, 1);
  const [label, logged] = logger.errors[0];
  assert.match(label, /POST \/api\/sessions/);
  // The Error object itself must be handed to the logger — not err.message —
  // or the stack (the whole point) is thrown away.
  assert.strictEqual(logged, boom);
  assert.ok(logged.stack);
  server.close();
});

test('a synchronous store failure is logged too', async () => {
  const logger = makeLogger();
  const deps = makeDeps({
    logger,
    sessionStore: { listSessions: () => { throw new Error('boom'); }, listProjects: () => [], readMessages: () => null },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/sessions');
  assert.strictEqual(status, 500);
  assert.deepStrictEqual(body, { error: 'Internal server error' });
  assert.strictEqual(logger.errors.length, 1);
  assert.strictEqual(logger.errors[0][1].message, 'boom');
  server.close();
});

test('a deliberate 4xx sent by a route logs nothing', async () => {
  const logger = makeLogger();
  const server = createApp(makeDeps({ logger })).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions', {});
  assert.strictEqual(status, 400);
  assert.ok(body.error);
  assert.deepStrictEqual(logger.errors, []);
  server.close();
});

test('a 4xx that travels through the error handler logs nothing and still passes its message through', async () => {
  const logger = makeLogger();
  const server = createApp(makeDeps({ logger })).listen(0);
  const { port } = server.address();
  // Malformed JSON: express.json() rejects with a SyntaxError carrying
  // status 400, which reaches the error handler rather than a route.
  const { status, body } = await request(port, 'POST', '/api/sessions', '{ not json');
  assert.strictEqual(status, 400);
  // Unchanged behavior: below 500 the real message is passed through.
  assert.ok(body.error && body.error !== 'Internal server error');
  assert.deepStrictEqual(logger.errors, []);
  server.close();
});

test('the logger defaults to console when no logger dependency is injected', async () => {
  const deps = makeDeps({
    logger: undefined,
    sessionStore: { listSessions: () => { throw new Error('boom'); }, listProjects: () => [], readMessages: () => null },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    const { status } = await request(port, 'GET', '/api/sessions');
    assert.strictEqual(status, 500);
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][1].message, 'boom');
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
