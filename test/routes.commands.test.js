// test/routes.commands.test.js
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

function makeDeps({ slashCommands }) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
    filePicker: { pickFile: async () => null },
    slashCommands,
  };
}

test('GET /api/commands requires a path query parameter', async () => {
  const deps = makeDeps({ slashCommands: { listSlashCommands: () => [] } });
  const server = createApp(deps).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'GET', '/api/commands');
    assert.strictEqual(status, 400);
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('GET /api/commands?path=... returns { commands } from slashCommands.listSlashCommands', async () => {
  const calls = [];
  const deps = makeDeps({
    slashCommands: {
      listSlashCommands: (projectPath) => {
        calls.push(projectPath);
        return [{ name: 'clear', description: 'Clear history', source: 'builtin' }];
      },
    },
  });
  const server = createApp(deps).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'GET', '/api/commands?path=D%3A%5Cdemo');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { commands: [{ name: 'clear', description: 'Clear history', source: 'builtin' }] });
    assert.deepStrictEqual(calls, ['D:\\demo']);
  } finally {
    server.close();
  }
});
