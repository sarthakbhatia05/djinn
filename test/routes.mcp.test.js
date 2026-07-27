// test/routes.mcp.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    http.request({ host: 'localhost', port, path: urlPath, method }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
    }).on('error', reject).end();
  });
}

function makeDeps({ mcpStatus }) {
  return {
    // The app's error handler logs unexpected 5xx failures; keep any the
    // tests below provoke out of `npm test` output.
    logger: { error: () => {} },
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
    filePicker: { pickFile: async () => null },
    slashCommands: { listSlashCommands: () => [] },
    claudeUserConfig: { getClaudeUserDefaults: () => ({ model: null, permissionMode: null }) },
    mcpStatus,
  };
}

test('GET /api/mcp/status returns servers for the given cwd', async () => {
  let receivedCwd;
  const deps = makeDeps({
    mcpStatus: {
      listServers: async (cwd) => {
        receivedCwd = cwd;
        return { servers: [{ name: 'my-server', target: 'cmd', status: 'connected', statusText: 'Connected' }] };
      },
    },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/mcp/status?cwd=' + encodeURIComponent('D:\\Projects\\demo'));
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { servers: [{ name: 'my-server', target: 'cmd', status: 'connected', statusText: 'Connected' }] });
  assert.strictEqual(receivedCwd, 'D:\\Projects\\demo');
  server.close();
});

test('GET /api/mcp/status returns 400 when cwd is missing', async () => {
  const deps = makeDeps({ mcpStatus: { listServers: async () => ({ servers: [] }) } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/mcp/status');
  assert.strictEqual(status, 400);
  assert.deepStrictEqual(body, { error: 'cwd is required' });
  server.close();
});

test('GET /api/mcp/status returns 502 when the CLI call fails', async () => {
  const deps = makeDeps({
    mcpStatus: { listServers: async () => { throw new Error('claude mcp list exited with code 1: boom'); } },
  });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/mcp/status?cwd=' + encodeURIComponent('D:\\demo'));
  assert.strictEqual(status, 502);
  assert.deepStrictEqual(body, { error: 'claude mcp list exited with code 1: boom' });
  server.close();
});
