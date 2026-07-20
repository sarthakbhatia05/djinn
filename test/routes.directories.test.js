// test/routes.directories.test.js
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

function makeDeps({ recentDirectories, folderPicker, filePicker }) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories,
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker,
    filePicker,
  };
}

test('GET /api/directories/recent returns the list', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => ['D:\\a'], add: () => {} }, folderPicker: { pickFolder: async () => null } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/directories/recent');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, ['D:\\a']);
  server.close();
});

test('POST /api/directories/browse returns the picked path', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => [], add: () => {} }, folderPicker: { pickFolder: async () => 'D:\\chosen' }, filePicker: { pickFile: async () => null } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/directories/browse');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { path: 'D:\\chosen' });
  server.close();
});

test('POST /api/directories/browse-file returns the picked file path', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => [], add: () => {} }, folderPicker: { pickFolder: async () => null }, filePicker: { pickFile: async () => 'D:\\chosen\\file.txt' } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/directories/browse-file');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { path: 'D:\\chosen\\file.txt' });
  server.close();
});

test('POST /api/directories/browse-file returns null path when cancelled', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => [], add: () => {} }, folderPicker: { pickFolder: async () => null }, filePicker: { pickFile: async () => null } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/directories/browse-file');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { path: null });
  server.close();
});

test('POST /api/directories/browse-file returns 500 when the picker rejects', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => [], add: () => {} }, folderPicker: { pickFolder: async () => null }, filePicker: { pickFile: async () => { throw new Error('picker blew up'); } } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/directories/browse-file');
  assert.strictEqual(status, 500);
  assert.ok(body.error);
  server.close();
});

test('GET /api/directories/recent returns JSON (not HTML) when recentDirectories.list throws', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => { throw new Error('boom'); }, add: () => {} }, folderPicker: { pickFolder: async () => null } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/directories/recent');
  assert.strictEqual(status, 500);
  assert.ok(body && body.error);
  server.close();
});

test('POST /api/directories/browse returns JSON (not HTML) when the picker rejects', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => [], add: () => {} }, folderPicker: { pickFolder: async () => { throw new Error('picker blew up'); } } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/directories/browse');
  assert.strictEqual(status, 500);
  assert.ok(body && body.error);
  server.close();
});
